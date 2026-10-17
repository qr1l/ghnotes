import { Tldraw } from 'tldraw'
import { getAssetUrlsByImport } from '@tldraw/assets/imports.vite'

// Шрифты и иконки tldraw берём из самого приложения, а не из CDN,
// чтобы холст работал без интернета.
const assetUrls = getAssetUrlsByImport()

// Ключ лицензии задаётся переменной окружения VITE_TLDRAW_LICENSE_KEY
// (локально в файле .env.local, на GitHub в Settings → Variables).
// В режиме разработки (localhost) ключ не нужен.
const licenseKey = import.meta.env.VITE_TLDRAW_LICENSE_KEY

export function App() {
  return (
    <div className="app">
      <Tldraw
        persistenceKey="ghnotes-first-note"
        assetUrls={assetUrls}
        licenseKey={licenseKey}
      />
    </div>
  )
}
