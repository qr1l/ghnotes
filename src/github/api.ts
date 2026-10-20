// Типизированный клиент GitHub REST API на fetch без внешних библиотек.
// Используется для синхронизации конспектов с приватным репозиторием notes-data.

export class GitHubApiError extends Error {
  readonly status: number
  readonly gitHubMessage?: string
  readonly gitHubErrors?: string

  constructor(message: string, status: number, gitHubMessage?: string, gitHubErrors?: string) {
    super(message)
    this.name = 'GitHubApiError'
    this.status = status
    this.gitHubMessage = gitHubMessage
    this.gitHubErrors = gitHubErrors
  }
}

const API_BASE = 'https://api.github.com'
const API_VERSION = '2022-11-28'

function headers(token: string, accept = 'application/vnd.github+json'): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: accept,
    'X-GitHub-Api-Version': API_VERSION
  }
}

function errorMessage(status: number, url: string): string {
  // При 404 на обновление ref — специфичная ошибка про ветку
  if (status === 404 && url.includes('/git/refs/heads/')) {
    return 'Ветка не найдена или нет доступа'
  }
  switch (status) {
    case 401:
      return 'Токен недействителен или истёк'
    case 403:
    case 404:
      return 'Нет доступа к репозиторию или он не найден'
    case 409:
    case 422:
      return 'Конфликт версий'
    default:
      return `Ошибка GitHub (код ${status})`
  }
}

function networkError(): GitHubApiError {
  return new GitHubApiError('Нет подключения к интернету', 0)
}

// Путь кодируется по сегментам, чтобы кириллица и пробелы в именах папок не ломали запрос.
function encodePath(path: string): string {
  return path
    .split('/')
    .filter((segment) => segment.length > 0)
    .map((segment) => encodeURIComponent(segment))
    .join('/')
}

// Логирование ошибки GitHub (без токена и заголовков)
function logGitHubError(method: string, url: string, status: number, message: string) {
  const urlObj = new URL(url)
  console.error(`[github] ${method} ${urlObj.pathname} → ${status}: ${message}`)
}

async function parseErrorBody(response: Response): Promise<{ message?: string; errors?: string }> {
  try {
    const body = await response.json() as { message?: string; errors?: Array<{ message: string }> }
    return {
      message: body.message,
      errors: body.errors?.map((e) => e.message).join('; ')
    }
  } catch {
    return {}
  }
}

async function requestJson<T>(url: string, token: string, init: RequestInit = {}): Promise<T> {
  let response: Response
  try {
    response = await fetch(url, {
      ...init,
      cache: 'no-store',
      headers: { ...headers(token), ...(init.headers as Record<string, string> | undefined) }
    })
  } catch {
    throw networkError()
  }
  if (!response.ok) {
    const body = await parseErrorBody(response)
    const fallback = errorMessage(response.status, url)
    const message = body.message ?? fallback
    logGitHubError(init.method ?? 'GET', url, response.status, message)
    throw new GitHubApiError(fallback, response.status, body.message, body.errors)
  }
  return (await response.json()) as T
}

export interface GitHubRepo {
  name: string
  full_name: string
  default_branch: string
  private: boolean
  permissions?: {
    admin?: boolean
    push?: boolean
    pull?: boolean
  }
}

export async function getRepo(token: string, owner: string, repo: string): Promise<GitHubRepo> {
  return requestJson<GitHubRepo>(`${API_BASE}/repos/${owner}/${repo}`, token)
}

export interface GitHubRef {
  ref: string
  object: {
    sha: string
    type: string
  }
}

// Возвращает sha последнего коммита ветки.
export async function getBranchHead(token: string, owner: string, repo: string, branch: string): Promise<string> {
  const ref = await requestJson<GitHubRef>(
    `${API_BASE}/repos/${owner}/${repo}/git/ref/heads/${branch}`,
    token
  )
  return ref.object.sha
}

export interface GitHubCommit {
  sha: string
  message: string
  tree: {
    sha: string
  }
}

// Получает коммит по sha (нужен для получения tree.sha).
export async function getCommit(
  token: string,
  owner: string,
  repo: string,
  sha: string
): Promise<GitHubCommit> {
  return requestJson<GitHubCommit>(`${API_BASE}/repos/${owner}/${repo}/git/commits/${sha}`, token)
}

export interface GitHubTreeNode {
  path: string
  mode: string
  type: 'blob' | 'tree'
  sha: string
  size?: number
}

export interface GitHubTree {
  sha: string
  tree: GitHubTreeNode[]
  truncated?: boolean
}

export async function getTreeRecursive(
  token: string,
  owner: string,
  repo: string,
  sha: string
): Promise<GitHubTree> {
  return requestJson<GitHubTree>(`${API_BASE}/repos/${owner}/${repo}/git/trees/${sha}?recursive=1`, token)
}

// Скачивает файл по пути через contents API. Заголовок raw позволяет
// получить содержимое целиком, в том числе для файлов больше 1 МБ.
export async function getFileRaw(
  token: string,
  owner: string,
  repo: string,
  branch: string,
  path: string
): Promise<Blob> {
  const url = `${API_BASE}/repos/${owner}/${repo}/contents/${encodePath(path)}?ref=${encodeURIComponent(branch)}`
  let response: Response
  try {
    response = await fetch(url, { cache: 'no-store', headers: headers(token, 'application/vnd.github.raw+json') })
  } catch {
    throw networkError()
  }
  if (!response.ok) {
    const body = await parseErrorBody(response)
    const fallback = errorMessage(response.status, url)
    const message = body.message ?? fallback
    logGitHubError('GET', url, response.status, message)
    throw new GitHubApiError(fallback, response.status, body.message, body.errors)
  }
  return response.blob()
}

export interface GitHubBlob {
  sha: string
  url: string
}

export async function createBlob(
  token: string,
  owner: string,
  repo: string,
  content: string,
  encoding: 'utf-8' | 'base64' = 'utf-8'
): Promise<GitHubBlob> {
  return requestJson<GitHubBlob>(`${API_BASE}/repos/${owner}/${repo}/git/blobs`, token, {
    method: 'POST',
    body: JSON.stringify({ content, encoding })
  })
}

export interface GitHubTreeEntry {
  path: string
  mode: string
  type: 'blob' | 'tree'
  sha: string | null
}

export async function createTree(
  token: string,
  owner: string,
  repo: string,
  baseTree: string | null,
  tree: GitHubTreeEntry[]
): Promise<GitHubTree> {
  return requestJson<GitHubTree>(`${API_BASE}/repos/${owner}/${repo}/git/trees`, token, {
    method: 'POST',
    body: JSON.stringify({ base_tree: baseTree, tree })
  })
}

export interface GitHubCommit {
  sha: string
  message: string
  tree: {
    sha: string
  }
}

export async function createCommit(
  token: string,
  owner: string,
  repo: string,
  message: string,
  tree: string,
  parents: string[]
): Promise<GitHubCommit> {
  return requestJson<GitHubCommit>(`${API_BASE}/repos/${owner}/${repo}/git/commits`, token, {
    method: 'POST',
    body: JSON.stringify({ message, tree, parents })
  })
}

// Обновляет ссылку на ветку. force = false, чтобы не потерять чужие коммиты.
export async function updateRef(
  token: string,
  owner: string,
  repo: string,
  branch: string,
  sha: string,
  force = false
): Promise<GitHubRef> {
  return requestJson<GitHubRef>(
    `${API_BASE}/repos/${owner}/${repo}/git/refs/heads/${branch}`,
    token,
    {
      method: 'PATCH',
      body: JSON.stringify({ sha, force })
    }
  )
}
