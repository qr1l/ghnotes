import { useEffect, useState } from 'react'

// Минимальный hash-роутер: GitHub Pages не умеет SPA-маршруты,
// поэтому состояние хранится в location.hash.

export type Route =
  | { name: 'list' }
  | { name: 'note'; topic: string; note: string }
  | { name: 'settings' }

function decode(segment: string): string {
  try {
    return decodeURIComponent(segment)
  } catch {
    return segment
  }
}

export function parseHash(hash: string): Route {
  const parts = hash.replace(/^#/, '').split('/').filter((part) => part.length > 0)
  if (parts[0] === 'n' && parts.length >= 3) {
    return { name: 'note', topic: decode(parts[1]), note: decode(parts[2]) }
  }
  if (parts[0] === 'settings') {
    return { name: 'settings' }
  }
  return { name: 'list' }
}

export function navigate(path: string): void {
  window.location.hash = path
}

export function buildNotePath(topic: string, note: string): string {
  return `/n/${encodeURIComponent(topic)}/${encodeURIComponent(note)}`
}

export function useHashRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseHash(window.location.hash))

  useEffect(() => {
    const onChange = () => setRoute(parseHash(window.location.hash))
    window.addEventListener('hashchange', onChange)
    return () => window.removeEventListener('hashchange', onChange)
  }, [])

  return route
}
