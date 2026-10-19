import { registerSW } from 'virtual:pwa-register'

// Обновление приложения: при появлении новой версии показываем плашку
// с кнопкой «Обновить». registerType в vite.config.ts выставлен в 'prompt'.

export type PwaStatus = 'idle' | 'update-available' | 'offline-ready'

type UpdateSW = (reloadPage?: boolean) => Promise<void>

let currentStatus: PwaStatus = 'idle'
let updateSW: UpdateSW = () => Promise.resolve()
const listeners = new Set<(status: PwaStatus) => void>()

function setStatus(status: PwaStatus): void {
  currentStatus = status
  listeners.forEach((listener) => listener(status))
}

export function initPwa(): void {
  if (typeof window === 'undefined') return
  try {
    updateSW = registerSW({
      immediate: true,
      onNeedRefresh: () => setStatus('update-available'),
      onOfflineReady: () => setStatus('offline-ready'),
      onRegisterError: (error) => {
        console.error('[pwa] не удалось зарегистрировать service worker', error)
      }
    })
  } catch (error) {
    console.error('[pwa] не удалось инициализировать обновление', error)
  }
}

export function getPwaStatus(): PwaStatus {
  return currentStatus
}

export function subscribePwa(listener: (status: PwaStatus) => void): () => void {
  listeners.add(listener)
  listener(currentStatus)
  return () => {
    listeners.delete(listener)
  }
}

export function applyPwaUpdate(): Promise<void> {
  return updateSW(true)
}
