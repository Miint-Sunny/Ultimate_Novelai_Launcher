import { getBackendUrl } from '../../utils/apiConfig';

export interface PublicCRData {
  id: string;
  name: string;
  preview_url: string | null;
  created_time: number;
}

export interface CreateCRParams {
  name: string;
  image_base64: string;
  zh_names?: string[];
}

export interface UpdateCRParams {
  name?: string;
  zh_names?: string[];
}

let publicCRCache: PublicCRData[] | null = null;

export function clearPublicCRCache(): void {
  publicCRCache = null;
}

export async function getPublicCRs(): Promise<PublicCRData[]> {
  if (publicCRCache) return publicCRCache;

  const backendUrl = getBackendUrl();
  try {
    const response = await fetch(`${backendUrl}/api/cr/list`);
    if (!response.ok) {
      console.error('获取公共CR列表失败:', response.status);
      return [];
    }
    const data = await response.json();
    const crs = data.crs || [];
    publicCRCache = crs;
    return crs;
  } catch (error) {
    console.error('获取公共CR列表失败:', error);
    return [];
  }
}

export function getPublicCRPreviewUrl(crId: string): string {
  return `${getBackendUrl()}/api/cr/preview/${encodeURIComponent(crId)}`;
}

export async function createPublicCR(
  params: CreateCRParams
): Promise<{ success: boolean; message: string; cr?: PublicCRData }> {
  const backendUrl = getBackendUrl();
  try {
    const response = await fetch(`${backendUrl}/api/cr/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    });
    const data = await response.json();
    if (!response.ok) {
      return { success: false, message: data.detail || `HTTP ${response.status}` };
    }
    clearPublicCRCache();
    return { success: true, message: data.message || '创建成功', cr: data.cr };
  } catch (error) {
    console.error('创建公共CR失败:', error);
    return { success: false, message: String(error) };
  }
}

export async function deletePublicCR(crId: string): Promise<{ success: boolean; message: string }> {
  const backendUrl = getBackendUrl();
  try {
    const response = await fetch(`${backendUrl}/api/cr/${encodeURIComponent(crId)}`, {
      method: 'DELETE',
    });
    const data = await response.json();
    if (!response.ok) {
      return { success: false, message: data.detail || `HTTP ${response.status}` };
    }
    clearPublicCRCache();
    return { success: true, message: data.message || '删除成功' };
  } catch (error) {
    console.error('删除公共CR失败:', error);
    return { success: false, message: String(error) };
  }
}

export async function updatePublicCR(
  crId: string,
  params: UpdateCRParams
): Promise<{ success: boolean; message: string; cr?: PublicCRData }> {
  const backendUrl = getBackendUrl();
  try {
    const response = await fetch(`${backendUrl}/api/cr/${encodeURIComponent(crId)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    });
    const data = await response.json();
    if (!response.ok) {
      return { success: false, message: data.detail || `HTTP ${response.status}` };
    }
    clearPublicCRCache();
    return { success: true, message: data.message || '更新成功', cr: data.cr };
  } catch (error) {
    console.error('更新公共CR失败:', error);
    return { success: false, message: String(error) };
  }
}
