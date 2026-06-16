/**
 * NovelAI 官方服务状态查询（来自后端 /api/nai-status，转发自 status.io）。
 * 仅在出现事故时由 NaiStatusBanner 弹横幅提示，平时不展示状态。
 */
import { getBackendUrl } from '../utils/apiConfig';

// status.io status_code: 100=Operational, 200=Maintenance,
// 300=Degraded, 400=Partial Disruption, 500=Service Disruption, 600=Security Event
export type NaiStatusCode = 100 | 200 | 300 | 400 | 500 | 600 | number;

export interface NaiStatusComponent {
  id: string;
  name: string;
  status: string;
  code: NaiStatusCode;
}

export interface NaiStatusIncident {
  id: string;
  name: string;
  status: string;
  code?: NaiStatusCode;
  components: string[];
  message: string;
  url: string;
  datetime?: string;
}

export interface NaiStatusData {
  overall: {
    status: string;
    code: NaiStatusCode;
    updated_at?: string;
  };
  components: NaiStatusComponent[];
  incidents: NaiStatusIncident[];
  page_url: string;
}

export interface NaiStatusResponse {
  ok: boolean;
  fetched_at: number;
  stale_seconds: number | null;
  last_error: string;
  data: NaiStatusData | null;
}

export async function fetchNaiStatus(signal?: AbortSignal): Promise<NaiStatusResponse | null> {
  try {
    const res = await fetch(`${getBackendUrl()}/api/nai-status`, { signal });
    if (!res.ok) return null;
    return (await res.json()) as NaiStatusResponse;
  } catch {
    return null;
  }
}

/** 是否需要弹横幅：有 active incident，或整体状态非 Operational。 */
export function shouldAlert(data: NaiStatusData | null | undefined): boolean {
  if (!data) return false;
  if (data.incidents && data.incidents.length > 0) return true;
  const code = data.overall?.code;
  return typeof code === 'number' && code !== 100;
}
