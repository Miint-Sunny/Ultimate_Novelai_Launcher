import { sidecarApi } from '../../api/sidecar';

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

  try {
    const data = await sidecarApi.getJson<{ crs?: PublicCRData[] }>('/api/cr/list');
    const crs = data.crs || [];
    publicCRCache = crs;
    return crs;
  } catch (error) {
    console.error('获取公共CR列表失败:', error);
    return [];
  }
}

export function getPublicCRPreviewUrl(crId: string): string {
  return sidecarApi.url(`/api/cr/preview/${encodeURIComponent(crId)}`);
}

export async function createPublicCR(
  params: CreateCRParams
): Promise<{ success: boolean; message: string; cr?: PublicCRData }> {
  try {
    const data = await sidecarApi.postJson<{ message?: string; cr?: PublicCRData }>('/api/cr/create', params);
    clearPublicCRCache();
    return { success: true, message: data.message || '创建成功', cr: data.cr };
  } catch (error) {
    console.error('创建公共CR失败:', error);
    return { success: false, message: String(error) };
  }
}

export async function deletePublicCR(crId: string): Promise<{ success: boolean; message: string }> {
  try {
    const data = await sidecarApi.deleteJson<{ message?: string }>(`/api/cr/${encodeURIComponent(crId)}`);
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
  try {
    const data = await sidecarApi.putJson<{ message?: string; cr?: PublicCRData }>(
      `/api/cr/${encodeURIComponent(crId)}`,
      params,
    );
    clearPublicCRCache();
    return { success: true, message: data.message || '更新成功', cr: data.cr };
  } catch (error) {
    console.error('更新公共CR失败:', error);
    return { success: false, message: String(error) };
  }
}
