import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

// Приложение публикуется по адресу https://qr1l.github.io/ghnotes/
export default defineConfig({
  base: '/ghnotes/',
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icon.svg'],
      manifest: {
        name: 'Notes',
        short_name: 'Notes',
        description: 'Personal study notes with a free-form canvas',
        start_url: '/ghnotes/',
        scope: '/ghnotes/',
        display: 'standalone',
        background_color: '#ffffff',
        theme_color: '#2f5fd0',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }
        ]
      },
      workbox: {
        // tldraw тянет много шрифтов и иконок: кэшируем всё, чтобы работало офлайн
        globPatterns: ['**/*.{js,css,html,svg,png,woff,woff2,json}'],
        maximumFileSizeToCacheInBytes: 8 * 1024 * 1024
      }
    })
  ]
})
