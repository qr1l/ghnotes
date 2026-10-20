import { useCallback, useEffect, useMemo, useState } from 'react'
import { db, type NoteRecord, type RemoteNoteRecord } from '../storage/db'
import { buildNotePath, navigate } from '../router'
import { buildSignature } from '../version'
import { loadSettings } from '../settings'
import {
  cacheRemoteList,
  deleteNoteRemote,
  deleteTopicRemote,
  fetchRemoteList,
  processPendingDeletes,
  type SyncStatus
} from '../storage/sync'

// Правила имён из раздела «Принятые решения»:
// убирать / \ : * ? " < > |, обрезать пробелы, максимум 60 символов,
// кириллица разрешена, при совпадении добавлять « (2)», « (3)».

function sanitizeName(name: string): string {
  return name.replace(/[\/\\:*?"<>|]/g, '').trim().slice(0, 60)
}

function uniqueName(name: string, existing: string[]): string {
  const base = sanitizeName(name)
  if (!base) return ''
  if (!existing.includes(base)) return base
  let counter = 2
  while (existing.includes(`${base} (${counter})`)) counter++
  return `${base} (${counter})`
}

type DialogState =
  | { kind: 'none' }
  | { kind: 'new-topic' }
  | { kind: 'new-note'; topic: string }

interface TopicWithNotes {
  name: string
  notes: NoteRecord[]
}

export function ListPage() {
  const [notes, setNotes] = useState<NoteRecord[]>([])
  const [topicNames, setTopicNames] = useState<string[]>([])
  const [selectedTopic, setSelectedTopic] = useState<string | null>(null)
  const [dialog, setDialog] = useState<DialogState>({ kind: 'none' })
  const [inputValue, setInputValue] = useState('')
  const [syncStatus, setSyncStatus] = useState<SyncStatus | 'no-connection'>('synced')
  const [syncError, setSyncError] = useState<string | null>(null)
  const [truncatedWarning, setTruncatedWarning] = useState(false)

  const refresh = useCallback(async () => {
    const allNotes = await db.notes.toArray()
    allNotes.sort((a, b) => a.topic.localeCompare(b.topic, 'ru') || a.title.localeCompare(b.title, 'ru'))
    setNotes(allNotes)

    const allTopics = await db.topics.toArray()
    const names = new Set(allTopics.map((topic) => topic.name))
    for (const note of allNotes) {
      names.add(note.topic)
    }
    setTopicNames(Array.from(names).sort((a, b) => a.localeCompare(b, 'ru')))
  }, [])

  // Загрузка списка из GitHub при монтировании и при появлении сети.
  useEffect(() => {
    void refresh()

    const settings = loadSettings()
    if (!settings.token) {
      setSyncStatus('no-connection')
      return
    }

    if (!navigator.onLine) {
      setSyncStatus('offline')
      return
    }

    setSyncStatus('syncing')
    void (async () => {
      try {
        const remote = await fetchRemoteList(settings)
        await cacheRemoteList(remote.notes)

        // Удалённые конспекты (которых нет на GitHub и у которых нет dirty) — убираем
        const remotePaths = new Set(remote.notes.map((n) => `${n.topic}/${n.title}`))
        const localAll = await db.notes.toArray()
        for (const local of localAll) {
          if (!remotePaths.has(local.path) && !local.dirty) {
            await db.notes.delete(local.path)
          }
        }

        // Темы без конспектов на GitHub не удаляем (они только локальные)
        // Но если тема есть локально и удалена на GitHub — оставляем (GitHub не хранит пустые папки)

        setTruncatedWarning(remote.truncated)
        setSyncStatus('synced')
        setSyncError(null)
        await refresh()
      } catch (error) {
        console.error('[sync] не удалось загрузить список', error)
        setSyncStatus('error')
        setSyncError(error instanceof Error ? error.message : 'Ошибка GitHub')
      }
    })()

    // При появлении сети — повторить синхронизацию
    const onOnline = () => {
      void processPendingDeletes(settings)
      void refresh()
    }
    window.addEventListener('online', onOnline)
    return () => window.removeEventListener('online', onOnline)
  }, [refresh])

  const topics = useMemo<TopicWithNotes[]>(() => {
    const map = new Map<string, NoteRecord[]>()
    for (const note of notes) {
      const list = map.get(note.topic) ?? []
      list.push(note)
      map.set(note.topic, list)
    }
    return topicNames.map((name) => ({ name, notes: map.get(name) ?? [] }))
  }, [notes, topicNames])

  const selectedNotes = useMemo(
    () => (selectedTopic ? (topics.find((topic) => topic.name === selectedTopic)?.notes ?? []) : []),
    [topics, selectedTopic]
  )

  const openNote = (note: NoteRecord) => {
    navigate(buildNotePath(note.topic, note.title))
  }

  const handleCreate = async () => {
    const name = sanitizeName(inputValue)
    if (!name) {
      setDialog({ kind: 'none' })
      setInputValue('')
      return
    }

    if (dialog.kind === 'new-topic') {
      const finalName = uniqueName(name, topicNames)
      if (finalName) {
        await db.topics.add({ name: finalName, createdAt: new Date().toISOString() })
      }
    } else if (dialog.kind === 'new-note') {
      const existing = selectedNotes.map((note) => note.title)
      const finalName = uniqueName(name, existing)
      if (finalName) {
        const now = new Date().toISOString()
        await db.notes.add({
          path: `${dialog.topic}/${finalName}`,
          topic: dialog.topic,
          title: finalName,
          data: { format: 1, title: finalName, createdAt: now, updatedAt: now, snapshot: {} },
          session: {},
          baseSha: null,
          dirty: true,
          updatedAt: now
        })
      }
    }

    setDialog({ kind: 'none' })
    setInputValue('')
    await refresh()
  }

  const handleDeleteNote = async (note: NoteRecord) => {
    if (!window.confirm(`Удалить конспект «${note.title}»?`)) return
    await db.notes.delete(note.path)

    // Удаление на GitHub (отложенное, если офлайн)
    const settings = loadSettings()
    if (settings.token) {
      setSyncStatus('syncing')
      const ok = await deleteNoteRemote(settings, note.topic, note.title)
      setSyncStatus(ok ? 'synced' : 'offline')
    }
    await refresh()
  }

  const handleDeleteTopic = async (topic: TopicWithNotes) => {
    const message = topic.notes.length > 0
      ? `Удалить тему «${topic.name}» и все её конспекты (${topic.notes.length})?`
      : `Удалить тему «${topic.name}»?`
    if (!window.confirm(message)) return

    await db.transaction('rw', db.topics, db.notes, async () => {
      await db.topics.delete(topic.name)
      await db.notes.where('topic').equals(topic.name).delete()
    })

    const settings = loadSettings()
    if (settings.token && topic.notes.length > 0) {
      setSyncStatus('syncing')
      const ok = await deleteTopicRemote(settings, topic.name, topic.notes.map((n) => n.title))
      setSyncStatus(ok ? 'synced' : 'offline')
    }
    if (selectedTopic === topic.name) setSelectedTopic(null)
    await refresh()
  }

  const openDialog = (kind: DialogState['kind'], topic?: string) => {
    setInputValue('')
    if (kind === 'new-topic') setDialog({ kind: 'new-topic' })
    else if (kind === 'new-note' && topic) setDialog({ kind: 'new-note', topic })
  }

  const cancelDialog = () => {
    setDialog({ kind: 'none' })
    setInputValue('')
  }

  return (
    <div className="page list-page">
      <header className="topbar">
        {selectedTopic && (
          <button type="button" className="button button-secondary" onClick={() => setSelectedTopic(null)}>
            ← Назад
          </button>
        )}
        <h1>{selectedTopic ?? 'Конспекты'}</h1>
        <span
          className={`sync-indicator sync-${syncStatus === 'syncing' ? 'syncing' : syncStatus === 'synced' ? 'saved' : syncStatus === 'offline' ? 'offline' : syncStatus === 'error' ? 'error' : syncStatus === 'pending' ? 'pending' : 'no-connection'}`}
          title={syncError ?? undefined}
          onClick={() => navigate('/settings')}
        >
          {syncStatus === 'no-connection' ? 'Нет подключения' :
           syncStatus === 'syncing' ? 'Синхронизация…' :
           syncStatus === 'synced' ? 'Синхронизировано' :
           syncStatus === 'offline' ? 'Офлайн' :
           syncStatus === 'error' ? 'Ошибка' :
           syncStatus === 'pending' ? 'Не отправлено' : ''}
        </span>
        <button type="button" className="button" onClick={() => navigate('/settings')}>
          Настройки
        </button>
      </header>

      <main className="page-body">
        {truncatedWarning && (
          <div className="load-error-warning">
            Список из GitHub неполный (truncated). Возможно, не все конспекты отображены.
          </div>
        )}

        {!selectedTopic ? (
          <>
            <div className="list-actions">
              <button type="button" className="button" onClick={() => openDialog('new-topic')}>
                + Новая тема
              </button>
            </div>
            <div className="topics-grid">
              {topics.map((topic) => (
                <div key={topic.name} className="topic-card" onClick={() => setSelectedTopic(topic.name)}>
                  <div className="topic-name">{topic.name}</div>
                  <div className="topic-count">{topic.notes.length} консп.</div>
                  <button
                    type="button"
                    className="button button-secondary button-small"
                    onClick={(event) => {
                      event.stopPropagation()
                      void handleDeleteTopic(topic)
                    }}
                  >
                    Удалить
                  </button>
                </div>
              ))}
              {topics.length === 0 && <p className="muted">Пока нет тем. Создайте первую.</p>}
            </div>
          </>
        ) : (
          <>
            <div className="list-actions">
              <button type="button" className="button" onClick={() => openDialog('new-note', selectedTopic)}>
                + Новый конспект
              </button>
            </div>
            <div className="notes-list">
              {selectedNotes.map((note) => (
                <div key={note.path} className="note-row" onClick={() => openNote(note)}>
                  <div className="note-title">{note.title}</div>
                  <div className="note-date">{new Date(note.updatedAt).toLocaleDateString('ru-RU')}</div>
                  <span className={`sync-dot ${note.dirty ? 'sync-dot-pending' : 'sync-dot-synced'}`} title={note.dirty ? 'Не отправлено' : 'Синхронизировано'} />
                  <button
                    type="button"
                    className="button button-secondary button-small"
                    onClick={(event) => {
                      event.stopPropagation()
                      void handleDeleteNote(note)
                    }}
                  >
                    Удалить
                  </button>
                </div>
              ))}
              {selectedNotes.length === 0 && <p className="muted">В этой теме пока нет конспектов.</p>}
            </div>
          </>
        )}
      </main>

      <footer className="version-footer">{buildSignature()}</footer>

      {dialog.kind !== 'none' && (
        <div className="modal-overlay" onClick={cancelDialog}>
          <div className="modal" onClick={(event) => event.stopPropagation()}>
            <h2>{dialog.kind === 'new-topic' ? 'Новая тема' : 'Новый конспект'}</h2>
            <input
              type="text"
              value={inputValue}
              onChange={(event) => setInputValue(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void handleCreate()
                if (event.key === 'Escape') cancelDialog()
              }}
              placeholder="Название"
              autoFocus
              maxLength={60}
            />
            <div className="modal-actions">
              <button type="button" className="button button-secondary" onClick={cancelDialog}>
                Отмена
              </button>
              <button type="button" className="button" onClick={() => void handleCreate()}>
                Создать
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
