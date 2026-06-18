import React from 'react';

/* ─── 权重转换函数 ─── */
// 注意：本文件是整段 prompt 的递归转换（处理嵌套括号、{}/[]、1.05/0.952381 特殊权重值、\( 转义），
// 与 utils/promptTags.ts 的单标签 convertSDToNAI（基于 parseSDWeight）不同，不要合并。
// 与桌面 ToolsModal.tsx 的副本重复，合并需专门的行为对齐任务。

function convertSDToNAI(text: string): string {
  const res: string[] = [];
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    // 处理转义括号 \( \) → 直接输出字面括号
    if (ch === '\\' && i + 1 < n && (text[i + 1] === '(' || text[i + 1] === ')')) {
      res.push(text[i + 1]); i += 2; continue;
    }
    if (ch === '(') {
      let depth = 1; let j = i + 1;
      while (j < n && depth > 0) { if (text[j] === '(') depth++; else if (text[j] === ')') depth--; j++; }
      if (depth === 0) {
        const inner = text.slice(i + 1, j - 1);
        const lastColon = inner.lastIndexOf(':');
        if (lastColon > 0) {
          const left = inner.slice(0, lastColon);
          const right = inner.slice(lastColon + 1);
          if (/^\s*\d+(?:\.\d+)?\s*$/.test(right)) {
            const weight = parseFloat(right.trim());
            const content = convertSDToNAI(left);
            if (Math.abs(weight - 1.05) < 0.001) { res.push(`{${content}}`); }
            else if (Math.abs(weight - 0.952381) < 0.001 || Math.abs(weight - 0.95) < 0.001) { res.push(`[${content}]`); }
            else { res.push(`${weight}::${content}::`); }
            i = j; continue;
          }
        }
        res.push(`{${convertSDToNAI(inner)}}`);
        i = j; continue;
      }
    } else if (ch === '[') {
      let depth = 1; let j = i + 1;
      while (j < n && depth > 0) { if (text[j] === '[') depth++; else if (text[j] === ']') depth--; j++; }
      if (depth === 0) {
        res.push(`[${convertSDToNAI(text.slice(i + 1, j - 1))}]`);
        i = j; continue;
      }
    }
    res.push(ch); i++;
  }
  return res.join('');
}

function convertNAIToSD(text: string): string {
  const res: string[] = [];
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    if (/\d/.test(ch)) {
      const numMatch = text.slice(i).match(/^(\d+(?:\.\d+)?)::/);
      if (numMatch) {
        const weight = parseFloat(numMatch[1]);
        const afterNum = i + numMatch[0].length;
        const endIdx = text.indexOf('::', afterNum);
        if (endIdx !== -1) {
          res.push(`(${convertNAIToSD(text.slice(afterNum, endIdx))}:${weight})`);
          i = endIdx + 2; continue;
        }
      }
    }
    if (ch === '{') {
      let depth = 1; let j = i + 1;
      while (j < n && depth > 0) { if (text[j] === '{') depth++; else if (text[j] === '}') depth--; j++; }
      if (depth === 0) { res.push(`(${convertNAIToSD(text.slice(i + 1, j - 1))}:1.05)`); i = j; continue; }
    } else if (ch === '[') {
      let depth = 1; let j = i + 1;
      while (j < n && depth > 0) { if (text[j] === '[') depth++; else if (text[j] === ']') depth--; j++; }
      if (depth === 0) { res.push(`[${convertNAIToSD(text.slice(i + 1, j - 1))}]`); i = j; continue; }
    }
    // 转义字面括号 ( ) → \( \)
    if (ch === '(' || ch === ')') { res.push(`\\${ch}`); i++; continue; }
    res.push(ch); i++;
  }
  return res.join('');
}

/* ─── 权重高亮渲染（匹配主编辑器样式） ─── */

function renderNAIHighlighted(text: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = []; let i = 0; const n = text.length; let key = 0; let plain = '';
  const flush = () => { if (plain) { nodes.push(<span key={key++}>{plain}</span>); plain = ''; } };
  while (i < n) {
    const ch = text[i];
    if (/\d/.test(ch) || ch === '-') {
      const m = text.slice(i).match(/^(-?\d+(?:\.\d+)?)::([\s\S]*?)::/);
      if (m) { flush(); const w = parseFloat(m[1]); const bg = w >= 0 ? 'rgba(116,39,13,1)' : 'rgba(96,165,250,0.3)'; nodes.push(<span key={key++} style={{ backgroundColor: bg, borderRadius: '2px' }}>{m[0]}</span>); i += m[0].length; continue; }
    }
    if (ch === '{') { let d = 1, j = i + 1; while (j < n && d > 0) { if (text[j] === '{') d++; else if (text[j] === '}') d--; j++; } if (d === 0) { flush(); nodes.push(<span key={key++} style={{ backgroundColor: 'rgba(116,39,13,0.5)', borderRadius: '2px' }}>{text.slice(i, j)}</span>); i = j; continue; } }
    if (ch === '[') { let d = 1, j = i + 1; while (j < n && d > 0) { if (text[j] === '[') d++; else if (text[j] === ']') d--; j++; } if (d === 0) { flush(); nodes.push(<span key={key++} style={{ backgroundColor: 'rgba(96,165,250,0.15)', borderRadius: '2px' }}>{text.slice(i, j)}</span>); i = j; continue; } }
    plain += ch; i++;
  }
  flush(); return nodes;
}

function renderSDHighlighted(text: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = []; let i = 0; const n = text.length; let key = 0; let plain = '';
  const flush = () => { if (plain) { nodes.push(<span key={key++}>{plain}</span>); plain = ''; } };
  while (i < n) {
    const ch = text[i];
    if (ch === '(') { let d = 1, j = i + 1; while (j < n && d > 0) { if (text[j] === '(') d++; else if (text[j] === ')') d--; j++; } if (d === 0) { flush(); const inner = text.slice(i + 1, j - 1); const lc = inner.lastIndexOf(':'); let bg = 'rgba(116,39,13,0.5)'; if (lc > 0) { const ws = inner.slice(lc + 1); if (/^\s*-?\d+(?:\.\d+)?\s*$/.test(ws)) { bg = parseFloat(ws) >= 1 ? 'rgba(116,39,13,0.5)' : 'rgba(96,165,250,0.15)'; } } nodes.push(<span key={key++} style={{ backgroundColor: bg, borderRadius: '2px' }}>{text.slice(i, j)}</span>); i = j; continue; } }
    if (ch === '[') { let d = 1, j = i + 1; while (j < n && d > 0) { if (text[j] === '[') d++; else if (text[j] === ']') d--; j++; } if (d === 0) { flush(); nodes.push(<span key={key++} style={{ backgroundColor: 'rgba(96,165,250,0.15)', borderRadius: '2px' }}>{text.slice(i, j)}</span>); i = j; continue; } }
    plain += ch; i++;
  }
  flush(); return nodes;
}

export const mobileWeightConvert = {
  convertSDToNAI,
  convertNAIToSD,
  renderNAIHighlighted,
  renderSDHighlighted,
};
