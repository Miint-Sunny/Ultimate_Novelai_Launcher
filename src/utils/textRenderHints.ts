// V5 文字渲染辅助 —— 纯函数,双端(桌面/移动)编辑器与 node 校验脚本共用。
// 不碰 React / DOM / localStorage,可被 node --experimental-strip-types 直接加载。
//
// 规则来源(2026-08-28 实测锚点):
// - 提示词里的引号内容会被客户端翻译成 `teXt: <内容>` 块追加到正向提示词
//   末尾(质量尾之后),引号本身原样保留;
// - 用户手写任意大小写的 `text:` 块会关闭自动生成(nai5-prompting 佐证:
//   「手动书写 Text: 块会关闭该自动功能」);
// - 五种引号配对都触发:英文双引号、中文全角双引号、直角引号、英文单引号、
//   中文单引号;
// - `text::` 是权重语法不是文字块,检测必须排除(负向前瞻)。
//
// 本模块只做**提示**,不改写用户输入。误报会毁掉正常输入,自动改写更糟。

/** 客户端插入文字块用的字面量(大小写故意混写,官方 bundle 如此)。 */
export const CLIENT_TEXT_BLOCK_PREFIX = 'teXt:';

/**
 * 用户手写的 text: 块(大小写不敏感)。前置字符集合与官方 bundle 一致;
 * `(?!:)` 负向前瞻把 `text::` 权重语法排除掉。
 */
export const MANUAL_TEXT_BLOCK_PATTERN = /(?:^|\s|[,.:[\]{}、。])text:(?!:)/i;

/** 文字渲染的 token 预算(约 750)。官方文档站未能二次确认,标「约」。 */
export const TEXT_RENDER_TOKEN_BUDGET = 750;

/**
 * 引号配对表(官方 bundle 的 tV 逐字)。前三种为对称引号,后两种为成对引号。
 */
export const QUOTE_PAIRS: Readonly<Record<string, string>> = {
  '"': '"',
  '“': '”',
  '「': '」',
  "'": "'",
  '‘': '’',
};

/**
 * 载体词表。实测经验:引号必须配一个载体(气泡、纸条、招牌、书页之类),
 * 否则文字容易糊或飘在半空。英文词条按 Danbooru 习惯同时兼容空格与下划线
 * 写法(匹配前统一归一化),中文词条用于中文自然语言提示词。
 */
export const TEXT_RENDER_CARRIERS: ReadonlyArray<{ en: string; zh: string }> = [
  { en: 'speech bubble', zh: '对话框' },
  { en: 'thought bubble', zh: '思想泡泡' },
  { en: 'comic', zh: '漫画' },
  { en: 'sign', zh: '招牌' },
  { en: 'holding a sign', zh: '举着牌子' },
  { en: 'placard', zh: '标语牌' },
  { en: 'name tag', zh: '名牌' },
  { en: 'sticky note', zh: '便利贴' },
  { en: 'note', zh: '纸条' },
  { en: 'paper', zh: '纸张' },
  { en: 'holding paper', zh: '拿着纸' },
  { en: 'letter', zh: '信件' },
  { en: 'book', zh: '书' },
  { en: 'book page', zh: '书页' },
  { en: 'notebook', zh: '笔记本' },
  { en: 'scroll', zh: '卷轴' },
  { en: 'poster', zh: '海报' },
  { en: 'banner', zh: '横幅' },
  { en: 'chalkboard', zh: '黑板' },
  { en: 'blackboard', zh: '黑板' },
  { en: 'whiteboard', zh: '白板' },
  { en: 'screen', zh: '屏幕' },
  { en: 'phone screen', zh: '手机屏幕' },
  { en: 'text message', zh: '短信' },
  { en: 'newspaper', zh: '报纸' },
  { en: 'magazine', zh: '杂志' },
  { en: 't-shirt', zh: 'T恤' },
];

/** CJK 字符检测(官方 bundle 的 rV 逐字:\u3000-303f/3040-309f/30a0-30ff/ff00-ffef/4e00-9fef/3400-4dbf)。 */
const CJK_PATTERN = /[\u3000-\u303f\u3040-\u309f\u30a0-\u30ff\uff00-\uffef\u4e00-\u9fef\u3400-\u4dbf]/;

const isCjkTerm = (term: string): boolean => CJK_PATTERN.test(term);

const isCjkChar = (ch: string): boolean => CJK_PATTERN.test(ch);

/**
 * 归一化:小写、下划线换空格、多空格收一。让 `speech_bubble` 与
 * `speech bubble` 命中同一条载体。
 */
const normalizeForMatch = (text: string): string =>
  text.toLowerCase().replace(/_/g, ' ').replace(/\s+/g, ' ').trim();

// 拉丁载体预编译成带词边界的正则,避免 `sign` 误命中 `signature` / `design`。
// CJK 载体无词边界概念,直接子串包含。
const LATIN_CARRIER_PATTERNS: ReadonlyArray<RegExp> = TEXT_RENDER_CARRIERS
  .map(({ en }) => normalizeForMatch(en))
  .filter((term) => term.length > 0 && !isCjkTerm(term))
  .map((term) => new RegExp(`(^|[^a-z0-9])${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^a-z0-9])`));

const CJK_CARRIER_TERMS: ReadonlyArray<string> = TEXT_RENDER_CARRIERS
  .map(({ en, zh }) => [en, zh])
  .flat()
  .map(normalizeForMatch)
  .filter((term) => term.length > 0 && isCjkTerm(term));

/** 提示词里是否存在载体词。 */
export function hasTextCarrier(prompt: string): boolean {
  const normalized = ` ${normalizeForMatch(prompt)} `;
  if (LATIN_CARRIER_PATTERNS.some((pattern) => pattern.test(normalized))) return true;
  return CJK_CARRIER_TERMS.some((term) => normalized.includes(term));
}

/** 是否存在用户手写的 text: 块(任意大小写)。存在则自动生成已关闭,不再提示。 */
export function hasManualTextBlock(prompt: string): boolean {
  return MANUAL_TEXT_BLOCK_PATTERN.test(prompt);
}

export interface QuoteSpan {
  /** 开引号在提示词中的下标。 */
  start: number;
  /** 闭引号之后的下标(未闭合时为提示词长度)。 */
  end: number;
  /** 引号内的纯内容(不含引号本身)。 */
  content: string;
  open: string;
  close: string;
  unclosed: boolean;
}

/**
 * 扫描提示词里的引号段。对称引号(" 和 ')只在前面不是词字符时才算开引号,
 * 这样英文所有格(girl's)不会被误判成未闭合;成对引号(“”「」‘’)按配对闭合。
 */
export function findQuoteSpans(prompt: string): QuoteSpan[] {
  const spans: QuoteSpan[] = [];
  let open: string | null = null;
  let openIndex = -1;

  for (let i = 0; i < prompt.length; i += 1) {
    const ch = prompt[i];
    if (open === null) {
      const close = QUOTE_PAIRS[ch];
      if (close === undefined) continue;
      const isSymmetric = close === ch;
      const prev = i > 0 ? prompt[i - 1] : '';
      if (isSymmetric && /[a-zA-Z0-9]/.test(prev)) continue; // 英寸符 / 所有格
      open = ch;
      openIndex = i;
    } else if (ch === QUOTE_PAIRS[open]) {
      spans.push({
        start: openIndex,
        end: i + 1,
        content: prompt.slice(openIndex + 1, i),
        open,
        close: ch,
        unclosed: false,
      });
      open = null;
      openIndex = -1;
    }
  }

  if (open !== null) {
    spans.push({
      start: openIndex,
      end: prompt.length,
      content: prompt.slice(openIndex + 1),
      open,
      close: QUOTE_PAIRS[open],
      unclosed: true,
    });
  }
  return spans;
}

/** 光标处(给定文本末尾)是否落在一个未闭合引号内部。补全让路判定用。 */
export function isInsideUnclosedQuote(text: string): boolean {
  const spans = findQuoteSpans(text);
  const last = spans[spans.length - 1];
  return last !== undefined && last.unclosed;
}

/**
 * 文字块 token 粗估:CJK 一字一记,其余按每 4 字符一记。
 * V5 用 Qwen 分词器,这里不引 tokenizer,只用于预算告警,宁粗勿漏。
 */
export function estimateTextRenderTokens(text: string): number {
  let tokens = 0;
  let latinRun = 0;
  for (const ch of text) {
    if (/\s/.test(ch)) {
      tokens += Math.ceil(latinRun / 4);
      latinRun = 0;
    } else if (isCjkChar(ch)) {
      tokens += Math.ceil(latinRun / 4);
      latinRun = 0;
      tokens += 1;
    } else {
      latinRun += 1;
    }
  }
  tokens += Math.ceil(latinRun / 4);
  return tokens;
}

export type TextRenderHintKind = 'no-carrier' | 'unclosed-quote' | 'text-block-over-budget';

export interface TextRenderHint {
  kind: TextRenderHintKind;
  message: string;
  /** 提示所指的 [起始下标, 结束下标),便于将来做下划线定位。 */
  span: [number, number];
}

const summarizeContent = (content: string): string => {
  const trimmed = content.trim();
  return trimmed.length > 20 ? `${trimmed.slice(0, 20)}…` : trimmed;
};

/**
 * 对正向提示词做文字渲染体检,返回结构化提示:
 * - unclosed-quote:引号未闭合(文字不会生效);
 * - no-carrier:有引号文字但没有任何载体词(文字容易糊/飘);
 * - text-block-over-budget:引号内容估算超 token 预算。
 *
 * 用户手写了 text: 块时自动生成已关闭,直接返回空数组。
 */
export function detectTextRenderHints(prompt: string): TextRenderHint[] {
  if (!prompt || hasManualTextBlock(prompt)) return [];

  const spans = findQuoteSpans(prompt);
  const hints: TextRenderHint[] = [];

  for (const span of spans) {
    if (span.unclosed) {
      hints.push({
        kind: 'unclosed-quote',
        message: `引号 ${span.open} 未闭合,这段文字不会被渲染`,
        span: [span.start, span.end],
      });
      continue;
    }
    if (!span.content.trim()) continue;
    const estimated = estimateTextRenderTokens(span.content.trim());
    if (estimated > TEXT_RENDER_TOKEN_BUDGET) {
      hints.push({
        kind: 'text-block-over-budget',
        message: `文字「${summarizeContent(span.content)}」估算约 ${estimated} token,超过文字渲染约 ${TEXT_RENDER_TOKEN_BUDGET} 的预算,可能渲染不全`,
        span: [span.start, span.end],
      });
    }
  }

  const rendered = spans.filter((span) => !span.unclosed && span.content.trim());
  if (rendered.length > 0 && !hasTextCarrier(prompt)) {
    hints.unshift({
      kind: 'no-carrier',
      message: `引号内容「${summarizeContent(rendered[0].content)}」会渲染进图里,但提示词没有载体(气泡/招牌/纸条/书页等),文字容易糊或飘在半空`,
      span: [rendered[0].start, rendered[0].end],
    });
  }

  return hints;
}
