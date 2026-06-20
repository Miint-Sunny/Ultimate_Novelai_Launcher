/**
 * 解析法典内容中的 charN: 角色提示词模式
 * 
 * 支持格式：
 * - "base prompt,\nchar1:girl,blonde hair,\nchar2:boy,black hair,"
 * - "base prompt,char1:girl,blonde hair,char2:boy,black hair,"
 * - 同时支持中文冒号：char1：girl,blonde hair,
 */

export interface ParsedCharacter {
  label: string;   // 如 "角色 1"
  content: string;  // 该角色的提示词内容
  negative?: string;
}

export interface ParsedPromptContent {
  basePrompt: string;
  characters: ParsedCharacter[];
}

/**
 * 解析包含 charN: 标记的提示词内容
 * 将 charN: 后的内容拆分为独立的角色提示词
 */
export function parseCharacterPromptContent(content: string): ParsedPromptContent {
  // 匹配 char1: / [char1+] / [char1-] 等模式，支持英文冒号和中文冒号（前面可能有换行或逗号）
  const charPattern = /(?:[\n,]\s*)?(?:\[\s*char(\d+)\s*([+-])\s*\]|char(\d+)\s*[：:])/gi;
  
  const matches: { index: number; num: number; sign: '+' | '-'; matchLen: number }[] = [];
  let match: RegExpExecArray | null;
  
  while ((match = charPattern.exec(content)) !== null) {
    matches.push({
      index: match.index,
      num: parseInt(match[1] || match[3]),
      sign: (match[2] === '-' ? '-' : '+'),
      matchLen: match[0].length,
    });
  }
  
  if (matches.length === 0) {
    return { basePrompt: content, characters: [] };
  }
  
  // 基础提示词：第一个 charN: 之前的内容
  const basePrompt = content.slice(0, matches[0].index).trim();
  
  // 提取每个角色的内容；[charN-] 合并到同一角色的 negative
  const byNum = new Map<number, ParsedCharacter>();
  matches.forEach((m, i) => {
    // 用匹配长度直接定位冒号后的内容起始位置
    const contentStart = m.index + m.matchLen;
    const contentEnd = i < matches.length - 1 ? matches[i + 1].index : content.length;
    const charContent = content.slice(contentStart, contentEnd).trim();
    const current = byNum.get(m.num) || { label: `角色 ${m.num}`, content: '' };
    if (m.sign === '-') {
      current.negative = charContent;
    } else {
      current.content = charContent;
    }
    byNum.set(m.num, current);
  });
  
  const characters = Array.from(byNum.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([, char]) => char)
    .filter(char => char.content.trim());

  return { basePrompt, characters };
}
