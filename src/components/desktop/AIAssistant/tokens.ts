/**
 * 设计 token 常量（与 design_handoff_ai_assistant/ai-tokens.css 一致）。
 *
 * 为什么不直接挂 tailwind config：
 *  - 避免改全局 theme.extend 影响别的组件
 *  - 用 arbitrary value（bg-[#131724]）+ 这里的命名常量做心智锚点
 */

export const C = {
  bg: '#0e0f11',
  bgDeep: '#070809',
  panel: '#151719', // 与全局 nai-panel 同值,治好展开/收起两态分界线变色的问题
  panel2: '#1e2023',
  surface: '#26282a',
  surfaceHover: '#303235',

  line: 'rgba(255,255,255,0.06)',
  line2: 'rgba(255,255,255,0.10)',
  border: '#303235',
  borderStrong: '#444649',

  text: '#f6f6f6',
  text2: '#cbccce',
  textDim: '#8c8e8f',
  textMute: '#5d5f61',
  textFaint: '#6f7173', // 比原稿提亮一档，避免在深底上几乎不可见

  accent: '#fceda4',
  accent2: '#ebd576',
  accentSoft: 'rgba(252,237,164,0.14)',
  accentLine: 'rgba(252,237,164,0.28)',

  ok: 'oklch(74% 0.15 152)',
  okBg: 'oklch(36% 0.08 152 / 0.35)',
  err: 'oklch(72% 0.18 22)',
  errBg: 'oklch(38% 0.10 22 / 0.35)',

  diffAddBg: 'rgba(124,220,165,0.10)',
  diffAddBorder: 'rgba(124,220,165,0.35)',
  diffRemBg: 'rgba(240,130,130,0.10)',
  diffRemBorder: 'rgba(240,130,130,0.35)',
} as const;

export const MONO =
  "'JetBrains Mono', 'IBM Plex Mono', ui-monospace, SFMono-Regular, Menlo, monospace";

export const PANEL_W = 400;
export const PANEL_H = 540;

/** 把后端返回的 prompt 字符串（逗号分隔）切成 tag 数组 */
export function splitPromptToTags(prompt: string | undefined): string[] {
  if (!prompt) return [];
  return prompt
    .split(',')
    .map(t => t.trim())
    .filter(t => t.length > 0);
}

/** 当前时间 'HH:mm' */
export function fmtTimeHM(ts: number): string {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

/** 'M/d HH:mm' */
export function fmtDateShort(ts: number): string {
  const d = new Date(ts);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(
    2,
    '0',
  )}:${String(d.getMinutes()).padStart(2, '0')}`;
}
