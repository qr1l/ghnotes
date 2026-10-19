// Настройки приложения: токен GitHub и координаты репозитория с данными.
// Хранятся в localStorage. Работа с localStorage обёрнута в try/catch,
// потому что браузер может запретить доступ к хранилищу.

export interface Settings {
  token: string
  owner: string
  repo: string
  branch: string
}

export const DEFAULT_SETTINGS: Settings = {
  token: '',
  owner: 'qr1l',
  repo: 'notes-data',
  branch: 'main'
}

const STORAGE_KEY = 'ghnotes:settings'

function sanitize(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value.trim() : fallback
}

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { ...DEFAULT_SETTINGS }
    const parsed = JSON.parse(raw) as Partial<Settings>
    return {
      token: typeof parsed.token === 'string' ? parsed.token.trim() : DEFAULT_SETTINGS.token,
      owner: sanitize(parsed.owner, DEFAULT_SETTINGS.owner) || DEFAULT_SETTINGS.owner,
      repo: sanitize(parsed.repo, DEFAULT_SETTINGS.repo) || DEFAULT_SETTINGS.repo,
      branch: sanitize(parsed.branch, DEFAULT_SETTINGS.branch) || DEFAULT_SETTINGS.branch
    }
  } catch (error) {
    console.error('[settings] не удалось прочитать настройки', error)
    return { ...DEFAULT_SETTINGS }
  }
}

export function saveSettings(settings: Settings): Settings {
  const normalized: Settings = {
    token: settings.token.trim(),
    owner: settings.owner.trim() || DEFAULT_SETTINGS.owner,
    repo: settings.repo.trim() || DEFAULT_SETTINGS.repo,
    branch: settings.branch.trim() || DEFAULT_SETTINGS.branch
  }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized))
  } catch (error) {
    console.error('[settings] не удалось сохранить настройки', error)
  }
  return normalized
}

// Подключение к GitHub считается настроенным, только если задан токен.
export function hasGitHubConnection(settings: Settings): boolean {
  return settings.token.length > 0
}
