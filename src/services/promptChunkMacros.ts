/**
 * Prompt Chunks(官方叫「片段」,内部叫 macro)的文本契约。
 *
 * 官方前端(module 37400,2026-09-04 从线上 bundle 抄下来的)定了这几条,这里逐条照抄:
 *
 * - 触发符是 `@`:在提示词里打 `@` 弹出片段列表,边打边过滤。
 * - 编辑器内部引用形如 `⌜macro:<id>⌟`(按 id 找);用户手写的嵌套引用形如
 *   `!macro:<label>!`(按 **label** 找,**区分大小写**,两端空白会 trim)。
 * - 展开是递归的:先把 id 引用换成正文,再对 label 引用递归展开;沿当前展开路径
 *   再次遇到同名 → 循环引用,该处替换成空串并记下来;找不到的名字 → 也替换成空串
 *   并记下来。**没有深度上限**,只有循环检测。
 * - 导入图片时官方会把提示词里与某片段正文相同的子串反向折叠回引用
 *   (按展开后长度从长到短逐个 `split/join`,纯子串匹配,不看逗号边界)。
 *
 * 文档另外说明:片段**不进元数据**,进的是展开后的正文;发送前会把重复的逗号去掉;
 * 片段正文里出现单个 `|` 会触发多角色分块、数字权重没闭合会出问题——这两条做成 lint。
 *
 * ⚠ 官方把片段存在账号侧的 `/user/objects/promptmacros`,但每条都用 **keystore**
 * (登录密码派生的密钥,libsodium secretbox)加密。sidecar 只有持久 access token,
 * 拿不到 keystore,所以这里只做本地库,不做云端同步;这不是漏做,是做不了。
 */

export const PROMPT_CHUNK_TRIGGER = '@';

const ID_REF_OPEN = '⌜' + 'macro:';
const ID_REF_CLOSE = '⌟';
const ID_REF_PATTERN = /⌜macro:([^⌟]+)⌟/g;
const LABEL_REF_PATTERN = /!macro:([^!]+)!/g;

/** 展开只需要这三个字段;存储层的完整记录见 localLibrary/promptChunks。 */
export interface PromptChunkLike {
  id: string;
  label: string;
  expansion: string;
}

export interface PromptChunkExpansion {
  text: string;
  /** 引用了但库里没有的名字(官方:替换成空串并提示「Missing macros removed」)。 */
  missing: string[];
  /** 循环引用的名字(官方:替换成空串并提示「Circular macro reference detected」)。 */
  circular: string[];
}

/** 用户可见的引用写法。 */
export function chunkReference(label: string): string {
  return `!macro:${label}!`;
}

/** 编辑器内部的 id 引用写法(官方 ProseMirror 节点序列化用的那种)。 */
export function chunkIdReference(id: string): string {
  return `${ID_REF_OPEN}${id}${ID_REF_CLOSE}`;
}

/** 一枚芯片是不是整个就是一条片段引用;是就给出 label。 */
export function parseChunkReference(text: string): string | null {
  const match = /^!macro:([^!]+)!$/.exec(text.trim());
  return match ? match[1].trim() : null;
}

function hasChunkReference(text: string): boolean {
  return text.includes('!macro:') || text.includes(ID_REF_OPEN);
}

function expandLabelRefs(
  text: string,
  byLabel: ReadonlyMap<string, PromptChunkLike>,
  path: ReadonlySet<string>,
  missing: Set<string>,
  circular: Set<string>,
): string {
  return text.replace(LABEL_REF_PATTERN, (whole, rawLabel: string) => {
    void whole;
    const label = rawLabel.trim();
    if (path.has(label)) {
      circular.add(label);
      return '';
    }
    const chunk = byLabel.get(label);
    if (!chunk) {
      missing.add(label);
      return '';
    }
    const nextPath = new Set(path);
    nextPath.add(label);
    return expandLabelRefs(chunk.expansion, byLabel, nextPath, missing, circular);
  });
}

/**
 * 把提示词里的片段引用展开成正文。与官方 `u`/`h` 逐条一致:
 * id 引用先换(认不出的 id 原样保留),label 引用再递归换(认不出的 label 变空串)。
 */
export function expandPromptChunks(
  text: string,
  chunks: readonly PromptChunkLike[],
): PromptChunkExpansion {
  if (!hasChunkReference(text)) return { text, missing: [], circular: [] };
  const byId = new Map(chunks.map((chunk) => [chunk.id, chunk]));
  const byLabel = new Map(chunks.map((chunk) => [chunk.label, chunk]));
  const missing = new Set<string>();
  const circular = new Set<string>();
  const afterIds = text.replace(ID_REF_PATTERN, (whole, id: string) => byId.get(id)?.expansion ?? whole);
  const expanded = expandLabelRefs(afterIds, byLabel, new Set(), missing, circular);
  return { text: expanded, missing: [...missing], circular: [...circular] };
}

/**
 * 发送前用的收口:展开 + 去重复逗号。
 *
 * 文档说「重复的逗号会在生成前自动去掉」,官方那段正则没在 bundle 里定位到,这里
 * 只做最保守的一步——连着的逗号并成一个。**只在真的发生过展开时才碰文本**,
 * 没有引用的提示词逐字节不变,免得影响那些钉死了字面串的校验。
 */
export function expandPromptChunksForSend(
  text: string,
  chunks: readonly PromptChunkLike[],
): PromptChunkExpansion {
  const result = expandPromptChunks(text, chunks);
  if (result.text === text) return result;
  return { ...result, text: collapseDuplicateCommas(result.text) };
}

export function collapseDuplicateCommas(text: string): string {
  return text
    .replace(/\s*,(?:\s*,)+\s*/g, ', ')
    .replace(/^\s*,\s*/, '')
    .replace(/\s*,\s*$/, '');
}

/**
 * 反向折叠(导入用):把与片段正文相同的子串换回引用。照官方 `f`:先把每条片段
 * 自己展开(静默),按展开后长度从长到短,纯子串 `split/join`。
 * 官方折成 id 引用给它的编辑器节点用;我们的芯片承载的是 label 形式,所以默认折成
 * `!macro:label!`。
 */
export function collapsePromptChunks(
  text: string,
  chunks: readonly PromptChunkLike[],
  form: 'label' | 'id' = 'label',
): string {
  if (chunks.length === 0) return text;
  const entries = chunks
    .map((chunk) => ({ chunk, resolved: expandPromptChunks(chunk.expansion, chunks).text }))
    .filter((entry) => entry.resolved.length > 0)
    .sort((a, b) => b.resolved.length - a.resolved.length);
  let out = text;
  for (const { chunk, resolved } of entries) {
    const ref = form === 'id' ? chunkIdReference(chunk.id) : chunkReference(chunk.label);
    out = out.split(resolved).join(ref);
  }
  return out;
}

/** 输入尾部是不是一个 `@` 查询;是就给出 `@` 的位置和它后面的查询串。 */
export function findPromptChunkQuery(text: string): { start: number; query: string } | null {
  const match = /(^|[\s,，|])@([\p{L}\p{N}_ '"\-./()]*)$/u.exec(text);
  if (!match) return null;
  return { start: match.index + match[1].length, query: match[2] };
}

/** `@` 列表的过滤:不分大小写,前缀命中排在包含命中前面,空查询给全部。 */
export function filterPromptChunks<T extends PromptChunkLike>(chunks: readonly T[], query: string): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...chunks];
  const prefix: T[] = [];
  const contains: T[] = [];
  for (const chunk of chunks) {
    const label = chunk.label.toLowerCase();
    if (label.startsWith(q)) prefix.push(chunk);
    else if (label.includes(q) || chunk.expansion.toLowerCase().includes(q)) contains.push(chunk);
  }
  return [...prefix, ...contains];
}

export interface PromptChunkLint {
  level: 'error' | 'warning';
  message: string;
}

/**
 * 片段能不能用、用了会不会出事。前两条是硬错(引用语法本身就写不出来),
 * 后两条是文档点名的坑。
 */
export function lintPromptChunk(label: string, expansion: string): PromptChunkLint[] {
  const lints: PromptChunkLint[] = [];
  const trimmedLabel = label.trim();
  if (!trimmedLabel) lints.push({ level: 'error', message: '名字不能为空' });
  if (trimmedLabel.includes('!')) lints.push({ level: 'error', message: '名字里不能有 `!`,那是引用的定界符' });
  if (/(^|[^|])\|(?!\|)/.test(expansion)) {
    lints.push({ level: 'warning', message: '正文里有单个 `|`,插进提示词会触发多角色分块' });
  }
  const weightMarks = (expansion.match(/::/g) ?? []).length;
  if (weightMarks % 2 === 1) {
    lints.push({ level: 'warning', message: '数字权重 `N::…::` 没闭合,会把后面的内容一起吃掉' });
  }
  return lints;
}
