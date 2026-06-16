import { SETTINGS_STORE, openLocalLibraryDB } from './idb';
import { deleteRecord } from './records';
import { type FileSystemDirectoryHandle } from '../../utils/fileSystem';

export const saveDirectoryHandle = async (handle: FileSystemDirectoryHandle): Promise<void> => {
  const db = await openLocalLibraryDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction([SETTINGS_STORE], 'readwrite');
    const store = transaction.objectStore(SETTINGS_STORE);
    const request = store.put(handle, 'localDirectoryHandle');

    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
};

export const getDirectoryHandle = async (): Promise<FileSystemDirectoryHandle | null> => {
  const db = await openLocalLibraryDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction([SETTINGS_STORE], 'readonly');
    const store = transaction.objectStore(SETTINGS_STORE);
    const request = store.get('localDirectoryHandle');

    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  });
};

export const deleteDirectoryHandle = async (): Promise<void> => {
  return deleteRecord(SETTINGS_STORE, 'localDirectoryHandle');
};

export interface LinkedFolder {
  handle: FileSystemDirectoryHandle;
  name: string;
}

export const saveLinkedFolders = async (folders: LinkedFolder[]): Promise<void> => {
  const db = await openLocalLibraryDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction([SETTINGS_STORE], 'readwrite');
    const store = transaction.objectStore(SETTINGS_STORE);
    const request = store.put(folders, 'linkedVibeFolders');
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
};

export const getLinkedFolders = async (): Promise<LinkedFolder[]> => {
  const db = await openLocalLibraryDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction([SETTINGS_STORE], 'readonly');
    const store = transaction.objectStore(SETTINGS_STORE);
    const request = store.get('linkedVibeFolders');
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  });
};

export const addLinkedFolder = async (folder: LinkedFolder): Promise<void> => {
  const folders = await getLinkedFolders();
  if (!folders.some(f => f.name === folder.name)) {
    folders.push(folder);
    await saveLinkedFolders(folders);
  }
};

export const removeLinkedFolder = async (folderName: string): Promise<void> => {
  const folders = await getLinkedFolders();
  await saveLinkedFolders(folders.filter(f => f.name !== folderName));
};
