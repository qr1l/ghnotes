import { useEffect, useMemo, useState } from 'react'
import { db, type NoteRecord } from '../storage/db'
import { buildNotePath, navigate } from '../router'
import { buildSignature } from '../version'

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

export function ListPage() {
  const [notes, setNotes] = useState<NoteRecord[]>([])
  const [selectedTopic, setSelectedTopic] = useState<string | null>(null)
  const [dialog, setDialog] = useState<DialogState>({ kind: 'none' })
  const [inputValue, setInputValue] = useState('')

  const refresh = async () => {
    const all = await db.notes.toArray()
    all.sort((a, b) => a.topic.localeCompare(b.topic, 'ru') || a.title.localeCompare(b.title, 'ru'))
    setNotes(all)
  }

  useEffect(() => {
    void refresh()
  }, [])

  const topics = useMemo(() => {
    const map = new Map<string, NoteRecord[]>()
    for (const note of notes) {
      const list = map.get(note.topic) ?? []
      list.push(note)
      map.set(note.topic, list)
    }
    return Array.from(map.entries()).sort((a, b) => a[0].localeCompare(b[0], 'ru'))
  }, [notes])

  const selectedNotes = useMemo(
    () => (selectedTopic ? (topics.find(([topic]) => topic === selectedTopic)?.[1] ?? []) : []),
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
      const existing = topics.map(([topic]) => topic)
      const finalName = uniqueName(name, existing)
      if (finalName) {
        const now = new Date().toISOString()
        await db.notes.add({
          path: `${finalName}/${finalName}`,
          topic: finalName,
          title: finalName,
          data: { format: 1, title: finalName, createdAt: now, updatedAt: now, snapshot: {} },
          baseSha: null,
          dirty: true,
          updatedAt: now
        })
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
    await refresh()
  }

  const handleDeleteTopic = async (topic: string) => {
    const topicNotes = topics.find(([t]) => t === topic)?.[1] ?? []
    if (!window.confirm(`Удалить тему «${topic}» и все её конспекты (${topicNotes.length})?`)) return
    await db.notes.where('topic').equals(topic).delete()
    if (selectedTopic === topic) setSelectedTopic(null)
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
        <button type="button" className="button" onClick={() => navigate('/settings')}>
          Настройки
        </button>
      </header>

      <main className="page-body">
        {!selectedTopic ? (
          <>
            <div className="list-actions">
              <button type="button" className="button" onClick={() => openDialog('new-topic')}>
                + Новая тема
              </button>
            </div>
            <div className="topics-grid">
              {topics.map(([topic, topicNotes]) => (
                <div key={topic} className="topic-card" onClick={() => setSelectedTopic(topic)}>
                  <div className="topic-name">{topic}</div>
                  <div className="topic-count">{topicNotes.length} консп.</div>
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
