/**
 * 回复编号标记 `[回复 #N]` 的协议单一事实源,逐条移植自他 0.5.0 的 reply_marker.dart。
 *
 * 请求侧由 harness 临时注入:每条助手回复发给模型前前缀一层稳定编号,便于 context_memory
 * 按编号读取或释放旧回复。正文侧一律剥离:模型回显回来的标记既不该出现在 UI 上,也不该
 * 入库累积(只剥「正文开头」会漏掉段落之间 / 行尾的回显,下一轮请求再叠一层 → 历史里越滚越多),
 * 所以这里提供全量剥离与流式增量剥离两套入口。
 */

/** 完整标记:必须带右括号。流式期间只有这种形态能当即剥离。 */
const CLOSED = /(?:\*\*)?[ \t　]*[\[［]?[ \t　]*回复[ \t　]*[#＃][ \t　]*[0-9０-９]+[ \t　]*[\]］][ \t　]*(?:\*\*)?/g;

/** 宽松标记:右括号可缺(仅用于整段文本 / 流结束时的收尾剥离)。 */
const TOKEN = /(?:\*\*)?[ \t　]*[\[［]?[ \t　]*回复[ \t　]*[#＃][ \t　]*[0-9０-９]+[ \t　]*[\]］]?[ \t　]*(?:\*\*)?/g;

/** 标记残渣:回显标记被网络分块切碎时可能只剩一个孤立右括号。 */
const LEADING_DEBRIS = /^(?:\*\*)?[ \t　]*[\]］][ \t　]*(?:\*\*)?[ \t　]*(?:\r?\n)?/;
const TRAILING_DEBRIS = /(?:\r?\n)?[ \t　]*(?:\*\*)?[ \t　]*[\]］][ \t　]*(?:\*\*)?$/;

function bracketCounts(text: string): [number, number] {
  let open = 0;
  let close = 0;
  for (const ch of text) {
    if (ch === '[' || ch === '［') open += 1;
    else if (ch === ']' || ch === '］') close += 1;
  }
  return [open, close];
}

function hasUnmatchedCloseBracket(text: string): boolean {
  const [open, close] = bracketCounts(text);
  return close > open;
}

/** 去掉正文中任意位置被模型回显的 `[回复 #N]` 标记与标记残渣。 */
export function stripReplyMarkers(text: string): string {
  if (!text) return text;
  TOKEN.lastIndex = 0;
  const first = TOKEN.exec(text);
  TOKEN.lastIndex = 0;
  if (first === null && !LEADING_DEBRIS.test(text) && !hasUnmatchedCloseBracket(text)) return text;
  let cleaned = text.replace(TOKEN, '');
  // 残渣清理:首部孤立右括号直接去掉;尾部只在括号数失衡时才去除,保证正常成对括号(参考 [3]、Markdown 链接)不受影响。
  cleaned = cleaned.replace(LEADING_DEBRIS, '');
  if (hasUnmatchedCloseBracket(cleaned)) cleaned = cleaned.replace(TRAILING_DEBRIS, '');
  cleaned = cleaned.replace(/^[ \t　]+$/gm, '').replace(/\n{3,}/g, '\n\n');
  // 标记就位于正文最前时,剥离后残留的首部空白一并清掉。
  return first !== null && first.index === 0 ? cleaned.replace(/^\s+/, '') : cleaned;
}

/**
 * 流式正文 / 思考的回复标记过滤器。
 * 两条规则:完整标记(带右括号)随时可剥;「可能是半个标记」的尾巴必须扣住——它可能马上被下一块补完,
 * 而尾巴之前的部分已不可能再长成标记,可安全地按宽松形态剥离。流结束时把残缺尾巴丢弃。
 */
export class ReplyMarkerStreamFilter {
  private pending = '';
  private started = false;
  private stripped = false;
  private openBrackets = 0;
  private closeBrackets = 0;

  /** 可能是「半个标记」的形状(全部字符都是标记自身会用到的字符)。 */
  private static readonly PARTIAL = /^\**[ \t　]*[\[［]?[ \t　]*(?:回(?:复)?)?[ \t　]*[#＃]?[ \t　]*[0-9０-９]*[ \t　]*[\]］]?[ \t　]*\**$/;
  private static readonly MARKER_SIGNATURE = /[回\[［#＃]/;
  private static readonly LEADING_BLANK = /^[ \t　\r\n]+/;
  private static readonly MAX_HOLD = 32;

  /** 追加一个增量,返回可以安全展示 / 入库的正文片段(可能为空)。 */
  add(delta: string): string {
    if (!delta) return '';
    this.pending += delta;
    this.pending = this.stripClosed(this.pending);
    const hold = ReplyMarkerStreamFilter.holdbackLength(this.pending);
    const cut = this.pending.length - hold;
    let head = this.stripLoose(this.pending.slice(0, cut));
    this.pending = this.pending.slice(cut);
    if (!this.started && this.stripped) head = head.replace(ReplyMarkerStreamFilter.LEADING_BLANK, '');
    if (head) {
      this.started = true;
      this.countBrackets(head);
    }
    return head;
  }

  /** 流结束:被截断的半个标记直接丢弃;尾部孤立右括号残渣仅在全文括号失衡时丢弃;`**` / 纯数字这类尾字原样归还。 */
  flush(): string {
    let safe = this.stripLoose(this.pending);
    this.pending = '';
    if (!this.started && this.stripped) safe = safe.replace(ReplyMarkerStreamFilter.LEADING_BLANK, '');
    const hold = ReplyMarkerStreamFilter.holdbackLength(safe);
    if (hold > 0) {
      const tail = safe.slice(safe.length - hold);
      if (ReplyMarkerStreamFilter.MARKER_SIGNATURE.test(tail) || this.isResidueTail(tail, safe)) safe = safe.slice(0, safe.length - hold);
    }
    this.countBrackets(safe);
    return safe;
  }

  private isResidueTail(tail: string, safe: string): boolean {
    if (!TRAILING_DEBRIS.test(tail)) return false;
    const [open, close] = bracketCounts(safe);
    return this.closeBrackets + close > this.openBrackets + open;
  }

  private countBrackets(text: string): void {
    const [open, close] = bracketCounts(text);
    this.openBrackets += open;
    this.closeBrackets += close;
  }

  private stripClosed(text: string): string {
    const stripped = text.replace(CLOSED, '');
    if (stripped.length !== text.length) this.stripped = true;
    return stripped;
  }

  private stripLoose(text: string): string {
    const stripped = text.replace(TOKEN, '');
    if (stripped.length !== text.length) this.stripped = true;
    return stripped;
  }

  /** 取最长的「可能是标记一部分」的尾长(取最大,确保整个标记都被扣住)。 */
  private static holdbackLength(text: string): number {
    const max = Math.min(text.length, ReplyMarkerStreamFilter.MAX_HOLD);
    let hold = 0;
    for (let k = 1; k <= max; k += 1) {
      if (ReplyMarkerStreamFilter.PARTIAL.test(text.slice(text.length - k))) hold = k;
    }
    return hold;
  }
}
