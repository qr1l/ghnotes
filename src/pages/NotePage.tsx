import { useEffect, useRef, useState, type ComponentProps } from 'react'
import { Tldraw } from 'tldraw'
import { getAssetUrlsByImport } from '@tldraw/assets/imports.vite'
import { db } from '../storage/db'
import { assetStore } from '../storage/assets'
import { navigate } from '../router'

type TldrawEditor = Parameters<NonNullable<ComponentProps<typeof Tldraw>['onMount']>>[0]

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
  const [saveStatus, setSaveStatus] = useState<'saved' | 'saving' | 'error'>('saved')
  const [initialSnapshot, setInitialSnapshot] = useState<{ document?: unknown; session?: unknown } | null>(null)

  const saveTimeout = useRef<number | undefined>(undefined)

  // Загрузка существующего конспекта из Dexie.
  // Открытие без правок не выставляет dirty = true.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const record = await db.notes.get(path)
        if (cancelled) return
        if (record) {
          setInitialSnapshot({
            document: record.data.snapshot,
            session: record.session
          })
        }
      } catch (error) {
        console.error('[db] не удалось загрузить конспект', error)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [path])

  // Автосохранение: при правках сохраняем снапшот в Dexie с задержкой 1 секунда.
  // Подписываемся только на пользовательские изменения документа.
  const onMount = (editor: TldrawEditor) => {
    // Загружаем локальную сессию (камера, текущий лист), если она есть.
    if (initialSnapshot?.session && Object.keys(initialSnapshot.session as object).length > 0) {
      editor.loadSnapshot({ session: initialSnapshot.session as never })
    }

    const unsubscribe = editor.store.listen(
      () => {
        setSaveStatus('saving')
        window.clearTimeout(saveTimeout.current)
        saveTimeout.current = window.setTimeout(() => {
          void saveSnapshot(editor)
        }, 1000)
      },
      { source: 'user', scope: 'document' }
    )

    return () => {
      unsubscribe()
      window.clearTimeout(saveTimeout.current)
    }
  }

  const saveSnapshot = async (editor: TldrawEditor) => {
    try {
      const snapshot = editor.getSnapshot()
      const now = new Date().toISOString()
      // При сохранении обновляем только updatedAt и snapshot.
      // createdAt остаётся от первоначального создания конспекта.
      const existing = await db.notes.get(path)
      await db.notes.update(path, {
        data: {
          format: 1,
          title: note,
          createdAt: existing?.data.createdAt ?? now,
          updatedAt: now,
          snapshot: snapshot.document
        },
        session: snapshot.session,
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
        <Tldraw
          assetUrls={assetUrls}
          licenseKey={licenseKey}
          snapshot={initialSnapshot as never}
          assets={assetStore}
          onMount={onMount}
        />
      </div>
    </div>
  )
}
