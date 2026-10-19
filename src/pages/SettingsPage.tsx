import { useState, type FormEvent } from 'react'
import { getRepo } from '../github/api'
import { hasGitHubConnection, loadSettings, saveSettings, type Settings } from '../settings'
import { buildSignature } from '../version'

type CheckState =
  | { status: 'idle' }
  | { status: 'checking' }
  | { status: 'ok'; message: string; canPush: boolean }
  | { status: 'error'; message: string }

export function SettingsPage() {
  const [settings, setSettings] = useState<Settings>(() => loadSettings())
  const [showToken, setShowToken] = useState(false)
  const [saved, setSaved] = useState(false)
  const [check, setCheck] = useState<CheckState>({ status: 'idle' })

  const update = <K extends keyof Settings>(key: K, value: Settings[K]) => {
    setSettings((prev) => ({ ...prev, [key]: value }))
    setSaved(false)
    setCheck({ status: 'idle' })
  }

  const handleSave = (event: FormEvent) => {
    event.preventDefault()
    setSettings(saveSettings(settings))
    setSaved(true)
  }

  const handleCheck = async () => {
    setCheck({ status: 'checking' })
    try {
      const repo = await getRepo(settings.token, settings.owner, settings.repo)
      const fullName = repo.full_name || `${settings.owner}/${settings.repo}`
      setCheck({
        status: 'ok',
        message: `Подключено: ${fullName} (${settings.branch})`,
        canPush: repo.permissions?.push !== false
      })
    } catch (error) {
      setCheck({
        status: 'error',
        message: error instanceof Error ? error.message : 'Неизвестная ошибка'
      })
    }
  }

  const noToken = !hasGitHubConnection(settings)

  return (
    <div className="page settings-page">
      <header className="topbar">
        <h1>Настройки</h1>
      </header>
      <main className="page-body">
        <form className="form" onSubmit={handleSave}>
          <label className="field">
            <span>Токен GitHub</span>
            <span className="token-row">
              <input
                type={showToken ? 'text' : 'password'}
                value={settings.token}
                onChange={(event) => update('token', event.target.value)}
                placeholder="fine-grained personal access token"
                autoComplete="off"
                spellCheck={false}
              />
              <button
                type="button"
                className="button button-secondary"
                onClick={() => setShowToken((value) => !value)}
              >
                {showToken ? 'Скрыть' : 'Показать'}
              </button>
            </span>
          </label>

          <label className="field">
            <span>Владелец</span>
            <input
              type="text"
              value={settings.owner}
              onChange={(event) => update('owner', event.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
          </label>

          <label className="field">
            <span>Репозиторий</span>
            <input
              type="text"
              value={settings.repo}
              onChange={(event) => update('repo', event.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
          </label>

          <label className="field">
            <span>Ветка</span>
            <input
              type="text"
              value={settings.branch}
              onChange={(event) => update('branch', event.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
          </label>

          <div className="actions">
            <button type="submit" className="button">
              Сохранить
            </button>
            <button
              type="button"
              className="button button-secondary"
              onClick={handleCheck}
              disabled={noToken || check.status === 'checking'}
            >
              {check.status === 'checking' ? 'Проверяем…' : 'Проверить подключение'}
            </button>
          </div>
        </form>

        {noToken && <p className="muted">Токен не задан — приложение будет работать только локально.</p>}
        {saved && <p className="status-ok">Настройки сохранены.</p>}

        {check.status === 'ok' && (
          <div className="check-result">
            <p className="status-ok">{check.message}</p>
            {!check.canPush && (
              <p className="status-warning">У токена нет права записи (Contents: read only). Синхронизация будет недоступна.</p>
            )}
          </div>
        )}
        {check.status === 'error' && <p className="status-error">{check.message}</p>}
      </main>
      <footer className="version-footer">{buildSignature()}</footer>
    </div>
  )
}
