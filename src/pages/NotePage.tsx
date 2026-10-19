import { navigate } from '../router'

// Экран конспекта. Пока заглушка: холст tldraw появится на этапе 2b.

interface NotePageProps {
  topic: string
  note: string
}

export function NotePage({ topic, note }: NotePageProps) {
  return (
    <div className="page note-page">
      <header className="topbar">
        <button type="button" className="button" onClick={() => navigate('/')}>
          ← Назад
        </button>
        <h1 className="topbar-title">
          {topic} / {note}
        </h1>
      </header>
      <main className="page-body">
        <p className="muted">Холст появится на следующем этапе.</p>
      </main>
    </div>
  )
}
