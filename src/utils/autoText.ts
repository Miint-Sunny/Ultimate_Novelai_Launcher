// autoText —— 把提示词里**引号包起来的内容**自动转成 NAI 的文字块。
//
// V4.5 起画面里可以生成文字,写法是提示词里放 `text: 要写的字`。V5 新增了这个语法糖:
// 用户直接打引号,客户端替他转成一个追加在末尾的块。能力位见
// `modelCapabilities().textRendering`(V5 true、V4 系 false)。
//
// 与 textRenderHints 的分工:那边只**提示**、不改写用户输入(编辑器里实时跑);
// 这边是**发包时的变换**,输出的是真正发出去的提示词。两边共用同一份引号表与
// 手写 `text:` 的判定,不要各写一份。
//
// 几个不写下来就会忘的细节(逐条对齐 Plana-App 的 auto_text.dart,
// 它又是逐条照抄官方实现):
//   - 用户手写了 `text:` 就**完全不插手**(判定不分大小写);
//   - 自动加的块用 `teXt:` 这个大小写变体当标记,剥离时靠它区分自动与手写;
//   - 英文撇号不误判:`'` 只在前一个字符不是字母数字时才当引号开头,收尾同理,
//     所以 `don't`、`it's` 安全;
//   - 多角色按**阅读顺序**收集:先按 y 分行,行内再按 x 排;
//   - 抽出来的内容里 CJK 占比 **> 30%** 时整体**反转顺序**(竖排右起的阅读习惯)。

import {
  CLIENT_TEXT_BLOCK_PREFIX,
  MANUAL_TEXT_BLOCK_PATTERN,
  QUOTE_PAIRS,
} from './textRenderHints';

/** 提示词分块的分隔符与上限,与官方一致。 */
const CHUNK_SEP = '|';
const CHUNK_ESCAPE = '||';
const MAX_CHUNKS = 6;

/** 私有码点占位,用来在切块时保护 `||…||` 里的竖线。 */
const PLACEHOLDER_PIPE = '\u{103B9}';
const PLACEHOLDER_ESCAPE = '\u{12137}';

/** 自动加的块用这个大小写变体;判定**区分大小写**,才认得出是不是我们加的。 */
const AUTO_MARKER_PATTERN = /(?:^|\s|[,.:[\]{}、。])teXt:(?!:)/;

const ALNUM_PATTERN = /[\p{L}\p{N}]/u;

const CJK_PATTERN = /[　-〿぀-ゟ゠-ヿ＀-ﾟ一-龯㐀-䶿]/g;

/** y 方向的分行阈值(归一化坐标)。 */
const LINE_TOTAL_THRESHOLD = 0.15;
const LINE_GAP_THRESHOLD = 0.1;

/** 参与 autoText 的一个角色:提示词 + 归一化中心坐标(用于按阅读顺序排)。 */
export interface AutoTextCharacter {
  prompt: string;
  enabled?: boolean;
  /** 归一化中心坐标;缺省视为原顺序。 */
  center?: { x: number; y: number };
}

export interface AutoTextOptions {
  characters?: readonly AutoTextCharacter[];
  useCoords?: boolean;
}

/**
 * 把提示词切成块。`||…||` 之间的竖线不算分隔符,先用私有码点挡住再切。
 * 超出上限的部分**全部并进最后一块**,而不是丢掉。
 */
export function splitPromptChunks(prompt: string): string[] {
  const segments = prompt.split(CHUNK_ESCAPE);
  const guarded = segments
    .map((segment, index) => (index % 2 === 1 ? segment.split(CHUNK_SEP).join(PLACEHOLDER_PIPE) : segment))
    .join(PLACEHOLDER_ESCAPE)
    .split(CHUNK_SEP);

  const chunks = guarded.slice(0, MAX_CHUNKS - 1);
  if (guarded.length > MAX_CHUNKS - 1) {
    chunks.push(guarded.slice(MAX_CHUNKS - 1).join(CHUNK_SEP));
  }
  return chunks.map((chunk) =>
    chunk.split(PLACEHOLDER_PIPE).join(CHUNK_SEP).split(PLACEHOLDER_ESCAPE).join(CHUNK_ESCAPE),
  );
}

const isAlnum = (char: string | undefined): boolean => char !== undefined && ALNUM_PATTERN.test(char);

/** 抽出一段文字里所有引号包起来的内容(去空白、丢空串)。 */
export function extractQuoted(text: string): string[] {
  const found: string[] = [];
  let i = 0;
  while (i < text.length) {
    const close = QUOTE_PAIRS[text[i]];
    // 直角撇号前面挨着字母数字时是 don't 的那个撇号,不是引号
    if (close === undefined || (text[i] === "'" && isAlnum(text[i - 1]))) {
      i += 1;
      continue;
    }
    const isApostrophe = close === "'" || close === '’';
    let j = i + 1;
    while (j < text.length && (text[j] !== close || (isApostrophe && isAlnum(text[j + 1])))) {
      j += 1;
    }
    if (j >= text.length) {
      // 没有配对的收尾引号,当普通字符跳过
      i += 1;
      continue;
    }
    const inner = text.slice(i + 1, j).trim();
    if (inner) found.push(inner);
    i = j + 1;
  }
  return found;
}

const centerY = (character: AutoTextCharacter): number => character.center?.y ?? 0;
const centerX = (character: AutoTextCharacter): number => character.center?.x ?? 0;

/** 按 y 递归分行:整体跨度和最大间距都够小就算同一行。 */
function splitIntoLines(characters: AutoTextCharacter[]): AutoTextCharacter[][] {
  if (characters.length <= 1) return [characters];
  const total = centerY(characters[characters.length - 1]) - centerY(characters[0]);
  let splitAt = 1;
  let maxGap = Number.NEGATIVE_INFINITY;
  for (let i = 1; i < characters.length; i += 1) {
    const gap = centerY(characters[i]) - centerY(characters[i - 1]);
    if (gap > maxGap) {
      maxGap = gap;
      splitAt = i;
    }
  }
  if (total <= LINE_TOTAL_THRESHOLD && maxGap <= LINE_GAP_THRESHOLD) return [characters];
  return [
    ...splitIntoLines(characters.slice(0, splitAt)),
    ...splitIntoLines(characters.slice(splitAt)),
  ];
}

/** 阅读顺序:先按 y 分行,行内按 x 从左到右。 */
function readingOrder(characters: AutoTextCharacter[]): AutoTextCharacter[] {
  const byY = [...characters].sort((a, b) => centerY(a) - centerY(b));
  return splitIntoLines(byY).flatMap((line) => [...line].sort((a, b) => centerX(a) - centerX(b)));
}

function isMostlyCjk(text: string): boolean {
  if (!text) return false;
  const hits = text.match(CJK_PATTERN)?.length ?? 0;
  return hits > 0 && hits / text.length > 0.3;
}

const enabledCharacters = (characters: readonly AutoTextCharacter[]): AutoTextCharacter[] =>
  characters.filter((character) => character.enabled !== false && character.prompt.length > 0);

/** 收集 base + 各角色里的引号内容,按阅读顺序,CJK 时整体反转。 */
function collectTexts(
  base: string,
  characters: readonly AutoTextCharacter[],
  useCoords: boolean,
): string[] {
  const chosen = enabledCharacters(characters);
  const ordered = useCoords ? readingOrder(chosen) : chosen;
  const groups = [extractQuoted(base), ...ordered.map((character) => extractQuoted(character.prompt))];
  if (isMostlyCjk(groups.flat().join(''))) {
    return groups.flatMap((group) => [...group].reverse());
  }
  return groups.flat();
}

const trimTrailingSeparators = (text: string): string => text.replace(/[\s,]+$/, '');

/**
 * 把引号内容转成 `teXt:` 块追加到**第一块**提示词末尾。
 * 用户已手写 `text:`、或压根没有引号内容时原样返回。
 */
export function applyAutoText(prompt: string, options: AutoTextOptions = {}): string {
  const characters = options.characters ?? [];
  const chosen = enabledCharacters(characters);
  if (
    MANUAL_TEXT_BLOCK_PATTERN.test(prompt) ||
    chosen.some((character) => MANUAL_TEXT_BLOCK_PATTERN.test(character.prompt))
  ) {
    return prompt;
  }
  const chunks = splitPromptChunks(prompt);
  const head = chunks.length > 0 ? chunks[0] : '';
  const texts = collectTexts(head, characters, options.useCoords ?? false);
  if (texts.length === 0) return prompt;

  const block = `${CLIENT_TEXT_BLOCK_PREFIX} ${texts.join('\n\n')}`;
  const trimmed = trimTrailingSeparators(head);
  const out = chunks.length > 0 ? [...chunks] : [''];
  out[0] = trimmed ? `${trimmed}, ${block}` : block;
  return out.join(CHUNK_SEP);
}

/**
 * 逆操作:把自动加的 `teXt:` 块剥掉,还原用户原文。
 *
 * 判定方式是**重算一遍**:算出来的块和现有的一致才认定是自动加的。不一致说明用户
 * 手改过,原样保留 —— 不能靠标记本身判断,否则会把用户自己写的 `teXt:` 也吃掉。
 */
export function stripAutoText(prompt: string, options: AutoTextOptions = {}): string {
  const characters = options.characters ?? [];
  const useCoords = options.useCoords ?? false;
  return splitPromptChunks(prompt)
    .map((chunk) => {
      const match = AUTO_MARKER_PATTERN.exec(chunk);
      if (match === null) return chunk;
      const head = chunk.slice(0, match.index);
      const tail = chunk.slice(match.index + match[0].length).trim();
      if (tail !== collectTexts(head, characters, useCoords).join('\n\n')) return chunk;
      return trimTrailingSeparators(head);
    })
    .join(CHUNK_SEP);
}
