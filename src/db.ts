const DB_NAME = "siteclass";
const STORE_NAME = "blobs";
const DB_VERSION = 1;
const MAX_CACHED_URLS = 120;

const urlCache = new Map<string, string>();
let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME);
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onclose = () => { dbPromise = null; };
      db.onversionchange = () => { db.close(); dbPromise = null; };
      resolve(db);
    };
    req.onerror = () => { dbPromise = null; reject(req.error); };
  });
  return dbPromise;
}

function cacheUrl(key: string, url: string): void {
  if (urlCache.has(key)) return;
  urlCache.set(key, url);
  while (urlCache.size > MAX_CACHED_URLS) {
    const oldestKey = urlCache.keys().next().value;
    if (!oldestKey) break;
    const oldestUrl = urlCache.get(oldestKey);
    if (oldestUrl) URL.revokeObjectURL(oldestUrl);
    urlCache.delete(oldestKey);
  }
}

export function revokeCachedBlobUrl(key: string): void {
  const existing = urlCache.get(key);
  if (existing) {
    URL.revokeObjectURL(existing);
    urlCache.delete(key);
  }
}

export async function putBlob(key: string, blob: Blob): Promise<void> {
  try { await writeBlob(key, blob); } catch { dbPromise = null; await writeBlob(key, blob); }
}

async function writeBlob(key: string, blob: Blob): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(() => { dbPromise = null; reject(new Error("IndexedDB write timed out")); }, 15000);
    try {
      const tx = db.transaction(STORE_NAME, "readwrite");
      tx.oncomplete = () => { window.clearTimeout(timer); resolve(); };
      tx.onerror = tx.onabort = () => { window.clearTimeout(timer); reject(tx.error ?? new Error("IndexedDB write failed")); };
      tx.objectStore(STORE_NAME).put(blob, key);
    } catch (err) { window.clearTimeout(timer); dbPromise = null; reject(err); }
  });
  revokeCachedBlobUrl(key);
}

export async function getBlob(key: string): Promise<Blob | undefined> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    try {
      const tx = db.transaction(STORE_NAME, "readonly");
      const req = tx.objectStore(STORE_NAME).get(key);
      req.onsuccess = () => resolve(req.result as Blob | undefined);
      req.onerror = () => reject(req.error);
    } catch (err) { dbPromise = null; reject(err); }
  });
}

export async function deleteBlob(key: string): Promise<void> {
  revokeCachedBlobUrl(key);
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    try {
      const tx = db.transaction(STORE_NAME, "readwrite");
      tx.oncomplete = () => resolve();
      tx.onerror = tx.onabort = () => reject(tx.error ?? new Error("IndexedDB delete failed"));
      tx.objectStore(STORE_NAME).delete(key);
    } catch (err) { dbPromise = null; reject(err); }
  });
}

export async function deleteBlobs(keys: string[]): Promise<void> {
  const BATCH = 10;
  for (let i = 0; i < keys.length; i += BATCH) {
    await Promise.all(keys.slice(i, i + BATCH).map((k) => deleteBlob(k)));
  }
}

export function thumbKey(photoId: string): string { return `${photoId}:t`; }

export async function getOrCreateThumbUrl(photoId: string): Promise<string | null> {
  const tKey = thumbKey(photoId);
  const cached = urlCache.get(tKey) ?? urlCache.get(photoId);
  if (cached) return cached;
  let blob = await getBlob(tKey);
  let usedKey = tKey;
  if (!blob) { blob = await getBlob(photoId); usedKey = photoId; }
  if (!blob) return null;
  const url = URL.createObjectURL(blob);
  cacheUrl(usedKey, url);
  return url;
}
