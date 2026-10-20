import { useEffect, useRef, useState, type ComponentProps } from 'react'
import { Tldraw } from 'tldraw'
import { getAssetUrlsByImport } from '@tldraw/assets/imports.vite'
import { db } from '../storage/db'
import { assetStore } from '../storage/assets'
import { navigate } from '../router'
import { loadSettings } from '../settings'
import { pushNote, syncOnOpen, type SyncStatus } from '../storage/sync'

type TldrawEditor = Parameters<NonNullable<ComponentProps<typeof Tldraw>['onMount']>>[0]

// Шрифты и иконки tldraw берём из самого приложения, а не из CDN,
// чтобы холст работал без интернета.
const assetUrls = getAssetUrlsByImport()

// Ключ лицензии задаётся переменной окружения VITE_TLDRAW_LICENSE_KEY
// (локально в файле .env.local, на GitHub в Settings → Variables).
// В режим разработки (localhost) ключ не нужен.
const licenseKey = import.meta.env.VITE_TLDRAW_LICENSE_KEY

interface NotePageProps {
  topic: string
  note: string
}

// Проверка, что снимок документа имеет валидную форму:
// объект, у которого есть и store (объект), и schema (объект).
function isValidDocumentSnapshot(data: unknown): data is { store: object; schema: object } {
  if (!data || typeof data !== 'object') return false
  const d = data as Record<string, unknown>
  return (
    d.store !== null &&
    typeof d.store === 'object' &&
    d.schema !== null &&
    typeof d.schema === 'object'
  )
}

// Проверка, что сессия валидна: непустой объект.
function isValidSession(session: unknown): boolean {
  return session !== null && typeof session === 'object' && Object.keys(session).length > 0
}

// Миграция старых снимков: замена префикса "ghasset:" на "asset:" у ассетов типа image.
function migrateSnapshotDocument(document: unknown): unknown {
  if (!document || typeof document !== 'object') return document
  const d = document as Record<string, unknown>
  const store = d.store
  if (!store || typeof store !== 'object') return document

  const migrated: Record<string, unknown> = {}
  for (const [id, record] of Object.entries(store)) {
    const r = record as Record<string, unknown>
    const props = r?.props as Record<string, unknown> | undefined
    if (r?.type === 'asset' && props?.type === 'image') {
      const src = props.src
      if (typeof src === 'string' && src.startsWith('ghasset:')) {
        migrated[id] = {
          ...r,
          props: { ...props, src: 'asset:' + src.slice('ghasset:'.length) }
        }
        continue
      }
    }
    migrated[id] = record
  }
  return { ...d, store: migrated }
}

function statusLabel(status: SyncStatus | 'saving' | 'saved'): string {
  switch (status) {
    case 'synced': return 'Синхронизировано'
    case 'pending': return 'Не отправлено'
    case 'syncing': return 'Отправляется…'
    case 'offline': return 'Офлайн'
    case 'error': return 'Ошибка'
    case 'no-connection': return 'Нет подключения'
    case 'saving': return 'Сохранение…'
    case 'saved': return 'Сохранено'
  }
}

export function NotePage({ topic, note }: NotePageProps) {
  const path = `${topic}/${note}`
  const [saveStatus, setSaveStatus] = useState<'saved' | 'saving' | 'error'>('saved')
  const [syncStatus, setSyncStatus] = useState<SyncStatus | 'no-connection'>('synced')
  const [syncError, setSyncError] = useState<string | null>(null)
  const [initialSnapshot, setInitialSnapshot] = useState<{ document?: unknown; session?: unknown } | null>(null)
  const [loadError, setLoadError] = useState(false)
  const [conflictMessage, setConflictMessage] = useState<string | null>(null)
  const saveTimeout = useRef<number | undefined>(undefined)
  const syncTimeout = useRef<number | undefined>(undefined)

  // Загрузка существующего конспекта из Dexie + синхронизация при открытии.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        let record = await db.notes.get(path)
        if (cancelled) return

        // Если записи нет локально — создаём пустую
        if (!record) {
          const now = new Date().toISOString()
          record = {
            path,
            topic,
            title: note,
            data: { format: 1, title: note, createdAt: now, updatedAt: now, snapshot: {} },
            session: {},
            baseSha: null,
            dirty: true,
            updatedAt: now
          }
          await db.notes.add(record)
        }

        // Синхронизация с GitHub при открытии (pull/push/конфликт)
        const settings = loadSettings()
        if (settings.token && navigator.onLine) {
          setSyncStatus('syncing')
          const result = await syncOnOpen(settings, record, (copyTitle) => {
            setConflictMessage(`Создана копия: «${copyTitle}»`)
          })
          if (!cancelled && result) {
            const data = JSON.parse(result.data) as typeof record.data
            await db.notes.update(path, {
              data,
              baseSha: result.sha,
              dirty: false,
              updatedAt: new Date().toISOString()
            })
          }
          if (!cancelled) setSyncStatus('synced')
        } else if (!settings.token) {
          if (!cancelled) setSyncStatus('no-connection')
        }

        // Загрузка снимка в Tldraw
        const current = await db.notes.get(path)
        if (!cancelled && current) {
          const document = current.data.snapshot
          const session = current.session

          if (isValidDocumentSnapshot(document)) {
            const snapshot: Record<string, unknown> = { document: migrateSnapshotDocument(document) }
            if (isValidSession(session)) {
              snapshot.session = session
            }
            setInitialSnapshot(snapshot)
          } else {
            setInitialSnapshot(null)
          }
        }
      } catch (error) {
        if (!cancelled) {
          console.error('[db] не удалось загрузить конспект', error)
          setLoadError(true)
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [path, topic, note])

  // Автосохранение + отправка на GitHub.
  const onMount = (editor: TldrawEditor) => {
    if (initialSnapshot?.session && isValidSession(initialSnapshot.session)) {
      editor.loadSnapshot({ session: initialSnapshot.session as never })
    }

    const unsubscribe = editor.store.listen(
      () => {
        setSaveStatus('saving')
        window.clearTimeout(saveTimeout.current)
        saveTimeout.current = window.setTimeout(() => {
          void saveSnapshot(editor)
        }, 1000)
      },
      { source: 'user', scope: 'document' }
    )

    return () => {
      unsubscribe()
      window.clearTimeout(saveTimeout.current)
    }
  }

  const saveSnapshot = async (editor: TldrawEditor) => {
    try {
      const snapshot = editor.getSnapshot()
      const now = new Date().toISOString()
      const existing = await db.notes.get(path)
      await db.notes.update(path, {
        data: {
          format: 1,
          title: note,
          createdAt: existing?.data.createdAt ?? now,
          updatedAt: now,
          snapshot: snapshot.document
        },
        session: snapshot.session,
        dirty: true,
        updatedAt: now
      })
      setSaveStatus('saved')

      // Отправка на GitHub через 10 секунд после последней правки
      window.clearTimeout(syncTimeout.current)
      syncTimeout.current = window.setTimeout(() => {
        void doSync()
      }, 10000)
    } catch (error) {
      console.error('[db] не удалось сохранить конспект', error)
      setSaveStatus('error')
    }
  }

  const doSync = async () => {
    const settings = loadSettings()
    if (!settings.token || !navigator.onLine) {
      setSyncStatus(settings.token ? 'offline' : 'no-connection')
      return
    }
    setSyncStatus('syncing')
    try {
      const record = await db.notes.get(path)
      if (!record) return
      const result = await pushNote(settings, record, (status) => {
        if (!cancelled) setSyncStatus(status)
      })
      if (result.status === 'synced') {
        setSyncStatus('synced')
        setSyncError(null)
      } else {
        setSyncStatus(result.status)
        setSyncError(result.message ?? null)
      }
    } catch (error) {
      console.error('[sync] ошибка отправки', error)
      setSyncStatus('error')
      setSyncError(error instanceof Error ? error.message : 'Неизвестная ошибка')
    }
  }

  const cancelled = useRef(false)

  return (
    <div className="page note-page">
      <header className="topbar">
        <button type="button" className="button button-secondary" onClick={() => navigate('/')}>
          ← Назад
        </button>
        <h1 className="topbar-title">
          {topic} / {note}
        </h1>
        <button type="button" className="button button-secondary" onClick={() => void doSync()}>
          Синхронизировать
        </button>
        <span
          className={`sync-indicator sync-${syncStatus === 'syncing' ? 'syncing' : syncStatus === 'synced' ? 'saved' : syncStatus === 'offline' ? 'offline' : syncStatus === 'error' ? 'error' : syncStatus === 'pending' ? 'pending' : 'no-connection'}`}
          title={syncError ?? undefined}
        >
          {statusLabel(syncStatus)}
        </span>
      </header>
      <div className="canvas-container">
        <Tldraw
          assetUrls={assetUrls}
          licenseKey={licenseKey}
          snapshot={initialSnapshot as never}
          assets={assetStore}
          onMount={onMount}
        />
        {loadError && (
          <div className="load-error-warning">
            Не удалось прочитать сохранённые данные заметки
          </div>
        )}
        {conflictMessage && (
          <div className="load-error-warning">
            {conflictMessage}
          </div>
        )}
      </div>
    </div>
  )
}
