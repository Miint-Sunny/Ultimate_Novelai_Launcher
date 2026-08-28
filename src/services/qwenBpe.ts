// NovelAI V5 的提示词 token 计数引擎(Qwen 3.5 文本编码器口径)——纯逻辑,无 DOM/Node 依赖,
// node --experimental-strip-types 可直接加载(check-v5-parity 第 6 段吃的就是这个模块)。
//
// 方案移植自 MIT 协议的 Aaalice_NAI_Launcher(reference_repos/Aaalice_NAI_Launcher,
// lib/core/services/tokenizers/qwen_prompt_token_encoder.dart),与 NovelAI 官方前端一致:
//   NFC 归一化 → special token 切段(每段计 1) → splitRegex 全匹配切片 →
//   每片转 UTF-8 字节并映射成可见字符(GPT-2 式) → 在字节字符上按 merge 顺序做 BPE 合并,
//   数合并后剩下的段数。
//
// 计数不需要 token id,所以资产只保留 merge 顺序(约 1.3MB gzip,生成方式见
// scripts/build-qwen-tokenizer-asset.mjs),不要换成完整 tokenizer.json。

/** 解析后的 Qwen BPE 计数资产。RegExp 带 g 旗标但 matchAll 内部会克隆,共享安全。 */
export interface QwenBpeAsset {
  readonly splitRegex: RegExp;
  readonly ranks: Map<string, number>;
  readonly specialPattern: RegExp | null;
  readonly normalizeNfc: boolean;
}

// GPT-2 系列的字节到可见字符映射:先占用本身可打印的字节,
// 其余(空格、控制字符等)顺序映射到 U+0100 之后。merges 资产就在这套映射空间里,
// 运行时必须用同一张表,否则 join 出的 "left right" 查不到 rank。
const BYTE_ENCODER: readonly string[] = buildByteEncoder();

function buildByteEncoder(): string[] {
  const table: (string | undefined)[] = new Array(256);
  const markDirect = (from: number, to: number): void => {
    for (let byte = from; byte <= to; byte++) table[byte] = String.fromCharCode(byte);
  };
  markDirect(0x21, 0x7e);
  markDirect(0xa1, 0xac);
  markDirect(0xae, 0xff);
  let next = 256;
  for (let byte = 0; byte < 256; byte++) {
    if (table[byte] === undefined) table[byte] = String.fromCharCode(next++);
  }
  return table as string[];
}

const textEncoder = new TextEncoder();

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 解析 merge-only 资产文本:第一行 JSON 头(splitRegex / normalization / specialTokens),
 * 其余每行一条 merge("left right"),行序即 rank。计数只依赖相对顺序,不依赖具体数值。
 */
export function parseQwenBpeAsset(assetText: string): QwenBpeAsset {
  const newline = assetText.indexOf('\n');
  const headerLine = newline === -1 ? assetText : assetText.slice(0, newline);
  let header: { splitRegex?: unknown; normalization?: unknown; specialTokens?: unknown };
  try {
    header = JSON.parse(headerLine);
  } catch (error) {
    throw new Error('Qwen tokenizer asset header is not valid JSON');
  }
  if (typeof header.splitRegex !== 'string' || header.splitRegex.length === 0) {
    throw new Error('Qwen tokenizer asset is missing splitRegex');
  }
  const ranks = new Map<string, number>();
  let rank = 0;
  const body = newline === -1 ? '' : assetText.slice(newline + 1);
  for (const rawLine of body.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (!line) continue;
    ranks.set(line, rank++);
  }
  if (ranks.size === 0) {
    throw new Error('Qwen tokenizer asset contains no merges');
  }
  const specialTokens = (Array.isArray(header.specialTokens) ? header.specialTokens : [])
    .filter((token): token is string => typeof token === 'string')
    // 长的优先,避免较短的特殊标记先匹配吃掉前缀。
    .sort((a, b) => b.length - a.length);
  return {
    splitRegex: new RegExp(header.splitRegex, 'ug'),
    ranks,
    specialPattern: specialTokens.length
      ? new RegExp(specialTokens.map(escapeRegExp).join('|'), 'ug')
      : null,
    normalizeNfc: header.normalization === 'NFC',
  };
}

interface TextSegment {
  text: string;
  special: boolean;
}

function* splitSpecialTokens(text: string, pattern: RegExp | null): Generator<TextSegment> {
  if (pattern === null) {
    yield { text, special: false };
    return;
  }
  let cursor = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index > cursor) {
      yield { text: text.slice(cursor, match.index), special: false };
    }
    yield { text: match[0], special: true };
    cursor = match.index + match[0].length;
  }
  if (cursor < text.length) {
    yield { text: text.slice(cursor), special: false };
  }
}

/** 按官方口径数一段提示词的 token。空串为 0;首尾空白会真实编码成 token,不 trim。 */
export function countQwenTokens(asset: QwenBpeAsset, text: string): number {
  if (!text) return 0;
  const normalized = asset.normalizeNfc ? text.normalize('NFC') : text;
  let total = 0;
  for (const segment of splitSpecialTokens(normalized, asset.specialPattern)) {
    if (segment.special) {
      total += 1;
      continue;
    }
    // splitRegex 带捕获组,必须取整段匹配而不是组内容。
    for (const match of segment.text.matchAll(asset.splitRegex)) {
      const piece = match[0];
      if (piece) total += countPiece(asset, piece);
    }
  }
  return total;
}

// 片级计数缓存:提示词里 "1girl" 这类词反复出现,缓存命中后计数近乎免费。
const pieceCaches = new WeakMap<QwenBpeAsset, Map<string, number>>();
const MAX_PIECE_CACHE = 4096;

function countPiece(asset: QwenBpeAsset, piece: string): number {
  let cache = pieceCaches.get(asset);
  if (!cache) {
    cache = new Map();
    pieceCaches.set(asset, cache);
  }
  const cached = cache.get(piece);
  if (cached !== undefined) return cached;

  const bytes = textEncoder.encode(piece);
  let word = '';
  for (const byte of bytes) word += BYTE_ENCODER[byte];
  const count = mergeCount(asset, word);

  if (cache.size >= MAX_PIECE_CACHE) {
    const keys = Array.from(cache.keys());
    keys.slice(0, MAX_PIECE_CACHE / 2).forEach((key) => cache!.delete(key));
  }
  cache.set(piece, count);
  return count;
}

function mergeCount(asset: QwenBpeAsset, word: string): number {
  let parts = Array.from(word);
  while (parts.length > 1) {
    let bestRank = -1;
    let bestIndex = -1;
    for (let index = 0; index < parts.length - 1; index++) {
      const rank = asset.ranks.get(`${parts[index]} ${parts[index + 1]}`);
      if (rank !== undefined && (bestIndex < 0 || rank < bestRank)) {
        bestRank = rank;
        bestIndex = index;
      }
    }
    if (bestIndex < 0) break;

    // 把当前最优 pair 的**所有**出现一次合并(贪心:每轮选 rank 最小的相邻对)。
    const first = parts[bestIndex];
    const second = parts[bestIndex + 1];
    const merged: string[] = [];
    let index = 0;
    while (index < parts.length) {
      if (index < parts.length - 1 && parts[index] === first && parts[index + 1] === second) {
        merged.push(first + second);
        index += 2;
      } else {
        merged.push(parts[index]);
        index += 1;
      }
    }
    parts = merged;
  }
  return parts.length;
}
