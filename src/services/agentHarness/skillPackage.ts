/**
 * 标准技能包(Agent Skills 规范)的纯逻辑,照他的 skill_package_service.dart + skills.dart:
 * SKILL.md 的 YAML 头进出、路径安全、目录 / ZIP 解包、整包导出。从不执行脚本,
 * 也不把文档里的 allowed-tools 当作权限。
 *
 * 存储不在这里:资源字节落在浏览器侧的 IndexedDB(skillPackageStore.ts),
 * 这个模块不碰 DOM,校验脚本能直接在 node 里跑。
 */

import JSZip from 'jszip';
import { parse as parseYaml } from 'yaml';
import type { Skill } from './skillCatalog';

export const MAX_PACKAGE_BYTES = 32 * 1024 * 1024;
export const MAX_FILE_BYTES = 8 * 1024 * 1024;
export const MAX_FILES = 512;
export const MAX_INSTRUCTION_BYTES = 256 * 1024;

/** 标准规范:小写字母、数字与连字符,不能以连字符开头或结尾,1–64 位。 */
export const SKILL_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
/** 托管目录的随机键;技能文档里的任何路径都不会成为它。 */
export const PACKAGE_ID_PATTERN = /^pkg_[a-zA-Z0-9]+$/;

export const SKILL_ENTRY = 'SKILL.md';

export type SkillFormatErrorCode =
  | 'packageTooLarge' | 'instructionsTooLarge' | 'fileType' | 'tooManyEntries' | 'specialFile' | 'duplicatePath'
  | 'sizeLimit' | 'encrypted' | 'invalidZip' | 'oneEntry' | 'invalidId' | 'description' | 'treeConflict'
  | 'relativePath' | 'pathDepth' | 'unsafePath' | 'missingResource' | 'invalidUtf8'
  | 'yamlDelimiter' | 'yamlInvalid' | 'yamlMapping' | 'yamlDepth' | 'yamlKeys' | 'yamlValue' | 'yamlString' | 'yamlBoolean';

/** 结构化的格式错误:code 给程序分支,message 给用户和模型看。 */
export class SkillFormatError extends Error {
  readonly code: SkillFormatErrorCode;
  readonly detail: string;
  constructor(code: SkillFormatErrorCode, message: string, detail = '') {
    super(message);
    this.name = 'SkillFormatError';
    this.code = code;
    this.detail = detail;
  }
}

/** 导入预览快照:确认前只在内存里,取消不留任何东西。 */
export interface SkillPackage {
  skill: Skill;
  /** 相对技能根目录的路径 → 字节,含 SKILL.md。 */
  files: ReadonlyMap<string, Uint8Array>;
}

const encoder = new TextEncoder();
const strictDecoder = new TextDecoder('utf-8', { fatal: true });

export const encodeUtf8 = (text: string): Uint8Array => encoder.encode(text);

export function decodeUtf8Strict(bytes: Uint8Array): string {
  try {
    return strictDecoder.decode(bytes);
  } catch {
    throw new SkillFormatError('invalidUtf8', '文件不是合法的 UTF-8 文本。');
  }
}

// ---------------------------------------------------------------------------
// SKILL.md 进出
// ---------------------------------------------------------------------------

const RESERVED_KEYS = ['name', 'description', 'desc', 'label', 'display_name', 'title', 'disable-model-invocation', 'disable_model_invocation'];

/**
 * 从标准 SKILL.md 解析。`name` 是标识,`label` / `display_name` / `title` 是显示名;
 * 其余字段进 extraFrontmatter。没有 YAML 头的纯文本按旧格式兼容。
 */
export function parseSkillMd(content: string, opts: { defaultId?: string; defaultName?: string } = {}): Skill {
  const normalized = content.replace(/^﻿/, '').replace(/\r\n?/g, '\n').trimStart();
  if (!normalized.startsWith('---\n')) {
    const firstLine = normalized.trim().split('\n')[0] ?? '';
    const id = opts.defaultId || 'custom-skill';
    const name = opts.defaultName || opts.defaultId || (firstLine.startsWith('#') ? firstLine.replace(/#/g, '').trim() : 'custom-skill');
    return { id, name, description: '从文本导入的自定义技能', systemPrompt: normalized.trim() };
  }
  const rest = normalized.slice(4);
  const end = /^---[ \t]*$/m.exec(rest);
  if (!end) throw new SkillFormatError('yamlDelimiter', 'SKILL.md 的 YAML 头缺少结束分隔符。');
  const raw = rest.slice(0, end.index);
  let yaml: unknown;
  try {
    yaml = parseYaml(raw, { mapAsMap: true, maxAliasCount: 100 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new SkillFormatError('yamlInvalid', `SKILL.md YAML 格式错误:${message}`, message);
  }
  if (yaml === null || yaml === undefined) yaml = new Map();
  if (!(yaml instanceof Map)) throw new SkillFormatError('yamlMapping', 'SKILL.md 的 YAML 头必须是字段映射。');
  const fields = convertYaml(yaml) as Record<string, unknown>;
  const text = (key: string, fallback = ''): string => {
    const value = fields[key];
    if (value === null || value === undefined) return fallback;
    if (typeof value !== 'string') throw new SkillFormatError('yamlString', `SKILL.md 的 ${key} 必须是字符串。`, key);
    return value;
  };
  const id = text('name', opts.defaultId ?? 'custom-skill').trim() || (opts.defaultId ?? 'custom-skill');
  const label = text('label', text('display_name', text('title', id)));
  const description = text('description', text('desc'));
  const disabled = fields['disable-model-invocation'] ?? fields.disable_model_invocation ?? false;
  if (typeof disabled !== 'boolean') throw new SkillFormatError('yamlBoolean', 'disable-model-invocation 必须是布尔值。');
  const extra: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) if (!RESERVED_KEYS.includes(key)) extra[key] = value;
  const skill: Skill = { id, name: label, description, systemPrompt: rest.slice(end.index + end[0].length).trim() };
  if (disabled) skill.disableModelInvocation = true;
  if (Object.keys(extra).length > 0) skill.extraFrontmatter = extra;
  return skill;
}

/** YAML 值收窄成 JSON 值;字段名必须是字符串,嵌套深度与节点数封顶。 */
function convertYaml(value: unknown, state = { nodes: 0 }, depth = 0): unknown {
  if (++state.nodes > 4096 || depth > 20) throw new SkillFormatError('yamlDepth', 'SKILL.md YAML 嵌套过深或字段过多。');
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') return value;
  if (Array.isArray(value)) return value.map((v) => convertYaml(v, state, depth + 1));
  if (value instanceof Map) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of value) {
      if (typeof key !== 'string') throw new SkillFormatError('yamlKeys', 'YAML 字段名必须是字符串。');
      out[key] = convertYaml(item, state, depth + 1);
    }
    return out;
  }
  throw new SkillFormatError('yamlValue', '不支持的 YAML 值。');
}

const PLAIN_SCALAR = /^[a-zA-Z一-鿿][a-zA-Z0-9一-鿿 _/-]*$/;

/** 能裸写就裸写,否则 JSON 编码(JSON 是合法 YAML,多行与嵌套都无损)。 */
function yamlValue(value: unknown): string {
  if (typeof value === 'string' && PLAIN_SCALAR.test(value) && value.trim() === value) {
    try {
      if (parseYaml(value) === value) return value;
    } catch { /* 裸写会被 YAML 误读就走 JSON */ }
  }
  return JSON.stringify(value === undefined ? null : value);
}

/** 导出标准 SKILL.md:`name` 写标识,显示名不同才写 `label`;扩展字段原样带回。 */
export function skillToSkillMd(skill: Skill): string {
  const fields: Record<string, unknown> = { ...(skill.extraFrontmatter ?? {}), name: skill.id, description: skill.description };
  if (skill.name !== skill.id) fields.label = skill.name;
  if (skill.disableModelInvocation) fields['disable-model-invocation'] = true;
  const head = Object.entries(fields).map(([k, v]) => `${yamlValue(k)}: ${yamlValue(v)}`).join('\n');
  return `---\n${head}\n---\n\n${skill.systemPrompt.trim()}\n`;
}

// ---------------------------------------------------------------------------
// 校验
// ---------------------------------------------------------------------------

export function validateSkill(skill: Skill): void {
  if (!SKILL_ID_PATTERN.test(skill.id)) throw new SkillFormatError('invalidId', '技能标识应为 1–64 位小写字母、数字与连字符,不能以连字符开头或结尾。');
  if (!skill.description.trim() || skill.description.length > 1024) throw new SkillFormatError('description', '标准技能 description 必须为 1–1024 个字符。');
}

const DEVICE_NAME = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i;
// eslint-disable-next-line no-control-regex
const UNSAFE_CHARS = /[\x00-\x1f\x7f<>:"|?*]/;

/** 跨平台保守规则:拒绝 ../、绝对路径、反斜杠、Windows 设备名 / ADS、尾随点或空格。 */
export function validatePath(path: string): string {
  if (!path || path.includes('\\') || path.startsWith('/') || encoder.encode(path).length > 240) {
    throw new SkillFormatError('relativePath', '无效的技能包相对路径。', path);
  }
  const parts = path.split('/');
  if (parts.length > 12) throw new SkillFormatError('pathDepth', '技能包目录层级过深。', path);
  for (const part of parts) {
    if (!part || part === '.' || part === '..' || part.endsWith('.') || part.endsWith(' ') || UNSAFE_CHARS.test(part) || DEVICE_NAME.test(part)) {
      throw new SkillFormatError('unsafePath', `不安全的技能包路径:${path}`, path);
    }
  }
  return path;
}

const IGNORED_PARTS = new Set(['.git', '__MACOSX', '.DS_Store']);
const isIgnoredPath = (path: string) => path.split('/').some((part) => IGNORED_PARTS.has(part));

const posixDirname = (path: string): string => {
  const i = path.lastIndexOf('/');
  return i < 0 ? '.' : path.slice(0, i);
};
const posixBasename = (path: string): string => path.slice(path.lastIndexOf('/') + 1);

function validateFileTree(files: ReadonlyMap<string, Uint8Array>): void {
  let total = 0;
  const names = new Set<string>();
  for (const [key, bytes] of files) {
    const lower = validatePath(key).toLowerCase();
    if (names.has(lower)) throw new SkillFormatError('duplicatePath', `重复的技能文件:${key}`, key);
    names.add(lower);
    if (bytes.length > MAX_FILE_BYTES || (total += bytes.length) > MAX_PACKAGE_BYTES || files.size > MAX_FILES) {
      throw new SkillFormatError('sizeLimit', '技能包超出限制:单文件 8 MiB、总量 32 MiB、512 个文件。');
    }
  }
  for (const path of names) {
    let parent = posixDirname(path);
    while (parent !== '.') {
      if (names.has(parent)) throw new SkillFormatError('treeConflict', '技能包文件和目录路径冲突。', path);
      parent = posixDirname(parent);
    }
  }
}

export const resourcePathsOf = (files: ReadonlyMap<string, Uint8Array>): string[] => [...files.keys()].filter((k) => k !== SKILL_ENTRY).sort();

/** 落盘回来的清单逐条过路径校验,坏的丢掉。 */
export function sanitizeResourcePaths(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out = new Set<string>();
  for (const item of raw) {
    if (typeof item !== 'string' || item === SKILL_ENTRY) continue;
    try { out.add(validatePath(item)); } catch { /* 丢 */ }
  }
  return [...out].sort();
}

export const isImagePath = (path: string): boolean => /\.(png|jpe?g|webp|gif)$/i.test(path);

// ---------------------------------------------------------------------------
// 解包
// ---------------------------------------------------------------------------

/** 一组相对路径文件 → 技能包:必须恰好一个 SKILL.md,允许外层包装目录(自动剥掉)。 */
export function packageFromFiles(files: ReadonlyMap<string, Uint8Array>): SkillPackage {
  const entries = [...files.keys()].filter((key) => posixBasename(key) === SKILL_ENTRY);
  if (entries.length !== 1) throw new SkillFormatError('oneEntry', '请选择包含一个 SKILL.md 的技能目录或压缩包;多个技能请分别导入。');
  const entry = entries[0];
  const bytes = files.get(entry)!;
  if (bytes.length > MAX_INSTRUCTION_BYTES) throw new SkillFormatError('instructionsTooLarge', 'SKILL.md 不能超过 256 KiB。');
  const skill = parseSkillMd(decodeUtf8Strict(bytes), { defaultId: '' });
  validateSkill(skill);
  const prefix = entry.slice(0, entry.length - SKILL_ENTRY.length);
  const selected = new Map<string, Uint8Array>();
  for (const [key, value] of files) if (key.startsWith(prefix)) selected.set(key.slice(prefix.length), value);
  validateFileTree(selected);
  const resourcePaths = resourcePathsOf(selected);
  return { skill: resourcePaths.length ? { ...skill, resourcePaths } : skill, files: selected };
}

const extensionOf = (filename: string): string => {
  const base = posixBasename(filename.replace(/\\/g, '/'));
  const i = base.lastIndexOf('.');
  return i <= 0 ? '' : base.slice(i).toLowerCase();
};
const basenameWithoutExt = (filename: string): string => {
  const base = posixBasename(filename.replace(/\\/g, '/'));
  const i = base.lastIndexOf('.');
  return i <= 0 ? base : base.slice(0, i);
};

/** `.skill` 是 ZIP 容器的常用扩展名;单个 `.md` 继续兼容。 */
export async function decodeSkillImport(bytes: Uint8Array, filename: string): Promise<SkillPackage> {
  if (bytes.length > MAX_PACKAGE_BYTES) throw new SkillFormatError('packageTooLarge', '技能包不能超过 32 MiB。');
  const ext = extensionOf(filename);
  if (ext === '.md') {
    if (bytes.length > MAX_INSTRUCTION_BYTES) throw new SkillFormatError('instructionsTooLarge', 'SKILL.md 不能超过 256 KiB。');
    const base = basenameWithoutExt(filename);
    const skill = parseSkillMd(decodeUtf8Strict(bytes), { defaultId: base.toLowerCase() === 'skill' ? 'imported-skill' : base });
    return { skill, files: new Map([[SKILL_ENTRY, bytes]]) };
  }
  if (ext !== '.zip' && ext !== '.skill') throw new SkillFormatError('fileType', '请选择 .zip、.skill 或 .md 文件。');
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes, { checkCRC32: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/encrypted/i.test(message)) throw new SkillFormatError('encrypted', '不支持加密的技能包。');
    throw new SkillFormatError('invalidZip', '无法读取 ZIP 技能包,请检查文件是否完整。', message);
  }
  const entries = Object.values(zip.files);
  if (entries.length > MAX_FILES * 2) throw new SkillFormatError('tooManyEntries', '技能包条目过多。');
  const paths = new Set<string>();
  const files = new Map<string, Uint8Array>();
  let total = 0;
  for (const entry of entries) {
    const name = entry.name;
    const isDirectory = entry.dir || name.endsWith('/');
    const path = validatePath(isDirectory ? name.replace(/\/+$/, '') : name);
    // 只认普通文件与目录;链接与设备文件一律拒绝(unix 外部属性的高 4 位是类型)。
    const type = ((entry.unixPermissions ?? 0) as number) & 0xf000;
    if (type !== 0 && type !== 0x8000 && type !== 0x4000) throw new SkillFormatError('specialFile', '技能包不允许链接或特殊文件。', path);
    const lower = path.toLowerCase();
    if (paths.has(lower)) throw new SkillFormatError('duplicatePath', `技能包存在重复路径:${path}`, path);
    paths.add(lower);
    if (isDirectory || type === 0x4000 || isIgnoredPath(path)) continue;
    // 先看中央目录声明的大小,别等解压完才发现是炸弹;声明不可信,解压后再量一次。
    const declared = (entry as unknown as { _data?: { uncompressedSize?: unknown } })._data?.uncompressedSize;
    if (typeof declared === 'number' && (declared < 0 || declared > MAX_FILE_BYTES || total + declared > MAX_PACKAGE_BYTES)) {
      throw new SkillFormatError('sizeLimit', '技能包超出限制:单文件 8 MiB、总量 32 MiB、512 个文件。', path);
    }
    if (files.size >= MAX_FILES) throw new SkillFormatError('sizeLimit', '技能包超出限制:单文件 8 MiB、总量 32 MiB、512 个文件。', path);
    let content: Uint8Array;
    try {
      content = await entry.async('uint8array');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/encrypted/i.test(message)) throw new SkillFormatError('encrypted', '不支持加密的技能包。', path);
      throw new SkillFormatError('invalidZip', `技能包里的 ${path} 解压失败(${message})。`, path);
    }
    if (content.length > MAX_FILE_BYTES || (total += content.length) > MAX_PACKAGE_BYTES) {
      throw new SkillFormatError('sizeLimit', '技能包超出限制:单文件 8 MiB、总量 32 MiB、512 个文件。', path);
    }
    files.set(path, content);
  }
  return packageFromFiles(files);
}

/** 文件夹选择器给的一组文件(路径含顶层目录名);读字节前先按声明大小拦。 */
export interface DirectoryFileEntry {
  path: string;
  size: number;
  read: () => Promise<Uint8Array>;
}

export async function decodeSkillDirectory(entries: readonly DirectoryFileEntry[]): Promise<SkillPackage> {
  if (entries.length > MAX_FILES * 2) throw new SkillFormatError('tooManyEntries', '技能包条目过多。');
  const seen = new Set<string>();
  const files = new Map<string, Uint8Array>();
  let total = 0;
  for (const entry of entries) {
    const path = validatePath(entry.path.replace(/\\/g, '/'));
    if (isIgnoredPath(path)) continue;
    const lower = path.toLowerCase();
    if (seen.has(lower)) throw new SkillFormatError('duplicatePath', `技能包存在重复路径:${path}`, path);
    seen.add(lower);
    if (entry.size > MAX_FILE_BYTES || (total += entry.size) > MAX_PACKAGE_BYTES || files.size >= MAX_FILES) {
      throw new SkillFormatError('sizeLimit', '技能包超出限制:单文件 8 MiB、总量 32 MiB、512 个文件。', path);
    }
    const bytes = await entry.read();
    if (bytes.length > MAX_FILE_BYTES) throw new SkillFormatError('sizeLimit', '技能包超出限制:单文件 8 MiB、总量 32 MiB、512 个文件。', path);
    files.set(path, bytes);
  }
  return packageFromFiles(files);
}

// ---------------------------------------------------------------------------
// 安装前的整理与导出
// ---------------------------------------------------------------------------

/** 用编辑后的技能替换包里的 SKILL.md,给存储层的就是这份;校验放在存储之前。 */
export function prepareInstall(pkg: SkillPackage, edited: Skill): { skill: Skill; files: Map<string, Uint8Array> } {
  validateSkill(edited);
  const files = new Map(pkg.files);
  const md = encodeUtf8(skillToSkillMd(edited));
  if (md.length > MAX_INSTRUCTION_BYTES) throw new SkillFormatError('instructionsTooLarge', 'SKILL.md 不能超过 256 KiB。');
  files.set(SKILL_ENTRY, md);
  validateFileTree(files);
  const resourcePaths = resourcePathsOf(files);
  const skill: Skill = { ...edited };
  if (resourcePaths.length) skill.resourcePaths = resourcePaths; else delete skill.resourcePaths;
  return { skill, files };
}

/** 整包导出:最新 SKILL.md + 托管资源字节,外层一个技能名目录。旧版自由命名的技能也能导出。 */
export async function encodeSkillPackage(skill: Skill, readResource: (path: string) => Promise<Uint8Array>): Promise<Uint8Array> {
  const files = new Map<string, Uint8Array>([[SKILL_ENTRY, encodeUtf8(skillToSkillMd(skill))]]);
  for (const path of skill.resourcePaths ?? []) files.set(validatePath(path), await readResource(path));
  validateFileTree(files);
  const folder = SKILL_ID_PATTERN.test(skill.id) ? skill.id : 'skill';
  const zip = new JSZip();
  for (const [path, bytes] of files) zip.file(`${folder}/${path}`, bytes, { date: new Date(0) });
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
}
