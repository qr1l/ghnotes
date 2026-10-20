import {
  createBlob,
  createCommit,
  createTree,
  getBranchHead,
  getFileRaw,
  getTreeRecursive,
  updateRef,
  type GitHubTree
} from '../github/api'
import { db, type NoteRecord } from './db'
import type { Settings } from '../settings'

// Синхронизация конспектов с GitHub.
// Правила из раздела «Правила синхронизации» документа этапа 2.

export type SyncStatus = 'synced' | 'pending' | 'syncing' | 'offline' | 'error' | 'no-connection'

export interface SyncResult {
  status: SyncStatus
  message?: string
  conflict?: boolean
}

function encodePath(path: string): string {
  return path
    .split('/')
    .filter((segment) => segment.length > 0)
    .map((segment) => encodeURIComponent(segment))
    .join('/')
}

function isOnline(): boolean {
  return typeof navigator !== 'undefined' && navigator.onLine
}

// Получить список конспектов из GitHub (getTreeRecursive).
// Возвращает темы и конспекты (папки с note.json).
export async function fetchRemoteList(settings: Settings): Promise<{
  topics: string[]
  notes: { topic: string; title: string; sha: string }[]
  truncated: boolean
}> {
  const { token, owner, repo, branch } = settings
  const headSha = await getBranchHead(token, owner, repo, branch)
  const tree = await getTreeRecursive(token, owner, repo, headSha)

  const topics = new Set<string>()
  const notes: { topic: string; title: string; sha: string }[] = []

  for (const node of tree.tree) {
    if (node.type !== 'blob' || !node.path.endsWith('/note.json')) continue
    const segments = node.path.split('/')
    if (segments.length < 2) continue
    const topic = segments[0]
    const title = segments[1]
    topics.add(topic)
    notes.push({ topic, title, sha: node.sha })
  }

  return { topics: Array.from(topics), notes, truncated: tree.truncated ?? false }
}

// Кэшировать список из GitHub в Dexie.
export async function cacheRemoteList(
  notes: { topic: string; title: string; sha: string }[]
): Promise<void> {
  await db.remoteNotes.clear()
  for (const note of notes) {
    await db.remoteNotes.add({
      path: `${note.topic}/${note.title}`,
      topic: note.topic,
      title: note.title,
      sha: note.sha
    })
  }
}

// Скачать конспект с GitHub (note.json + картинки).
export async function pullNote(
  settings: Settings,
  topic: string,
  title: string
): Promise<{ data: string; sha: string } | null> {
  const { token, owner, repo, branch } = settings
  const path = `${topic}/${title}/note.json`
  const blob = await getFileRaw(token, owner, repo, branch, path)
  const text = await blob.text()

  // Скачиваем недостающие картинки
  try {
    const parsed = JSON.parse(text) as { snapshot?: { store?: Record<string, { type: string; props?: { type?: string; src?: string } }> } }
    const store = parsed?.snapshot?.store
    if (store) {
      for (const record of Object.values(store)) {
        if (record?.type === 'asset' && record.props?.type === 'image') {
          const src = record.props.src
          if (typeof src === 'string' && src.startsWith('asset:')) {
            const name = src.slice('asset:'.length)
            const existing = await db.assets.get(name)
            if (!existing) {
              const assetBlob = await getFileRaw(token, owner, repo, branch, `${topic}/${title}/assets/${name}`)
              await db.assets.put({ name, blob: assetBlob, pushed: true })
            }
          }
        }
      }
    }
  } catch (error) {
    console.error('[sync] не удалось скачать картинки', error)
  }

  return { data: text, sha: '' }
}

// Отправить конспект на GitHub (note.json + картинки с pushed: false).
// Одним коммитом через Git Data API.
export async function pushNote(
  settings: Settings,
  note: NoteRecord,
  onProgress?: (status: SyncStatus) => void): Promise<SyncResult> {
  if (!isOnline()) {
    return { status: 'offline', message: 'Нет подключения к интернету' }
  }
  onProgress?.('syncing')

  const { token, owner, repo, branch } = settings
  const path = `${note.topic}/${note.title}`
  const now = new Date().toISOString()

  // 1. Получить ref ветки
  let headSha: string
  try {
    headSha = await getBranchHead(token, owner, repo, branch)
  } catch (error) {
    console.error('[sync] не удалось получить head ветки', error)
    return { status: 'error', message: error instanceof Error ? error.message : 'Ошибка GitHub' }
  }

  // 2. Получить текущее дерево
  let tree: GitHubTree
  try {
    tree = await getTreeRecursive(token, owner, repo, headSha)
  } catch (error) {
    console.error('[sync] не удалось получить дерево', error)
    return { status: 'error', message: error instanceof Error ? error.message : 'Ошибка GitHub' }
  }

  // 3. Подготовить blob'ы
  const treeEntries: { path: string; mode: string; type: 'blob' | 'tree'; sha: string | null }[] = []

  // note.json
  const noteJson = JSON.stringify(note.data, null, 2)
  const noteBlob = await createBlob(token, owner, repo, noteJson, 'utf-8')
  treeEntries.push({ path: `${path}/note.json`, mode: '100644', type: 'blob', sha: noteBlob.sha })

  // Картинки с pushed: false, которые упоминаются в конспекте
  const assetNames = new Set<string>()
  try {
    const snapshot = note.data.snapshot as { store?: Record<string, { type: string; props?: { type?: string; src?: string } }> }
    for (const record of Object.values(snapshot?.store ?? {})) {
      if (record?.type === 'asset' && record.props?.type === 'image') {
        const src = record.props.src
        if (typeof src === 'string' && src.startsWith('asset:')) {
          const name = src.slice('asset:'.length)
          assetNames.add(name)
        }
      }
    }
  } catch {
    // Игнорируем ошибки разбора снимка
  }

  for (const name of assetNames) {
    const asset = await db.assets.get(name)
    if (asset && !asset.pushed) {
      const base64 = await blobToBase64(asset.blob)
      const assetBlob = await createBlob(token, owner, repo, base64, 'base64')
      treeEntries.push({ path: `${path}/assets/${name}`, mode: '100644', type: 'blob', sha: assetBlob.sha })
    }
  }

  // 4. Создать tree
  const baseTree = tree.tree.map((entry) => ({
    path: entry.path,
    mode: entry.mode,
    type: entry.type,
    sha: entry.sha
  }))

  // Удаляем старые записи для этого конспекта (note.json и assets)
  const filteredBaseTree = baseTree.filter(
    (entry) => !entry.path.startsWith(`${path}/`)
  )

  const newTree = await createTree(token, owner, repo, headSha, [...filteredBaseTree, ...treeEntries])

  // 5. Создать commit
  const commit = await createCommit(
    token,
    owner,
    repo,
    `Update ${path}`,
    newTree.sha,
    [headSha]
  )

  // 6. Обновить ref (с одним повтором при отклонении)
  try {
    await updateRef(token, owner, repo, branch, commit.sha, false)
  } catch (error) {
    // Ветка ушла вперёд — повторяем один раз
    try {
      const newHeadSha = await getBranchHead(token, owner, repo, branch)
      const newHeadTree = await getTreeRecursive(token, owner, repo, newHeadSha)
      const retryBaseTree = newHeadTree.tree.map((entry) => ({
        path: entry.path,
        mode: entry.mode,
        type: entry.type,
        sha: entry.sha
      })).filter((entry) => !entry.path.startsWith(`${path}/`))
      const retryTree = await createTree(token, owner, repo, newHeadSha, [...retryBaseTree, ...treeEntries])
      const retryCommit = await createCommit(token, owner, repo, `Update ${path}`, retryTree.sha, [newHeadSha])
      await updateRef(token, owner, repo, branch, retryCommit.sha, false)
    } catch (retryError) {
      console.error('[sync] не удалось обновить ref', retryError)
      return { status: 'error', message: 'Конфликт версий' }
    }
  }

  // 7. После успеха обновить локальные данные
  await db.notes.update(note.path, {
    baseSha: commit.sha,
    dirty: false,
    updatedAt: now
  })
  for (const name of assetNames) {
    await db.assets.update(name, { pushed: true })
  }

  onProgress?.('synced')
  return { status: 'synced' }
}

// Удалить конспект на GitHub (отдельный коммит с sha: null).
export async function deleteNoteRemote(
  settings: Settings,
  topic: string,
  title: string
): Promise<boolean> {
  if (!isOnline()) {
    // Отложить удаление
    await db.pendingDeletes.add({
      path: `${topic}/${title}`,
      kind: 'note',
      createdAt: new Date().toISOString()
    })
    return false
  }

  const { token, owner, repo, branch } = settings
  const path = `${topic}/${title}`

  try {
    const headSha = await getBranchHead(token, owner, repo, branch)
    const tree = await getTreeRecursive(token, owner, repo, headSha)

    // Оставляем только записи, не относящиеся к этому конспекту
    const baseTree = tree.tree
      .filter((entry) => !entry.path.startsWith(`${path}/`))
      .map((entry) => ({
        path: entry.path,
        mode: entry.mode,
        type: entry.type,
        sha: entry.sha
      }))

    // Проставляем sha: null для удалённых файлов
    const deletedEntries = tree.tree
      .filter((entry) => entry.path.startsWith(`${path}/`) && entry.type === 'blob')
      .map((entry) => ({
        path: entry.path,
        mode: entry.mode,
        type: 'blob' as const,
        sha: null
      }))

    const newTree = await createTree(token, owner, repo, headSha, [...baseTree, ...deletedEntries])
    const commit = await createCommit(token, owner, repo, `Delete ${path}`, newTree.sha, [headSha])
    await updateRef(token, owner, repo, branch, commit.sha, false)
    return true
  } catch (error) {
    console.error('[sync] не удалось удалить конспект', error)
    // Отложить удаление
    await db.pendingDeletes.add({
      path: `${topic}/${title}`,
      kind: 'note',
      createdAt: new Date().toISOString()
    })
    return false
  }
}

// Удалить тему на GitHub (все её конспекты).
export async function deleteTopicRemote(
  settings: Settings,
  topic: string,
  noteTitles: string[]
): Promise<boolean> {
  if (!isOnline()) {
    await db.pendingDeletes.add({
      path: `${topic}/`,
      kind: 'topic',
      createdAt: new Date().toISOString()
    })
    return false
  }

  const { token, owner, repo, branch } = settings

  try {
    const headSha = await getBranchHead(token, owner, repo, branch)
    const tree = await getTreeRecursive(token, owner, repo, headSha)

    const prefix = `${topic}/`
    const baseTree = tree.tree
      .filter((entry) => !entry.path.startsWith(prefix))
      .map((entry) => ({
        path: entry.path,
        mode: entry.mode,
        type: entry.type,
        sha: entry.sha
      }))

    const deletedEntries = tree.tree
      .filter((entry) => entry.path.startsWith(prefix) && entry.type === 'blob')
      .map((entry) => ({
        path: entry.path,
        mode: entry.mode,
        type: 'blob' as const,
        sha: null
      }))

    const newTree = await createTree(token, owner, repo, headSha, [...baseTree, ...deletedEntries])
    const commit = await createCommit(token, owner, repo, `Delete ${topic}`, newTree.sha, [headSha])
    await updateRef(token, owner, repo, branch, commit.sha, false)
    return true
  } catch (error) {
    console.error('[sync] не удалось удалить тему', error)
    await db.pendingDeletes.add({
      path: `${topic}/`,
      kind: 'topic',
      createdAt: new Date().toISOString()
    })
    return false
  }
}

// Выполнить отложенные удаления при появлении сети.
export async function processPendingDeletes(settings: Settings): Promise<void> {
  if (!isOnline()) return
  const pending = await db.pendingDeletes.toArray()
  for (const item of pending) {
    try {
      if (item.kind === 'note') {
        const [topic, title] = item.path.split('/')
        await deleteNoteRemote(settings, topic, title)
      } else {
        const topic = item.path.replace(/\/$/, '')
        await deleteTopicRemote(settings, topic, [])
      }
      await db.pendingDeletes.delete(item.path)
    } catch (error) {
      console.error('[sync] не удалось выполнить отложенное удаление', error)
    }
  }
}

async function blobToBase64(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer()
  const bytes = new Uint8Array(buffer)
  let binary = ''
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary)
}

// Синхронизация при открытии конспекта по правилам из документа.
export async function syncOnOpen(
  settings: Settings,
  note: NoteRecord,
  onConflict?: (copyTitle: string) => void
): Promise<{ data: string; sha: string } | null> {
  if (!settings.token || !isOnline()) return null

  const { token, owner, repo, branch } = settings
  const path = `${note.topic}/${note.title}`

  try {
    // 1. Получить текущий sha удалённого note.json
    const remote = await db.remoteNotes.get(path)
    if (!remote) return null

    // 2. Если dirty = false и удалённый sha отличается от baseSha: скачать
    if (!note.dirty && remote.sha !== note.baseSha) {
      const result = await pullNote(settings, note.topic, note.title)
      if (result) {
        await db.notes.update(note.path, {
          data: JSON.parse(result.data) as NoteRecord['data'],
          baseSha: remote.sha,
          dirty: false,
          updatedAt: new Date().toISOString()
        })
        return result
      }
    }

    // 3. Если dirty = true и удалённый sha равен baseSha: отправить
    if (note.dirty && remote.sha === note.baseSha) {
      const result = await pushNote(settings, note)
      if (result.status === 'synced') {
        const updated = await db.notes.get(note.path)
        if (updated) {
          return { data: JSON.stringify(updated.data), sha: updated.baseSha ?? remote.sha }
        }
      }
      return null
    }

    // 4. Конфликт: dirty = true и удалённый sha отличается от baseSha
    if (note.dirty && remote.sha !== note.baseSha) {
      // Скачиваем удалённую версию как основу
      const remoteResult = await pullNote(settings, note.topic, note.title)
      if (remoteResult) {
        // Сохраняем локальную версию как копию
        const now = new Date()
        const copyTitle = `${note.title} (копия ${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}-${String(now.getMinutes()).padStart(2, '0')})`
        const copyData = JSON.parse(JSON.stringify(note.data)) as NoteRecord['data']
        copyData.title = copyTitle
        await db.notes.add({
          path: `${note.topic}/${copyTitle}`,
          topic: note.topic,
          title: copyTitle,
          data: copyData,
          session: {},
          baseSha: null,
          dirty: true,
          updatedAt: now.toISOString()
        })

        // Заменяем текущую запись удалённой версией
        await db.notes.update(note.path, {
          data: JSON.parse(remoteResult.data) as NoteRecord['data'],
          baseSha: remote.sha,
          dirty: false,
          updatedAt: now.toISOString()
        })

        onConflict?.(copyTitle)
        return { ...remoteResult, sha: remote.sha }
      }
    }
  } catch (error) {
    console.error('[sync] ошибка синхронизации при открытии', error)
  }

  return null
}
