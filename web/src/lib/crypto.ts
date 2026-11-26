const DB_NAME = 'student-status-board'
const DB_VERSION = 1
const STORE_NAME = 'crypto'
const KEY_ID = 'llm-aes-key'
const STORAGE_KEY = 'ssb.llm.settings'

export interface StoredSecret {
  v: 1
  iv: string
  data: string
}

export interface StoredLlmSettings {
  baseUrl: string
  model: string
  secret: StoredSecret | null
  updatedAt: number
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME)
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('无法打开本地加密存储'))
  })
}

async function readKey(): Promise<CryptoKey | null> {
  const db = await openDatabase()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly')
    const store = tx.objectStore(STORE_NAME)
    const req = store.get(KEY_ID)
    req.onsuccess = () => resolve((req.result as CryptoKey | undefined) ?? null)
    req.onerror = () => reject(req.error ?? new Error('读取加密密钥失败'))
    tx.oncomplete = () => db.close()
  })
}

async function writeKey(key: CryptoKey): Promise<void> {
  const db = await openDatabase()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite')
    tx.objectStore(STORE_NAME).put(key, KEY_ID)
    tx.oncomplete = () => {
      db.close()
      resolve()
    }
    tx.onerror = () => reject(tx.error ?? new Error('保存加密密钥失败'))
  })
}

/** 获取（或首次生成）不可导出的 AES-GCM 密钥，密钥本身保存在 IndexedDB。 */
export async function getOrCreateCryptoKey(): Promise<CryptoKey> {
  const existing = await readKey()
  if (existing) return existing
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
    'encrypt',
    'decrypt',
  ])
  await writeKey(key)
  return key
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return bytes
}

export async function encryptText(plain: string): Promise<StoredSecret> {
  const key = await getOrCreateCryptoKey()
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const encoded = new TextEncoder().encode(plain)
  const cipher = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv.buffer as ArrayBuffer },
    key,
    encoded.buffer as ArrayBuffer,
  )
  return {
    v: 1,
    iv: bytesToBase64(iv),
    data: bytesToBase64(new Uint8Array(cipher)),
  }
}

export async function decryptText(secret: StoredSecret): Promise<string> {
  const key = await getOrCreateCryptoKey()
  const iv = base64ToBytes(secret.iv)
  const data = base64ToBytes(secret.data)
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: iv.buffer as ArrayBuffer },
    key,
    data.buffer as ArrayBuffer,
  )
  return new TextDecoder().decode(plain)
}

export function readStoredSettings(): StoredLlmSettings | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<StoredLlmSettings>
    return {
      baseUrl: typeof parsed.baseUrl === 'string' ? parsed.baseUrl : '',
      model: typeof parsed.model === 'string' ? parsed.model : '',
      secret: parsed.secret && typeof parsed.secret === 'object' ? (parsed.secret as StoredSecret) : null,
      updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : 0,
    }
  } catch {
    return null
  }
}

export function writeStoredSettings(settings: StoredLlmSettings): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
}

export function clearStoredSecret(): void {
  const current = readStoredSettings()
  if (current) {
    writeStoredSettings({ ...current, secret: null, updatedAt: Date.now() })
  }
}
