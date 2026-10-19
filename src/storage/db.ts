import Dexie, { type EntityTable } from 'dexie'

// Локальное хранилище конспектов и картинок на Dexie (IndexedDB).
// Всё работает без интернета; синхронизация с GitHub добавляется на этапе 2c.

export interface NoteRecord {
  // Уникальный путь вида "<тема>/<конспект>" — первичный ключ.
  path: string
  topic: string
  title: string
  // Содержимое note.json: { format, title, createdAt, updatedAt, snapshot }.
  data: NoteData
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
  notes!: EntityTable<NoteRecord, 'path'>
  assets!: EntityTable<AssetRecord, 'name'>

  constructor() {
    super('ghnotes')
    this.version(1).stores({
      // Индексы: path (PK), topic, updatedAt — для списка по темам и сортировки.
      notes: 'path, topic, updatedAt',
      assets: 'name'
    })
  }
}

export const db = new NotesDB()
