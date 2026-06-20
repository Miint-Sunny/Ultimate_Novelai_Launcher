import React from 'react';

/* ─── 权重转换函数 ─── */
// 整段 prompt 的递归转换（嵌套括号、{}/[]、1.05/0.952381 特殊权重值、\( 转义）。
// 与 utils/promptTags.ts 的单标签 convertSDToNAI（基于 parseSDWeight）不同，不要合并。
// 桌面 ToolsModal 与移动 tools 共用此实现（两端原为副本，已统一到此处）。
// 转换输出必须保持字节一致（含 1.05/0.952381 映射与 \( 转义）。

/** SD → NAI: (text:1.2) → 1.2::text::, (text) → {text} */
export function convertSDToNAI(text: string): string {
  const res: string[] = [];
  let i = 0;
  const n = text.length;

  while (i < n) {
    const ch = text[i];
    // 处理转义括号 \( \) → 直接输出字面括号
    if (ch === '\\' && i + 1 < n && (text[i + 1] === '(' || text[i + 1] === ')')) {
      res.push(text[i + 1]);
      i += 2;
      continue;
    }
    if (ch === '(') {
      // 找到匹配的右括号
      let depth = 1;
      let j = i + 1;
      while (j < n && depth > 0) {
        if (text[j] === '(') depth++;
        else if (text[j] === ')') depth--;
        j++;
      }
      if (depth === 0) {
        const inner = text.slice(i + 1, j - 1);
        // 检查 (content:weight) 格式
        const lastColon = inner.lastIndexOf(':');
        if (lastColon > 0) {
          const left = inner.slice(0, lastColon);
          const right = inner.slice(lastColon + 1);
          if (/^\s*\d+(?:\.\d+)?\s*$/.test(right)) {
            const weight = parseFloat(right.trim());
            const content = convertSDToNAI(left);
            if (Math.abs(weight - 1.05) < 0.001) {
              res.push(`{${content}}`);
            } else if (Math.abs(weight - 0.952381) < 0.001 || Math.abs(weight - 0.95) < 0.001) {
              res.push(`[${content}]`);
            } else {
              res.push(`${weight}::${content}::`);
            }
            i = j;
            continue;
          }
        }
        // 普通 (text) → {text}
        const processedInner = convertSDToNAI(inner);
        res.push(`{${processedInner}}`);
        i = j;
        continue;
      }
    } else if (ch === '[') {
      // SD [text] = decrease weight → NAI [text]
      let depth = 1;
      let j = i + 1;
      while (j < n && depth > 0) {
        if (text[j] === '[') depth++;
        else if (text[j] === ']') depth--;
        j++;
      }
      if (depth === 0) {
        const inner = text.slice(i + 1, j - 1);
        res.push(`[${convertSDToNAI(inner)}]`);
        i = j;
        continue;
      }
    }
    res.push(ch);
    i++;
  }
  return res.join('');
}

/** NAI → SD: {text} → (text:1.05), [text] → [text], 1.2::text:: → (text:1.2) */
export function convertNAIToSD(text: string): string {
  const res: string[] = [];
  let i = 0;
  const n = text.length;

  while (i < n) {
    const ch = text[i];

    // 检查 weight::content:: 格式
    if (/\d/.test(ch)) {
      // 尝试匹配 number::content::
      const numMatch = text.slice(i).match(/^(\d+(?:\.\d+)?)::/);
      if (numMatch) {
        const weight = parseFloat(numMatch[1]);
        const afterNum = i + numMatch[0].length;
        // 找到结束的 ::
        const endIdx = text.indexOf('::', afterNum);
        if (endIdx !== -1) {
          const content = text.slice(afterNum, endIdx);
          const converted = convertNAIToSD(content);
          res.push(`(${converted}:${weight})`);
          i = endIdx + 2;
          continue;
        }
      }
    }

    if (ch === '{') {
      let depth = 1;
      let j = i + 1;
      while (j < n && depth > 0) {
        if (text[j] === '{') depth++;
        else if (text[j] === '}') depth--;
        j++;
      }
      if (depth === 0) {
        const inner = text.slice(i + 1, j - 1);
        const converted = convertNAIToSD(inner);
        res.push(`(${converted}:1.05)`);
        i = j;
        continue;
      }
    } else if (ch === '[') {
      let depth = 1;
      let j = i + 1;
      while (j < n && depth > 0) {
        if (text[j] === '[') depth++;
        else if (text[j] === ']') depth--;
        j++;
      }
      if (depth === 0) {
        const inner = text.slice(i + 1, j - 1);
        res.push(`[${convertNAIToSD(inner)}]`);
        i = j;
        continue;
      }
    }

    // 转义字面括号 ( ) → \( \)
    if (ch === '(' || ch === ')') {
      res.push(`\\${ch}`);
      i++;
      continue;
    }

    res.push(ch);
    i++;
  }
  return res.join('');
}

/** 将 NAI 格式文本解析为带权重高亮的 React 节点（匹配主编辑器样式） */
export function renderNAIHighlighted(text: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  let i = 0;
  const n = text.length;
  let key = 0;
  let plain = '';

  const flush = () => {
    if (plain) { nodes.push(<span key={key++}>{plain}</span>); plain = ''; }
  };

  while (i < n) {
    const ch = text[i];

    // weight::content:: 格式
    if (/\d/.test(ch) || ch === '-') {
      const m = text.slice(i).match(/^(-?\d+(?:\.\d+)?)::([\s\S]*?)::/);
      if (m) {
        flush();
        const w = parseFloat(m[1]);
        const bg = w >= 0 ? 'rgba(116, 39, 13, 1)' : 'rgba(96, 165, 250, 0.3)';
        nodes.push(
          <span key={key++} style={{ backgroundColor: bg, borderRadius: '2px' }}>
            {m[0]}
          </span>
        );
        i += m[0].length;
        continue;
      }
    }

    if (ch === '{') {
      let depth = 1; let j = i + 1;
      while (j < n && depth > 0) { if (text[j] === '{') depth++; else if (text[j] === '}') depth--; j++; }
      if (depth === 0) {
        flush();
        nodes.push(<span key={key++} style={{ backgroundColor: 'rgba(116, 39, 13, 0.5)', borderRadius: '2px' }}>{text.slice(i, j)}</span>);
        i = j; continue;
      }
    }

    if (ch === '[') {
      let depth = 1; let j = i + 1;
      while (j < n && depth > 0) { if (text[j] === '[') depth++; else if (text[j] === ']') depth--; j++; }
      if (depth === 0) {
        flush();
        nodes.push(<span key={key++} style={{ backgroundColor: 'rgba(96, 165, 250, 0.15)', borderRadius: '2px' }}>{text.slice(i, j)}</span>);
        i = j; continue;
      }
    }

    plain += ch;
    i++;
  }
  flush();
  return nodes;
}

/** 将 SD 格式文本解析为带权重高亮的 React 节点（匹配主编辑器样式） */
export function renderSDHighlighted(text: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  let i = 0;
  const n = text.length;
  let key = 0;
  let plain = '';

  const flush = () => {
    if (plain) { nodes.push(<span key={key++}>{plain}</span>); plain = ''; }
  };

  while (i < n) {
    const ch = text[i];

    if (ch === '(') {
      let depth = 1; let j = i + 1;
      while (j < n && depth > 0) { if (text[j] === '(') depth++; else if (text[j] === ')') depth--; j++; }
      if (depth === 0) {
        flush();
        const inner = text.slice(i + 1, j - 1);
        const lastColon = inner.lastIndexOf(':');
        let bg = 'rgba(116, 39, 13, 0.5)';
        if (lastColon > 0) {
          const wStr = inner.slice(lastColon + 1);
          if (/^\s*-?\d+(?:\.\d+)?\s*$/.test(wStr)) {
            const w = parseFloat(wStr);
            bg = w >= 1 ? 'rgba(116, 39, 13, 0.5)' : 'rgba(96, 165, 250, 0.15)';
          }
        }
        nodes.push(<span key={key++} style={{ backgroundColor: bg, borderRadius: '2px' }}>{text.slice(i, j)}</span>);
        i = j; continue;
      }
    }

    if (ch === '[') {
      let depth = 1; let j = i + 1;
      while (j < n && depth > 0) { if (text[j] === '[') depth++; else if (text[j] === ']') depth--; j++; }
      if (depth === 0) {
        flush();
        nodes.push(<span key={key++} style={{ backgroundColor: 'rgba(96, 165, 250, 0.15)', borderRadius: '2px' }}>{text.slice(i, j)}</span>);
        i = j; continue;
      }
    }

    plain += ch;
    i++;
  }
  flush();
  return nodes;
}
