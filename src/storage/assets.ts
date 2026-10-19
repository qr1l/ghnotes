import type { TLAssetStore } from '@tldraw/editor'
import { db } from './db'

// Собственное хранилище картинок для tldraw.
// Картинки сжимаются в WebP (макс. сторона 2000 px, качество 0.8),
// хэшируются SHA-256 и хранятся в IndexedDB. Ссылка вида ghasset:<имя>.
// Скачивание из GitHub добавляется на этапе 2c.

const MAX_SIZE = 10 * 1024 * 1024 // 10 МБ
const MAX_SIDE = 2000
const QUALITY = 0.8
const PREFIX = 'ghasset:'

// Кэш blob-ссылок, чтобы не создавать новые при каждом resolve.
const urlCache = new Map<string, string>()

async function compressImage(file: Blob): Promise<Blob> {
  const bitmap = await createImageBitmap(file)
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height))
  const width = Math.max(1, Math.round(bitmap.width * scale))
  const height = Math.max(1, Math.round(bitmap.height * scale))

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) {
    bitmap.close()
    throw new Error('Canvas 2D недоступен в этом браузере')
  }
  ctx.drawImage(bitmap, 0, 0, width, height)
  bitmap.close()

  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) resolve(blob)
        else reject(new Error('Не удалось сжать изображение'))
      },
      'image/webp',
      QUALITY
    )
  })
}

async function sha256(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer()
  const hash = await crypto.subtle.digest('SHA-256', buffer)
  return Array.from(new Uint8Array(hash))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

export const assetStore: TLAssetStore = {
  async upload(_asset, file) {
    if (!file.type.startsWith('image/')) {
      throw new Error('Можно вставлять только изображения')
    }

    const compressed = await compressImage(file)
    if (compressed.size > MAX_SIZE) {
      throw new Error('Файл больше 10 МБ после сжатия')
    }

    const hash = await sha256(compressed)
    const name = `${hash.slice(0, 16)}.webp`

    await db.assets.put({ name, blob: compressed, pushed: false })
    return { src: PREFIX + name }
  },

  async resolve(asset) {
    const src = asset.props.src
    if (typeof src !== 'string' || !src.startsWith(PREFIX)) return null

    const name = src.slice(PREFIX.length)
    const cached = urlCache.get(name)
    if (cached) return cached

    const record = await db.assets.get(name)
    if (!record) return null

    const url = URL.createObjectURL(record.blob)
    urlCache.set(name, url)
    return url
  },

  async remove(assetIds) {
    for (const id of assetIds) {
      const name = String(id)
      const cached = urlCache.get(name)
      if (cached) {
        URL.revokeObjectURL(cached)
        urlCache.delete(name)
      }
      await db.assets.delete(name)
    }
  }
}
