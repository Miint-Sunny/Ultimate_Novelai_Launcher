export const DB_NAME = 'NovelAI_Web_UI_DB';
export const STORE_NAME = 'vibes';
export const DB_VERSION = 8;
export const SETTINGS_STORE = 'settings';
export const OC_STORE = 'oc_files';
export const ARTIST_STORE = 'artist_files';
export const CR_STORE = 'cr_files';
export const IMAGE_HISTORY_STORE = 'image_history';
export const CUSTOM_TAG_STORE = 'custom_tag_files';
export const PROMPT_CHUNK_STORE = 'prompt_chunk_files';

const REQUIRED_STORES = [
  STORE_NAME,
  SETTINGS_STORE,
  OC_STORE,
  ARTIST_STORE,
  CR_STORE,
  IMAGE_HISTORY_STORE,
  CUSTOM_TAG_STORE,
  PROMPT_CHUNK_STORE,
];

function createMissingStores(db: IDBDatabase): void {
  if (!db.objectStoreNames.contains(STORE_NAME)) {
    db.createObjectStore(STORE_NAME, { keyPath: 'id' });
  }
  if (!db.objectStoreNames.contains(SETTINGS_STORE)) {
    db.createObjectStore(SETTINGS_STORE);
  }
  if (!db.objectStoreNames.contains(OC_STORE)) {
    db.createObjectStore(OC_STORE, { keyPath: 'id' });
  }
  if (!db.objectStoreNames.contains(ARTIST_STORE)) {
    db.createObjectStore(ARTIST_STORE, { keyPath: 'id' });
  }
  if (!db.objectStoreNames.contains(CR_STORE)) {
    db.createObjectStore(CR_STORE, { keyPath: 'id' });
  }
  if (!db.objectStoreNames.contains(IMAGE_HISTORY_STORE)) {
    db.createObjectStore(IMAGE_HISTORY_STORE, { keyPath: 'id' });
  }
  if (!db.objectStoreNames.contains(CUSTOM_TAG_STORE)) {
    db.createObjectStore(CUSTOM_TAG_STORE, { keyPath: 'id' });
  }
  if (!db.objectStoreNames.contains(PROMPT_CHUNK_STORE)) {
    db.createObjectStore(PROMPT_CHUNK_STORE, { keyPath: 'id' });
  }
}

export const openLocalLibraryDB = (): Promise<IDBDatabase> => {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onerror = (event) => {
      reject('Database error: ' + (event.target as IDBOpenDBRequest).error);
    };

    request.onsuccess = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      const missingStores = REQUIRED_STORES.filter(
        (store) => !db.objectStoreNames.contains(store)
      );
      if (missingStores.length > 0) {
        db.close();
        const deleteRequest = indexedDB.deleteDatabase(DB_NAME);
        deleteRequest.onsuccess = () => {
          openLocalLibraryDB().then(resolve).catch(reject);
        };
        deleteRequest.onerror = () => {
          reject('Failed to delete old database');
        };
      } else {
        resolve(db);
      }
    };

    request.onupgradeneeded = (event) => {
      createMissingStores((event.target as IDBOpenDBRequest).result);
    };
  });
};
