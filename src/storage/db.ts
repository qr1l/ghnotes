import Dexie, { type EntityTable } from 'dexie'

// Локальное хранилище конспектов и картинок на Dexie (IndexedDB).
// Всё работает без интернета; синхронизация с GitHub добавляется на этапе 2c.

export interface TopicRecord {
  // Название темы — первичный ключ.
  name: string
  createdAt: string
}

export interface NoteRecord {
  // Уникальный путь вида "<тема>/<конспект>" — первичный ключ.
  path: string
  topic: string
  title: string
  // Содержимое note.json: { format, title, createdAt, updatedAt, snapshot }.
  data: NoteData
  // Локальная сессия tldraw (камера, текущий лист) — на GitHub не отправляется.
  session: unknown
  // SHA файла note.json на момент последней синхронизации (null — ещё не отправлялся).
  baseSha: string | null
  // Есть ли неотправленные правки.
  dirty: boolean
  updatedAt: string
}

export interface NoteData {
  format: number
  title: string
  createdAt: string
  updatedAt: string
  snapshot: unknown
}

export interface AssetRecord {
  // Имя файла: первые 16 символов SHA-256 + ".webp".
  name: string
  blob: Blob
  // Была ли картинка уже отправлена в GitHub.
  pushed: boolean
}

class NotesDB extends Dexie {
  topics!: EntityTable<TopicRecord, 'name'>
  notes!: EntityTable<NoteRecord, 'path'>
  assets!: EntityTable<AssetRecord, 'name'>

  constructor() {
    super('ghnotes')
    this.version(1).stores({
      notes: 'path, topic, updatedAt',
      assets: 'name'
    })
    this.version(2).stores({
      topics: 'name, createdAt',
      notes: 'path, topic, updatedAt',
      assets: 'name'
    })
  }
}

export const db = new NotesDB()
