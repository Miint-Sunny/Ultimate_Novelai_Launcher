import { appBackendApi } from '../../api/appBackendApi';

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
const crPreviewUrls = new Map<string, string>();

export function clearPublicCRCache(): void {
  publicCRCache = null;
  crPreviewUrls.clear();
  appBackendApi.revokeObjectUrls('/api/cr/preview/');
}

export async function getPublicCRs(): Promise<PublicCRData[]> {
  if (publicCRCache) return hydrateCRPreviews(publicCRCache);

  try {
    const data = await appBackendApi.getJson<{ crs?: PublicCRData[] }>('/api/cr/list');
    const crs = data.crs || [];
    publicCRCache = crs;
    return hydrateCRPreviews(crs);
  } catch (error) {
    console.error('获取公共CR列表失败:', error);
    return [];
  }
}

export function getPublicCRPreviewUrl(crId: string): string {
  return crPreviewUrls.get(crId) || '';
}

async function hydrateCRPreviews(crs: PublicCRData[]): Promise<PublicCRData[]> {
  return Promise.all(crs.map(async cr => {
    if (!cr.preview_url) return cr;
    const path = `/api/cr/preview/${encodeURIComponent(cr.id)}`;
    try {
      const preview = await appBackendApi.objectUrl(path);
      crPreviewUrls.set(cr.id, preview);
      return { ...cr, preview_url: preview };
    } catch {
      return { ...cr, preview_url: null };
    }
  }));
}

export async function createPublicCR(
  params: CreateCRParams
): Promise<{ success: boolean; message: string; cr?: PublicCRData }> {
  try {
    const data = await appBackendApi.postJson<{ message?: string; cr?: PublicCRData }>('/api/cr/create', params);
    clearPublicCRCache();
    return { success: true, message: data.message || '创建成功', cr: data.cr };
  } catch (error) {
    console.error('创建公共CR失败:', error);
    return { success: false, message: String(error) };
  }
}

export async function deletePublicCR(crId: string): Promise<{ success: boolean; message: string }> {
  try {
    const data = await appBackendApi.deleteJson<{ message?: string }>(`/api/cr/${encodeURIComponent(crId)}`);
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
    const data = await appBackendApi.putJson<{ message?: string; cr?: PublicCRData }>(
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
