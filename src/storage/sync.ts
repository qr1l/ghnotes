import {
  createBlob,
  createCommit,
  createTree,
  getBranchHead,
  getCommit,
  getFileRaw,
  getTreeRecursive,
  GitHubApiError,
  updateRef,
  type GitHubTreeEntry
} from '../github/api'
import { db, type NoteRecord } from './db'
import { loadSettings, type Settings } from '../settings'

// Синхронизация конспектов с GitHub.
// Правила из раздела «Правила синхронизации» документа этапа 2.

export type SyncStatus = 'synced' | 'pending' | 'syncing' | 'offline' | 'error' | 'no-connection'

export interface SyncResult {
  status: SyncStatus
  message?: string
  conflict?: boolean
}

function isOnline(): boolean {
  return typeof navigator !== 'undefined' && navigator.onLine
}

function getErrorMessage(error: unknown): string {
  if (error instanceof GitHubApiError) {
    if (error.gitHubMessage) return error.gitHubMessage
    if (error.gitHubErrors) return error.gitHubErrors
    return error.message
  }
  return error instanceof Error ? error.message : 'Неизвестная ошибка'
}

// === Единая очередь записи в GitHub (mutex на цепочке промисов) ===
// Все операции записи (pushNote, deleteNoteRemote, deleteTopicRemote, processPendingDeletes)
// выполняются строго по одной.

let writeQueue: Promise<unknown> = Promise.resolve()

function enqueueWrite<T>(fn: () => Promise<T>): Promise<T> {
  const result = writeQueue.then(fn, fn)
  writeQueue = result.then(
    () => undefined,
    () => undefined
  )
  return result
}

// === Склейка пушей: одна активная задача на заметку ===
// Если заметка уже пушится или стоит в очереди — не добавляем вторую параллельную задачу.
const pushingNotes = new Set<string>()
const pendingPushNotes = new Set<string>()

/**
 * Запросить push заметки. Используется ВСЕМИ точками запуска (таймер 10 с, visibilitychange,
 * online, закрытие заметки, кнопка «Синхронизировать»). Гарантирует, что для одной заметки
 * всегда выполняется только один push одновременно.
 */
export function requestPush(notePath: string): void {
  if (pushingNotes.has(notePath) || pendingPushNotes.has(notePath)) return
  pendingPushNotes.add(notePath)

  enqueueWrite(async () => {
    // Ждём, пока предыдущая операция записи завершится
    // (enqueueWrite уже гарантирует это через цепочку промисов)

    // После получения блокировки заново читаем локальную заметку
    const note = await db.notes.get(notePath)
    if (!note) {
      pendingPushNotes.delete(notePath)
      return
    }
    // Если dirty === false — ничего не делаем (уже синхронизировано)
    if (!note.dirty) {
      pendingPushNotes.delete(notePath)
      return
    }

    pendingPushNotes.delete(notePath)
    pushingNotes.add(notePath)
    try {
      const settings = loadSettings()
      if (!settings.token) return
      const result = await pushNoteInternal(settings, note)
      // После успешного PATCH обновляем baseSha и dirty только если заметка не менялась
      if (result.status === 'synced') {
        const current = await db.notes.get(notePath)
        if (current && current.updatedAt === note.updatedAt) {
          const { token, owner, repo, branch } = settings
          const headSha = await getBranchHead(token, owner, repo, branch)
          await db.notes.update(notePath, {
            baseSha: headSha,
            dirty: false,
            updatedAt: new Date().toISOString()
          })
        } else if (current) {
          // Заметка менялась пока шёл пуш — оставляем dirty = true, запросим повторный push
        }
        // После успешного push пробуем выполнить отложенные удаления
        await processPendingDeletes(settings)
      }
    } finally {
      pushingNotes.delete(notePath)
    }
  })
}

// Внутренняя функция push (без очереди) — используется только через requestPush
async function pushNoteInternal(
  settings: Settings,
  note: NoteRecord
): Promise<SyncResult> {
  const { token, owner, repo, branch } = settings
  const path = `${note.topic}/${note.title}`

  const noteJson = JSON.stringify(note.data, null, 2)

  const assetNames = new Set<string>()
  try {
    const snapshot = note.data.snapshot as { store?: Record<string, { type: string; props?: { type?: string; src?: string } }> }
    for (const record of Object.values(snapshot?.store ?? {})) {
      if (record?.type === 'asset' && record.props?.type === 'image') {
        const src = record.props.src
        if (typeof src === 'string' && src.startsWith('asset:')) {
          assetNames.add(src.slice('asset:'.length))
        }
      }
    }
  } catch {
    // Игнорируем ошибки разбора снимка
  }

  const blobs: { name: string; sha: string }[] = []
  try {
    const noteBlob = await createBlob(token, owner, repo, noteJson, 'utf-8')
    blobs.push({ name: `${path}/note.json`, sha: noteBlob.sha })

    for (const name of assetNames) {
      const asset = await db.assets.get(name)
      if (asset && !asset.pushed) {
        const base64 = await blobToBase64(asset.blob)
        const assetBlob = await createBlob(token, owner, repo, base64, 'base64')
        blobs.push({ name: `${path}/assets/${name}`, sha: assetBlob.sha })
      }
    }
  } catch (error) {
    console.error('[sync] не удалось создать blob', error)
    return { status: 'error', message: getErrorMessage(error) }
  }

  const entries: GitHubTreeEntry[] = blobs.map((blob) => ({
    path: blob.name,
    mode: '100644',
    type: 'blob',
    sha: blob.sha
  }))

  return commitFiles(settings, `Update ${path}`, entries)
}

// Общая функция создания коммита с файлами.
// Цепочка: headSha → baseTreeSha → newTreeSha → newCommitSha → PATCH ref
export async function commitFiles(
  settings: Settings,
  message: string,
  entries: GitHubTreeEntry[]
): Promise<SyncResult> {
  if (!isOnline()) {
    return { status: 'offline', message: 'Нет подключения к интернету' }
  }

  const { token, owner, repo, branch } = settings

  const executeCommit = async (): Promise<string> => {
    const headSha = await getBranchHead(token, owner, repo, branch)
    const headCommit = await getCommit(token, owner, repo, headSha)
    const baseTreeSha = headCommit.tree.sha

    const existingTree = await getTreeRecursive(token, owner, repo, baseTreeSha)
    const existingEntries = existingTree.tree.map((entry) => ({
      path: entry.path,
      mode: entry.mode,
      type: entry.type,
      sha: entry.sha
    }))

    const newTree = await createTree(token, owner, repo, baseTreeSha, [...existingEntries, ...entries])
    const commit = await createCommit(token, owner, repo, message, newTree.sha, [headSha])
    return commit.sha
  }

  try {
    const commitSha = await executeCommit()
    await updateRef(token, owner, repo, branch, commitSha, false)
    return { status: 'synced' }
  } catch (error) {
    if (error instanceof GitHubApiError && error.status === 422) {
      try {
        const commitSha = await executeCommit()
        await updateRef(token, owner, repo, branch, commitSha, false)
        return { status: 'synced' }
      } catch (retryError) {
        return { status: 'error', message: getErrorMessage(retryError) }
      }
    }
    return { status: 'error', message: getErrorMessage(error) }
  }
}

// Получить список конспектов из GitHub (getTreeRecursive).
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

// Удалить конспект на GitHub (отдельный коммит с sha: null).
// Из pendingDeletes убираем только после успешного коммита или если файла уже нет.
export async function deleteNoteRemote(
  settings: Settings,
  topic: string,
  title: string
): Promise<boolean> {
  return enqueueWrite(async () => {
    if (!isOnline()) {
      // Офлайн — запись уже должна быть в pendingDeletes (добавлена перед локальным удалением)
      return false
    }

    const { token, owner, repo, branch } = settings
    const path = `${topic}/${title}`

    try {
      const headSha = await getBranchHead(token, owner, repo, branch)
      const headCommit = await getCommit(token, owner, repo, headSha)
      const baseTreeSha = headCommit.tree.sha
      const tree = await getTreeRecursive(token, owner, repo, baseTreeSha)

      // Собираем все блобы под <Тема>/<Конспект>/
      const deletedEntries: GitHubTreeEntry[] = tree.tree
        .filter((entry) => entry.path.startsWith(`${path}/`) && entry.type === 'blob')
        .map((entry) => ({ path: entry.path, mode: entry.mode, type: 'blob', sha: null }))

      // Если ничего не найдено — считаем удалённым
      if (deletedEntries.length === 0) {
        await db.pendingDeletes.delete(path)
        return true
      }

      // Оставляем все файлы, не относящиеся к этому конспекту
      const keepEntries = tree.tree
        .filter((entry) => !entry.path.startsWith(`${path}/`))
        .map((entry) => ({ path: entry.path, mode: entry.mode, type: entry.type, sha: entry.sha }))

      const result = await commitFiles(settings, `Delete ${path}`, [...keepEntries, ...deletedEntries])

      // Убираем из pendingDeletes только после успешного коммита
      if (result.status === 'synced') {
        await db.pendingDeletes.delete(path)
        return true
      }
      // При ошибке запись остаётся в pendingDeletes для повтора
      return false
    } catch (error) {
      console.error('[sync] не удалось удалить конспект', error)
      // Запись остаётся в pendingDeletes для повтора
      return false
    }
  })
}

// Удалить тему на GitHub (все её конспекты).
// Из pendingDeletes убираем только после успешного коммита или если файлов уже нет.
export async function deleteTopicRemote(
  settings: Settings,
  topic: string
): Promise<boolean> {
  return enqueueWrite(async () => {
    if (!isOnline()) {
      // Офлайн — запись уже должна быть в pendingDeletes (добавлена перед локальным удалением)
      return false
    }

    const { token, owner, repo, branch } = settings

    try {
      const headSha = await getBranchHead(token, owner, repo, branch)
      const headCommit = await getCommit(token, owner, repo, headSha)
      const baseTreeSha = headCommit.tree.sha
      const tree = await getTreeRecursive(token, owner, repo, baseTreeSha)

      const prefix = `${topic}/`

      // Собираем все блобы под <Тема>/
      const deletedEntries: GitHubTreeEntry[] = tree.tree
        .filter((entry) => entry.path.startsWith(prefix) && entry.type === 'blob')
        .map((entry) => ({ path: entry.path, mode: entry.mode, type: 'blob', sha: null }))

      // Если ничего не найдено — считаем удалённым
      if (deletedEntries.length === 0) {
        await db.pendingDeletes.delete(prefix)
        return true
      }

      const keepEntries = tree.tree
        .filter((entry) => !entry.path.startsWith(prefix))
        .map((entry) => ({ path: entry.path, mode: entry.mode, type: entry.type, sha: entry.sha }))

      const result = await commitFiles(settings, `Delete ${topic}`, [...keepEntries, ...deletedEntries])

      // Убираем из pendingDeletes только после успешного коммита
      if (result.status === 'synced') {
        await db.pendingDeletes.delete(prefix)
        return true
      }
      // При ошибке запись остаётся в pendingDeletes для повтора
      return false
    } catch (error) {
      console.error('[sync] не удалось удалить тему', error)
      // Запись остаётся в pendingDeletes для повтора
      return false
    }
  })
}

// Выполнить отложенные удаления через очередь записи.
// Вызывается: при старте, при online, после успешного push, по кнопке «Синхронизировать».
export async function processPendingDeletes(settings: Settings): Promise<void> {
  if (!isOnline()) return
  const pending = await db.pendingDeletes.toArray()
  for (const item of pending) {
    if (item.kind === 'note') {
      const [topic, title] = item.path.split('/')
      await deleteNoteRemote(settings, topic, title)
    } else {
      const topic = item.path.replace(/\/$/, '')
      await deleteTopicRemote(settings, topic)
    }
    // Удаление из pendingDeletes происходит внутри deleteNoteRemote/deleteTopicRemote при успехе
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

  const path = `${note.topic}/${note.title}`

  try {
    const remote = await db.remoteNotes.get(path)
    if (!remote) {
      if (note.dirty) {
        requestPush(note.path)
      }
      return null
    }

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

    if (note.dirty && remote.sha === note.baseSha) {
      requestPush(note.path)
      return null
    }

    if (note.dirty && remote.sha !== note.baseSha) {
      const remoteResult = await pullNote(settings, note.topic, note.title)
      if (remoteResult) {
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


