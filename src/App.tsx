import { useEffect, useState } from 'react'
import { applyPwaUpdate, getPwaStatus, subscribePwa } from './pwa'
import { ListPage } from './pages/ListPage'
import { NotePage } from './pages/NotePage'
import { SettingsPage } from './pages/SettingsPage'
import { useHashRoute } from './router'

export function App() {
  const route = useHashRoute()
  const [pwaStatus, setPwaStatus] = useState(getPwaStatus())

  useEffect(() => subscribePwa(setPwaStatus), [])

  return (
    <div className="app">
      {route.name === 'list' && <ListPage />}
      {route.name === 'note' && <NotePage topic={route.topic} note={route.note} />}
      {route.name === 'settings' && <SettingsPage />}

      {pwaStatus === 'update-available' && (
        <div className="update-banner" role="status">
          <span>Доступна новая версия</span>
          <button type="button" className="button" onClick={() => void applyPwaUpdate()}>
            Обновить
          </button>
        </div>
      )}
    </div>
  )
}
