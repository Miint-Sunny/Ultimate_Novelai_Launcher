/**
 * NovelAI 官方服务故障横幅
 * - 仅当 status.novelai.net 有未解决事故、或整体非 Operational 时显示
 * - 用户可关闭：按 incident id 记忆，新事故再次出现会重新弹出
 * - 平时不渲染任何 DOM
 */
import React, { useEffect, useRef, useState } from 'react';
import { AlertTriangle, ExternalLink, X } from 'lucide-react';
import {
  fetchNaiStatus,
  shouldAlert,
  type NaiStatusData,
  type NaiStatusIncident,
} from '../services/naiStatus';

const POLL_MS = 60_000;
const DISMISS_KEY = 'naiStatus.dismissedIncidentIds';

function loadDismissed(): Set<string> {
  try {
    const raw = localStorage.getItem(DISMISS_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    return new Set(Array.isArray(arr) ? arr.filter((x) => typeof x === 'string') : []);
  } catch {
    return new Set();
  }
}

function saveDismissed(ids: Set<string>) {
  try {
    localStorage.setItem(DISMISS_KEY, JSON.stringify(Array.from(ids)));
  } catch { /* ignore */ }
}

function dismissKeysFor(data: NaiStatusData, incidents: NaiStatusIncident[]): string[] {
  const incidentKeys = incidents
    .map((i) => i.id || [i.name, i.datetime, i.code].filter(Boolean).join(':'))
    .filter((id): id is string => Boolean(id));

  if (incidentKeys.length > 0) return incidentKeys;

  const overall = data.overall || {};
  return [[
    'overall',
    overall.code ?? 'unknown',
    overall.updated_at || overall.status || 'unknown',
  ].join(':')];
}

/** 取严重度最高的 incident（code 越大越严重）。 */
function pickPrimary(incidents: NaiStatusIncident[]): NaiStatusIncident | null {
  if (!incidents || incidents.length === 0) return null;
  return [...incidents].sort((a, b) => (b.code ?? 0) - (a.code ?? 0))[0];
}

/** 把 status_code 映射成纯色背景（无渐变）。 */
function severityStyle(code: number | undefined): { bg: string; fg: string } {
  if (code && code >= 500) return { bg: '#B91C1C', fg: '#FFFFFF' };       // 红：服务中断 / 安全事件
  if (code && code >= 300) return { bg: '#C2410C', fg: '#FFFFFF' };       // 橙：降级 / 部分中断
  if (code === 200) return { bg: '#1D4ED8', fg: '#FFFFFF' };              // 蓝：维护
  return { bg: '#C2410C', fg: '#FFFFFF' };
}

/** 严重度中文标签（前置 badge）：让用户一眼明白这是 NAI 上游的问题。 */
function severityLabel(code: number | undefined): string {
  if (typeof code !== 'number') return 'NovelAI 上游异常';
  if (code >= 600) return 'NovelAI 安全事件';
  if (code >= 500) return 'NovelAI 上游故障';
  if (code === 400) return 'NovelAI 部分服务中断';
  if (code >= 300) return 'NovelAI 性能下降';
  if (code === 200) return 'NovelAI 计划维护';
  return 'NovelAI 上游异常';
}

/** 状态本地化（status_code → 中文）。无匹配时回落到原字符串。 */
function localizeStatus(code: number | undefined, fallback?: string): string {
  switch (code) {
    case 100: return '正常运行';
    case 200: return '维护中';
    case 300: return '性能下降';
    case 400: return '部分服务中断';
    case 500: return '服务中断';
    case 600: return '安全事件';
  }
  return fallback || '异常';
}

/** NAI 状态页固定的 5 个组件名翻译。后续若新增组件直接显示英文原名。 */
const COMPONENT_ZH: Record<string, string> = {
  'Website': '官网',
  'Image Generation': '图像生成',
  'Text Generation': '文本生成',
  'Login': '登录',
  'Payments': '支付',
};
const localizeComponent = (name: string) => COMPONENT_ZH[name] || name;

export const NaiStatusBanner: React.FC = () => {
  const [data, setData] = useState<NaiStatusData | null>(null);
  const [dismissed, setDismissed] = useState<Set<string>>(() => loadDismissed());
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    const ac = new AbortController();

    const tick = async () => {
      const res = await fetchNaiStatus(ac.signal);
      if (cancelled) return;
      setData(res?.ok ? res.data : null);
    };

    tick();
    timerRef.current = window.setInterval(tick, POLL_MS);
    return () => {
      cancelled = true;
      ac.abort();
      if (timerRef.current) {
        window.clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };
  }, []);

  if (!shouldAlert(data) || !data) return null;

  const incidents = data.incidents || [];
  // 全部当前事故都已被用户关闭过 → 不显示
  const dismissKeys = dismissKeysFor(data, incidents);
  if (dismissKeys.length > 0 && dismissKeys.every((id) => dismissed.has(id))) return null;

  const primary = pickPrimary(incidents);
  const severityCode = primary?.code ?? data.overall?.code;
  const { bg, fg } = severityStyle(typeof severityCode === 'number' ? severityCode : undefined);

  const leader = severityLabel(typeof severityCode === 'number' ? severityCode : undefined);
  // 标题：NAI 官方填的事故名（英文）。无 incident 时回落到本地化 overall 状态。
  const title = primary?.name || localizeStatus(data.overall?.code, data.overall?.status);
  // 副标题：本地化的状态 + 受影响组件中文名
  const subTitle = primary
    ? [
        localizeStatus(primary.code, primary.status),
        primary.components.map(localizeComponent).join(' / '),
      ].filter(Boolean).join(' · ')
    : '官方状态页非全部组件正常运行';
  const link = primary?.url || data.page_url;

  const handleDismiss = () => {
    const next = new Set(dismissed);
    dismissKeys.forEach((id) => next.add(id));
    setDismissed(next);
    saveDismissed(next);
  };

  return (
    <div
      role="alert"
      className="fixed top-0 left-0 right-0 z-[100] px-3 py-2 flex items-center gap-3 text-sm border-b border-black/30 shadow-md pointer-events-auto"
      style={{ backgroundColor: bg, color: fg }}
    >
      <AlertTriangle className="w-4 h-4 shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="font-medium flex items-center gap-2 min-w-0">
          <span className="inline-flex items-center px-1.5 py-0.5 rounded bg-black/30 text-[11px] font-semibold whitespace-nowrap shrink-0 tracking-wide">
            {leader}
          </span>
          <span className="truncate min-w-0">{title}</span>
        </div>
        {subTitle && <div className="truncate opacity-90 text-xs mt-0.5">{subTitle}</div>}
      </div>
      <a
        href={link}
        target="_blank"
        rel="noopener noreferrer"
        className="hidden sm:inline-flex items-center gap-1 px-2 py-1 rounded bg-black/25 hover:bg-black/40 transition-colors"
        title="查看官方状态页"
      >
        详情
        <ExternalLink className="w-3.5 h-3.5" />
      </a>
      <button
          type="button"
          onClick={handleDismiss}
          className="p-1 rounded hover:bg-black/25 transition-colors"
          title="关闭提醒（新事故再次出现时仍会弹出）"
          aria-label="关闭"
        >
          <X className="w-4 h-4" />
      </button>
    </div>
  );
};

export default NaiStatusBanner;
