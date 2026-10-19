import { navigate } from '../router'
import { buildSignature } from '../version'

// Список конспектов. Пока заглушка: темы, конспекты и действия
// появятся на этапе 2b.

export function ListPage() {
  return (
    <div className="page list-page">
      <header className="topbar">
        <h1>Конспекты</h1>
        <button type="button" className="button" onClick={() => navigate('/settings')}>
          Настройки
        </button>
      </header>
      <main className="page-body">
        <p className="muted">Список конспектов появится на следующем этапе.</p>
      </main>
      <footer className="version-footer">{buildSignature()}</footer>
    </div>
  )
}
