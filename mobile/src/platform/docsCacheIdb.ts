import { memoryDocsStorage, type DocsCacheMeta, type DocsCacheStorage } from '../protocol/docsCache';

/**
 * Хранилище кэша документации в IndexedDB (TASK-140.17): записи без текста (`meta`) и тексты (`body`) — в разных
 * таблицах, чтобы учёт объёма при запуске не читал все тексты. Где IndexedDB нет или он недоступен (приватный режим,
 * запрет хранилища), кэш живёт в памяти до закрытия приложения. Секретов здесь нет — только тексты документации.
 */

const DB_NAME = 'ph_mobile_docs';
const DB_VERSION = 1;
const META = 'meta';
const BODY = 'body';

function promisify<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
}

function openDb(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = factory.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(META)) db.createObjectStore(META, { keyPath: 'key' });
      if (!db.objectStoreNames.contains(BODY)) db.createObjectStore(BODY);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'));
    req.onblocked = () => reject(new Error('IndexedDB blocked'));
  });
}

function idbStorage(db: IDBDatabase): DocsCacheStorage {
  return {
    async listMeta() {
      const tx = db.transaction(META, 'readonly');
      return (await promisify(tx.objectStore(META).getAll())) as DocsCacheMeta[];
    },
    async getContent(key) {
      const tx = db.transaction(BODY, 'readonly');
      const value = await promisify(tx.objectStore(BODY).get(key));
      return typeof value === 'string' ? value : null;
    },
    async put(meta, content) {
      const tx = db.transaction([META, BODY], 'readwrite');
      tx.objectStore(BODY).put(content, meta.key);
      tx.objectStore(META).put(meta);
      await done(tx);
    },
    async putMeta(meta) {
      const tx = db.transaction(META, 'readwrite');
      tx.objectStore(META).put(meta);
      await done(tx);
    },
    async remove(keys) {
      if (keys.length === 0) return;
      const tx = db.transaction([META, BODY], 'readwrite');
      for (const key of keys) {
        tx.objectStore(META).delete(key);
        tx.objectStore(BODY).delete(key);
      }
      await done(tx);
    }
  };
}

/**
 * Хранилище с переходом в память: IndexedDB открывается при первом обращении, а если не открылся — все операции
 * идут в память. Ошибка отдельной операции IndexedDB уходит в `DocsCache`, который считает её промахом кэша.
 */
export function createDocsCacheStorage(): DocsCacheStorage {
  let backend: Promise<DocsCacheStorage> | null = null;
  const resolve = (): Promise<DocsCacheStorage> => {
    if (!backend) {
      backend = (async () => {
        try {
          const factory = globalThis.indexedDB;
          if (!factory) return memoryDocsStorage();
          return idbStorage(await openDb(factory));
        } catch {
          return memoryDocsStorage();
        }
      })();
    }
    return backend;
  };
  return {
    listMeta: async () => (await resolve()).listMeta(),
    getContent: async (key) => (await resolve()).getContent(key),
    put: async (meta, content) => (await resolve()).put(meta, content),
    putMeta: async (meta) => (await resolve()).putMeta(meta),
    remove: async (keys) => (await resolve()).remove(keys)
  };
}
