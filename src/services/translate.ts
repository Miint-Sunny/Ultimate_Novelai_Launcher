/**
 * 翻译服务 - 调用 AI API 进行翻译
 * - 英译中：用于翻译预览
 * - 中译英：用于将提示词中的中文替换为英文
 */

import { sidecarApi } from '../api/sidecar';

export interface ChatMessage {
  role: string;
  content: string;
}

export async function requestSidecarChatCompletion(
  messages: ChatMessage[],
  temperature = 0.3,
  maxTokens = 1000
): Promise<any> {
  return sidecarApi.postJson('/api/translate/en2zh', {
      messages,
      temperature,
      max_tokens: maxTokens,
  });
}

// ==================== 标签翻译映射库 ====================

/**
 * 标准化 tag key（与后端一致：小写 + 下划线）
 */
function normalizeTag(tag: string): string {
  return tag.trim().toLowerCase().replace(/\s+/g, '_');
}

/**
 * 批量查询映射库
 */
async function lookupTagTranslations(tags: string[]): Promise<Record<string, string>> {
  if (tags.length === 0) return {};
  // 标准化后去重查询
  const normalizedMap = new Map<string, string[]>(); // normalized -> original tags
  for (const tag of tags) {
    const key = normalizeTag(tag);
    if (!normalizedMap.has(key)) normalizedMap.set(key, []);
    normalizedMap.get(key)!.push(tag);
  }
  try {
    const data = await sidecarApi.postJson<Record<string, string>>('/api/tags/translations/lookup', {
      tags: [...normalizedMap.keys()],
    });
    // 将结果映射回所有原始 tag 形式
    const result: Record<string, string> = {};
    for (const [normalized, zh] of Object.entries(data)) {
      const originals = normalizedMap.get(normalized) || [normalized];
      for (const orig of originals) {
        result[orig] = zh;
      }
    }
    return result;
  } catch (e) {
    console.warn('[TagTranslations] lookup failed:', e);
  }
  return {};
}

/**
 * 批量提交翻译结果到映射库（fire-and-forget）
 */
function submitTagTranslations(entries: { tag: string; zh: string; source: 'ai' | 'wiki' }[]): void {
  if (entries.length === 0) return;
  sidecarApi.postJson('/api/tags/translations/submit', { entries }).catch(() => {});
}

// 导出供 tagAutocomplete 使用
export { submitTagTranslations, lookupTagTranslations };

/**
 * 去除权重符号，返回纯文本和前后缀
 * 支持格式：{}, [], (), 以及双冒号权重 1.5::text::0.8
 */
function stripWeights(text: string): { prefix: string; content: string; suffix: string } {
  let prefix = '';
  let suffix = '';
  let content = text;
  
  // 匹配开头的权重符号 {, [, ( 或双冒号权重 数字::
  const prefixMatch = content.match(/^([\{\[\(]+|\d+\.?\d*::)/);
  if (prefixMatch) {
    prefix = prefixMatch[1];
    content = content.slice(prefix.length);
  }
  
  // 匹配结尾的权重符号 }, ], ) 和数字权重 :1.2 或双冒号 ::数字
  const suffixMatch = content.match(/([\}\]\)]+)?(:\d+\.?\d*)?(::[\d\.]+)?$/);
  if (suffixMatch && suffixMatch[0]) {
    suffix = suffixMatch[0];
    content = content.slice(0, -suffix.length);
  }
  
  return { prefix, content: content.trim(), suffix };
}

/**
 * 检查是否是画师标签（不需要翻译）
 */
function isArtistTag(text: string): boolean {
  const lower = text.toLowerCase();
  return lower.startsWith('artist:') || lower.includes('artist:');
}

/**
 * 提取需要翻译的片段（非中文的英文标签）
 */
function extractEnglishSegments(text: string): string[] {
  // 按逗号分割
  const parts = text.split(/[,，]/);
  const segments: string[] = [];
  
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    
    // 跳过纯中文片段，只翻译包含英文的
    const englishChars = (trimmed.match(/[a-zA-Z]/g) || []).length;
    if (englishChars > 0) {
      segments.push(trimmed);
    }
  }
  
  return segments;
}

/**
 * 检查文本是否包含中文字符
 */
export function containsChinese(text: string): boolean {
  // 匹配中文字符（包括常用汉字范围）
  return /[\u4e00-\u9fff\u3400-\u4dbf]/.test(text);
}

/**
 * 提取包含中文的片段（用于中译英）
 */
function extractChineseSegments(text: string): string[] {
  // 按逗号分割
  const parts = text.split(/[,，]/);
  const segments: string[] = [];
  
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    
    // 只提取包含中文的片段
    if (containsChinese(trimmed)) {
      segments.push(trimmed);
    }
  }
  
  return segments;
}

/**
 * 预处理片段：去除权重符号，提取纯文本用于翻译
 */
function preprocessSegments(segments: string[]): {
  cleanTexts: string[];
  metadata: Array<{ original: string; prefix: string; suffix: string; skip: boolean }>;
} {
  const cleanTexts: string[] = [];
  const metadata: Array<{ original: string; prefix: string; suffix: string; skip: boolean }> = [];
  
  for (const seg of segments) {
    const { prefix, content, suffix } = stripWeights(seg);
    
    // 检查是否需要跳过（画师标签等）
    const skip = isArtistTag(content) || !content;
    
    metadata.push({ original: seg, prefix, suffix, skip });
    cleanTexts.push(skip ? content : content);
  }
  
  return { cleanTexts, metadata };
}

/**
 * 调用 Gemini API 翻译英文片段为中文
 */
export async function translateSegments(segments: string[]): Promise<string[]> {
  if (segments.length === 0) return [];
  
  // 预处理：去除权重符号
  const { cleanTexts, metadata } = preprocessSegments(segments);
  
  // 过滤出需要翻译的文本
  const toTranslate: string[] = [];
  const translateIndices: number[] = [];
  
  for (let i = 0; i < cleanTexts.length; i++) {
    if (!metadata[i].skip && cleanTexts[i]) {
      toTranslate.push(cleanTexts[i]);
      translateIndices.push(i);
    }
  }
  
  if (toTranslate.length === 0) {
    return segments; // 没有需要翻译的，返回原文
  }
  
  // 第一步：查映射库
  const cached = await lookupTagTranslations(toTranslate);
  const stillNeedTranslate: string[] = [];
  const stillNeedIndices: number[] = [];
  
  for (let i = 0; i < toTranslate.length; i++) {
    if (cached[toTranslate[i]]) {
      // 映射库命中，不需要 AI 翻译
    } else {
      stillNeedTranslate.push(toTranslate[i]);
      stillNeedIndices.push(i);
    }
  }
  
  // 如果全部命中映射库，直接构建结果
  let aiTranslated: string[] | null = null;
  
  if (stillNeedTranslate.length > 0) {
    // 第二步：未命中的走 AI 翻译
    const instruction = `你是Danbooru标签翻译器，负责将Danbooru/NovelAI绘画标签从英文翻译为中文。
这些标签用于AI绘画（Stable Diffusion/NovelAI），请在绘画语境下理解含义。
翻译要求：
1. 简洁准确，符合绘画标签的含义（如 "1girl" → "1个女孩"，"masterpiece" → "杰作"）
2. 角色名、画师名（artist:xxx）等专有名词保持原样不翻译
3. 身体部位、服装、姿势等按绘画描述语境翻译
4. 返回格式必须是JSON数组，顺序与输入一致

Input: ${JSON.stringify(stillNeedTranslate, null, 0)}

只返回JSON数组，不要其他内容。`;

    try {
      const messages = [{ role: 'user', content: instruction }];
      const data = await requestSidecarChatCompletion(messages, 0.3, 4000);
      const content = data.choices?.[0]?.message?.content || '';
    
    // 解析 JSON 数组
    aiTranslated = parseJsonArray(content);
    
    // AI 翻译结果回写映射库
    if (aiTranslated && aiTranslated.length === stillNeedTranslate.length) {
      const entries = stillNeedTranslate.map((tag, idx) => ({
        tag,
        zh: aiTranslated![idx],
        source: 'ai' as const,
      })).filter(e => e.zh && e.zh !== e.tag);
      submitTagTranslations(entries);
    }
    } catch (error) {
      console.error('[Translate] API 调用失败:', error);
    }
  } // end if stillNeedTranslate
    
  // 第三步：合并映射库结果 + AI 结果，构建最终输出
  // 为 toTranslate 数组构建完整的翻译结果
  const mergedTranslations: (string | null)[] = [];
  let aiIdx = 0;
  for (let i = 0; i < toTranslate.length; i++) {
    if (cached[toTranslate[i]]) {
      mergedTranslations.push(cached[toTranslate[i]]);
    } else if (aiTranslated && aiIdx < aiTranslated.length) {
      mergedTranslations.push(aiTranslated[aiIdx]);
      aiIdx++;
    } else {
      mergedTranslations.push(null);
    }
  }
  
  // 还原到 segments 数组
  const results: string[] = [];
  let transIdx = 0;
  
  for (let i = 0; i < segments.length; i++) {
    const meta = metadata[i];
    
    if (meta.skip) {
      results.push(segments[i]);
    } else if (translateIndices.includes(i)) {
      const translated = mergedTranslations[transIdx];
      if (translated) {
        results.push(meta.prefix + translated + meta.suffix);
      } else {
        results.push(segments[i]);
      }
      transIdx++;
    } else {
      results.push(segments[i]);
    }
  }
    
  return results;
}

/**
 * 解析 JSON 数组（处理各种格式）
 */
function parseJsonArray(text: string): string[] | null {
  let s = text.trim();
  
  // 移除 markdown 代码块
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  
  try {
    const arr = JSON.parse(s);
    if (Array.isArray(arr)) {
      return arr.map(x => String(x));
    }
  } catch {
    // 尝试提取 JSON 数组
    const match = s.match(/\[[\s\S]*?\]/);
    if (match) {
      try {
        const arr = JSON.parse(match[0]);
        if (Array.isArray(arr)) {
          return arr.map(x => String(x));
        }
      } catch {
        // 忽略
      }
    }
  }
  
  return null;
}

/**
 * 批量翻译（同时翻译正向和负向提示词）- 英译中
 */
export async function translatePrompts(
  positivePrompt: string, 
  negativePrompt: string
): Promise<{
  positive: Map<string, string>;
  negative: Map<string, string>;
}> {
  // 提取所有英文片段
  const positiveSegments = extractEnglishSegments(positivePrompt);
  const negativeSegments = extractEnglishSegments(negativePrompt);
  
  const allSegments = [...new Set([...positiveSegments, ...negativeSegments])];
  
  if (allSegments.length === 0) {
    return {
      positive: new Map(),
      negative: new Map()
    };
  }
  
  const translations = await translateSegments(allSegments);
  
  // 构建全局映射
  const globalMap = new Map<string, string>();
  for (let i = 0; i < allSegments.length; i++) {
    globalMap.set(allSegments[i], translations[i] || allSegments[i]);
  }
  
  // 分别构建正向和负向的映射
  const positiveMap = new Map<string, string>();
  const negativeMap = new Map<string, string>();
  
  for (const seg of positiveSegments) {
    positiveMap.set(seg, globalMap.get(seg) || seg);
  }
  
  for (const seg of negativeSegments) {
    negativeMap.set(seg, globalMap.get(seg) || seg);
  }
  
  return {
    positive: positiveMap,
    negative: negativeMap
  };
}

/**
 * 调用 AI API 将中文片段翻译为英文
 */
async function translateChineseToEnglish(segments: string[]): Promise<string[]> {
  if (segments.length === 0) return [];
  
  // 预处理：去除权重符号
  const { cleanTexts, metadata } = preprocessSegments(segments);
  
  // 过滤出需要翻译的文本（包含中文的）
  const toTranslate: string[] = [];
  const translateIndices: number[] = [];
  
  for (let i = 0; i < cleanTexts.length; i++) {
    if (!metadata[i].skip && cleanTexts[i] && containsChinese(cleanTexts[i])) {
      toTranslate.push(cleanTexts[i]);
      translateIndices.push(i);
    }
  }
  
  if (toTranslate.length === 0) {
    return segments; // 没有需要翻译的，返回原文
  }
  
  const instruction = `你是一个专业的AI绘画提示词翻译器，负责将中文标签翻译为英文。
翻译要求：
1. 翻译结果需符合NovelAI/Stable Diffusion提示词规范
2. 使用常见的英文tag格式，如 "1girl", "long hair", "blue eyes" 等
3. 保持简洁，不要过度修饰
4. 角色名、画师名等专有名词保持原样或使用罗马音
5. 用户可能会直接用几句话描述生成内容，需要将其转换为英文tag标签
6. 返回格式必须是JSON数组，顺序与输入一致

Input: ${JSON.stringify(toTranslate, null, 0)}

只返回JSON数组，不要其他内容。`;

  try {
    const messages = [{ role: 'user', content: instruction }];
    const data = await requestSidecarChatCompletion(messages, 0.3, 4000);
    const content = data.choices?.[0]?.message?.content || '';
    
    // 解析 JSON 数组
    const parsed = parseJsonArray(content);
    
    // 构建最终结果，还原权重符号
    const results: string[] = [];
    let translatedIdx = 0;
    
    for (let i = 0; i < segments.length; i++) {
      const meta = metadata[i];
      
      if (meta.skip || !containsChinese(cleanTexts[i])) {
        // 跳过的或不含中文的直接返回原文
        results.push(segments[i]);
      } else if (parsed && translatedIdx < parsed.length && translateIndices.includes(i)) {
        // 有翻译结果，还原权重符号
        const translated = parsed[translateIndices.indexOf(i)];
        results.push(meta.prefix + translated + meta.suffix);
        translatedIdx++;
      } else {
        // 翻译失败，返回原文
        results.push(segments[i]);
      }
    }
    
    return results;
  } catch (error) {
    console.error('[Translate] 中译英 API 调用失败:', error);
    return segments;
  }
}

/**
 * 中译英：将提示词中的中文部分翻译为英文并替换
 * 返回替换后的完整提示词
 */
export async function translateChineseInPrompt(prompt: string): Promise<string> {
  if (!prompt.trim()) return prompt;
  
  // 按逗号分割
  const parts = prompt.split(/([,，])/);
  const segments: string[] = [];
  const separators: string[] = [];
  
  // 分离标签和分隔符
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 0) {
      segments.push(parts[i]);
    } else {
      separators.push(parts[i]);
    }
  }
  
  // 找出包含中文的片段
  const chineseIndices: number[] = [];
  const chineseSegments: string[] = [];
  
  for (let i = 0; i < segments.length; i++) {
    const trimmed = segments[i].trim();
    if (trimmed && containsChinese(trimmed)) {
      chineseIndices.push(i);
      chineseSegments.push(trimmed);
    }
  }
  
  if (chineseSegments.length === 0) {
    return prompt; // 没有中文，返回原文
  }
  
  // 翻译中文片段
  const translations = await translateChineseToEnglish(chineseSegments);
  
  // 替换原文中的中文片段
  for (let i = 0; i < chineseIndices.length; i++) {
    const idx = chineseIndices[i];
    const original = segments[idx];
    const translated = translations[i];
    
    // 保留原始的前后空格
    const leadingSpace = original.match(/^\s*/)?.[0] || '';
    const trailingSpace = original.match(/\s*$/)?.[0] || '';
    
    segments[idx] = leadingSpace + translated + trailingSpace;
  }
  
  // 重新组合
  let result = '';
  for (let i = 0; i < segments.length; i++) {
    result += segments[i];
    if (i < separators.length) {
      result += separators[i];
    }
  }
  
  return result;
}


/**
 * 将中文短句翻译为英文自然语言描述（非标签格式）
 * 用于直接作为 NAI 的自然语言 tag
 */
export async function translateToNaturalLanguage(chineseText: string): Promise<string> {
  if (!chineseText.trim()) return chineseText;

  const instruction = `你是一个专业的AI绘画提示词翻译器。将用户输入的中文描述翻译为英文自然语言短句，用于NovelAI图像生成。
要求：
1. 翻译为流畅的英文短句/短语，不要转换为标签格式
2. 保持描述性和画面感，适合作为AI绘画的自然语言提示词
3. 不要添加额外的修饰或解释
4. 只返回翻译结果，不要其他内容

中文输入：${chineseText}`;

  try {
    const messages = [{ role: 'user', content: instruction }];
    const data = await requestSidecarChatCompletion(messages, 0.3, 500);
    const content = data.choices?.[0]?.message?.content?.trim() || '';
    return content || chineseText;
  } catch (error) {
    console.error('[Translate] 自然语言翻译失败:', error);
    return chineseText;
  }
}
