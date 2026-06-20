/**
 * 所长法典数据加载服务
 * 从后端 API 加载 NAI_NSFW.json 和 NAI_Common.json（Bot端data目录）
 */

import { getBackendUrl } from '../utils/apiConfig';

export interface CodexItem {
  id: string;
  category: string;
  title: string;
  content: string;
  isR18: boolean;
}

interface RawCodexItem {
  id: string;
  category: string;
  title: string;
  content: string;
}

// 缓存数据
let cachedCodexData: CodexItem[] | null = null;
let isLoading = false;
let loadPromise: Promise<CodexItem[]> | null = null;

/**
 * 加载法典数据
 * 自动合并 NSFW 和 Common 数据，并标记 isR18
 */
export async function loadCodexData(): Promise<CodexItem[]> {
  // 返回缓存
  if (cachedCodexData) {
    return cachedCodexData;
  }

  // 防止重复加载
  if (isLoading && loadPromise) {
    return loadPromise;
  }

  isLoading = true;
  loadPromise = (async () => {
    try {
      // 从设置中获取后端地址
      const backendUrl = getBackendUrl();
      
      // 并行加载两个数据文件（从后端API获取Bot端data目录）
      const [nsfwResponse, commonResponse] = await Promise.all([
        fetch(`${backendUrl}/api/data/NAI_NSFW.json`),
        fetch(`${backendUrl}/api/data/NAI_Common.json`)
      ]);

      const nsfwData: RawCodexItem[] = nsfwResponse.ok ? await nsfwResponse.json() : [];
      const commonData: RawCodexItem[] = commonResponse.ok ? await commonResponse.json() : [];

      // 合并数据并标记 isR18，为 ID 添加前缀避免冲突
      const mergedData: CodexItem[] = [
        ...nsfwData.map(item => ({ 
          ...item, 
          id: `nsfw_${item.id}`,  // 添加前缀区分
          isR18: true 
        })),
        ...commonData.map(item => ({ 
          ...item, 
          id: `common_${item.id}`,  // 添加前缀区分
          isR18: false 
        }))
      ];

      cachedCodexData = mergedData;
      console.log(`[Codex] 加载完成: ${nsfwData.length} NSFW + ${commonData.length} Common = ${mergedData.length} 条`);
      return mergedData;
    } catch (error) {
      console.error('[Codex] 数据加载失败:', error);
      return [];
    } finally {
      isLoading = false;
    }
  })();

  return loadPromise;
}

/**
 * 获取所有分类
 */
export function getCategories(data: CodexItem[]): string[] {
  return Array.from(new Set(data.map(item => item.category)));
}

/**
 * 获取统计信息
 */
export function getCodexStats(data: CodexItem[]) {
  const nsfwCount = data.filter(item => item.isR18).length;
  const commonCount = data.filter(item => !item.isR18).length;
  
  const categoryStats: Record<string, { nsfw: number; common: number }> = {};
  
  data.forEach(item => {
    if (!categoryStats[item.category]) {
      categoryStats[item.category] = { nsfw: 0, common: 0 };
    }
    if (item.isR18) {
      categoryStats[item.category].nsfw++;
    } else {
      categoryStats[item.category].common++;
    }
  });

  return {
    total: data.length,
    nsfwCount,
    commonCount,
    categoryStats
  };
}

/**
 * 清除缓存（用于刷新数据）
 */
export function clearCodexCache() {
  cachedCodexData = null;
  loadPromise = null;
}
