import { useEffect, useRef, useState } from 'react'
import { Tldraw } from 'tldraw'
import { createTLStore, getSnapshot, loadSnapshot, type TLStore } from '@tldraw/editor'
import { getAssetUrlsByImport } from '@tldraw/assets/imports.vite'
import { db } from '../storage/db'
import { assetStore } from '../storage/assets'
import { navigate } from '../router'

// Шрифты и иконки tldraw берём из самого приложения, а не из CDN,
// чтобы холст работал без интернета.
const assetUrls = getAssetUrlsByImport()

// Ключ лицензии задаётся переменной окружения VITE_TLDRAW_LICENSE_KEY
// (локально в файле .env.local, на GitHub в Settings → Variables).
// В режиме разработки (localhost) ключ не нужен.
const licenseKey = import.meta.env.VITE_TLDRAW_LICENSE_KEY

interface NotePageProps {
  topic: string
  note: string
}

export function NotePage({ topic, note }: NotePageProps) {
  const path = `${topic}/${note}`
  const [store, setStore] = useState<TLStore | null>(null)
  const [saveStatus, setSaveStatus] = useState<'saved' | 'saving' | 'error'>('saved')
  const saveTimeout = useRef<number | undefined>(undefined)

  // Инициализация: загружаем или создаём запись, создаём store, загружаем снапшот.
  useEffect(() => {
    let cancelled = false

    async function init() {
      const now = new Date().toISOString()
      let record = await db.notes.get(path)

      if (!record) {
        record = {
          path,
          topic,
          title: note,
          data: { format: 1, title: note, createdAt: now, updatedAt: now, snapshot: {} },
          baseSha: null,
          dirty: true,
          updatedAt: now
        }
        await db.notes.add(record)
      }

      const newStore = createTLStore({ assets: assetStore })
      if (record.data.snapshot && Object.keys(record.data.snapshot as object).length > 0) {
        loadSnapshot(newStore, record.data.snapshot as Parameters<typeof loadSnapshot>[1])
      }

      if (!cancelled) setStore(newStore)
    }

    void init()
    return () => {
      cancelled = true
    }
  }, [path, topic, note])

  // Автосохранение: при правках сохраняем снапшот в Dexie с задержкой 1 секунда.
  useEffect(() => {
    if (!store) return

    const unsubscribe = store.listen(() => {
      setSaveStatus('saving')
      window.clearTimeout(saveTimeout.current)
      saveTimeout.current = window.setTimeout(() => {
        void saveSnapshot(store)
      }, 1000)
    })

    return () => {
      unsubscribe()
      window.clearTimeout(saveTimeout.current)
    }
  }, [store])

  const saveSnapshot = async (currentStore: TLStore) => {
    try {
      const snapshot = getSnapshot(currentStore)
      const now = new Date().toISOString()
      await db.notes.update(path, {
        data: { format: 1, title: note, createdAt: now, updatedAt: now, snapshot },
        dirty: true,
        updatedAt: now
      })
      setSaveStatus('saved')
    } catch (error) {
      console.error('[db] не удалось сохранить конспект', error)
      setSaveStatus('error')
    }
  }

  return (
    <div className="page note-page">
      <header className="topbar">
        <button type="button" className="button button-secondary" onClick={() => navigate('/')}>
          ← Назад
        </button>
        <h1 className="topbar-title">
          {topic} / {note}
        </h1>
        <span className={`sync-indicator sync-${saveStatus}`}>
          {saveStatus === 'saving' ? 'Сохранение…' : saveStatus === 'error' ? 'Ошибка' : 'Локально'}
        </span>
      </header>
      <div className="canvas-container">
        {store && (
          <Tldraw
            store={store}
            assetUrls={assetUrls}
            licenseKey={licenseKey}
          />
        )}
      </div>
    </div>
  )
}
