/**
 * 技能包资源的托管存储:一个独立的小 IndexedDB,键是「包键/相对路径」。
 * 不进 localLibrary 那个共享库(它的版本号一变就整库重建),也不把字节塞进 localStorage
 * (预设库 JSON 只记 packageId 与清单)。取消导入不落盘;删技能时只清托管副本,从不碰用户的源文件。
 */

import { PACKAGE_ID_PATTERN, SkillFormatError, validatePath } from '../../../../services/agentHarness/skillPackage';

const DB_NAME = 'ultimate_novelai_launcher_skill_packages';
const STORE = 'files';
const VERSION = 1;

interface StoredFile {
  key: string;
  packageId: string;
  path: string;
  bytes: Uint8Array;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  if (typeof indexedDB === 'undefined') return Promise.reject(new Error('当前环境没有 IndexedDB,无法保存技能包资源。'));
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'key' });
      };
      request.onsuccess = () => {
        const db = request.result;
        // 别的标签页升级 / 删库时让出连接,下次重新打开。
        db.onversionchange = () => { db.close(); dbPromise = null; };
        resolve(db);
      };
      request.onerror = () => { dbPromise = null; reject(request.error ?? new Error('打开技能包存储失败')); };
      request.onblocked = () => { dbPromise = null; reject(new Error('技能包存储被其他标签页占用')); };
    });
  }
  return dbPromise;
}

const done = (tx: IDBTransaction): Promise<void> => new Promise((resolve, reject) => {
  tx.oncomplete = () => resolve();
  tx.onerror = () => reject(tx.error ?? new Error('技能包存储事务失败'));
  tx.onabort = () => reject(tx.error ?? new Error('技能包存储事务中止'));
});

const requestResult = <T>(request: IDBRequest<T>): Promise<T> => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error ?? new Error('技能包存储读取失败'));
});

export function newPackageId(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return `pkg_${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

function assertPackageId(packageId: string): void {
  if (!PACKAGE_ID_PATTERN.test(packageId)) throw new SkillFormatError('missingResource', '无效的技能存储标识。', packageId);
}

/** 整包一个事务写入,随机分配包键;失败什么都不留。返回包键。 */
export async function installSkillPackage(files: ReadonlyMap<string, Uint8Array>): Promise<string> {
  const packageId = newPackageId();
  const db = await open();
  const tx = db.transaction(STORE, 'readwrite');
  const store = tx.objectStore(STORE);
  for (const [path, bytes] of files) {
    const record: StoredFile = { key: `${packageId}/${validatePath(path)}`, packageId, path, bytes };
    store.put(record);
  }
  await done(tx);
  return packageId;
}

export async function readSkillPackageFile(packageId: string, path: string): Promise<Uint8Array> {
  assertPackageId(packageId);
  validatePath(path);
  const db = await open();
  const record = await requestResult(db.transaction(STORE, 'readonly').objectStore(STORE).get(`${packageId}/${path}`)) as StoredFile | undefined;
  if (!record || !(record.bytes instanceof Uint8Array)) throw new SkillFormatError('missingResource', '技能包文件缺失,请重新导入。', path);
  return record.bytes;
}

/** 删掉一个包的全部文件;包不存在也算成功。 */
export async function deleteSkillPackage(packageId: string): Promise<void> {
  assertPackageId(packageId);
  const db = await open();
  const tx = db.transaction(STORE, 'readwrite');
  tx.objectStore(STORE).delete(IDBKeyRange.bound(`${packageId}/`, `${packageId}/￿`));
  await done(tx);
}
