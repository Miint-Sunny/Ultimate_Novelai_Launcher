import React, { useState, useEffect, useRef } from 'react';
import { BarChart3, Zap, Clock, ChevronDown, ChevronUp } from 'lucide-react';
import { appBackendApi } from '../api/appBackendApi';
import { botService } from '../services/botService';

/* ---------- Types ---------- */
interface TypeBreakdownItem {
  reason: string;
  total_points: number;
  count: number;
}

interface DailyDataItem {
  date: string;
  image_calls: number;
  points_spent: number;
}

interface RecordItem {
  timestamp: string;
  points: number;
  reason: string;
}

interface UsageDetailData {
  total_image_calls: number;
  total_points: number;
  type_breakdown: TypeBreakdownItem[];
  daily_data: DailyDataItem[];
  recent_records: RecordItem[];
}

type DetailTab = 'types' | 'daily' | 'records';

/* ---------- Helpers ---------- */
function getReasonStyle(reason: string): { icon: string; color: string; bg: string } {
  if (!reason) return { icon: '?', color: '#71717a', bg: 'rgba(113,113,122,0.2)' };
  const r = reason.toLowerCase();
  if (r.includes('vibe') || r.includes('编码')) return { icon: '🎨', color: '#a78bfa', bg: 'rgba(167,139,250,0.2)' };
  if (r.includes('超分')) return { icon: '🔍', color: '#34d399', bg: 'rgba(52,211,153,0.2)' };
  if (r.includes('角色参考') || r.includes('precise') || r.includes('pr')) return { icon: '👤', color: '#60a5fa', bg: 'rgba(96,165,250,0.2)' };
  if (r.includes('生图') || r.includes('image') || r.includes('gen')) return { icon: '🖼', color: '#fb923c', bg: 'rgba(251,146,60,0.2)' };
  if (r.includes('香蕉') || r.includes('banana')) return { icon: '🍌', color: '#fbbf24', bg: 'rgba(251,191,36,0.2)' };
  return { icon: '⚡', color: '#e4e4e7', bg: 'rgba(228,228,231,0.15)' };
}

/* ---------- Props ---------- */
interface UsageDetailPanelProps {
  userId: string;
  /** Pass period_start & period_end ISO strings for 27-day cycle query */
  periodStart?: string;
  periodEnd?: string;
  /** Or use "current" / "prev" shortcut */
  period?: 'current' | 'prev';
  /** Inline collapsed mode — starts collapsed with a toggle button */
  collapsible?: boolean;
  /** Initial expanded state when collapsible */
  defaultExpanded?: boolean;
}

export const UsageDetailPanel: React.FC<UsageDetailPanelProps> = ({
  userId,
  periodStart,
  periodEnd,
  period = 'current',
  collapsible = true,
  defaultExpanded = false,
}) => {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [activeTab, setActiveTab] = useState<DetailTab>('types');
  const [data, setData] = useState<UsageDetailData | null>(null);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const dailyScrollRef = useRef<HTMLDivElement>(null);

  const fetchData = async () => {
    if (loaded || loading || !userId) return;
    setLoading(true);
    try {
      const params = new URLSearchParams({ user_id: userId });
      // 后端按会话推导目标用户（普通用户仅限本人，管理员可查任意 user_id）。
      const sessionId = botService.getAuthState().sessionId;
      if (sessionId) params.set('session_id', sessionId);
      if (periodStart && periodEnd) {
        params.set('period_start', periodStart);
        params.set('period_end', periodEnd);
      } else {
        params.set('period', period);
      }
      const res = await appBackendApi.request(`/api/billing/user/details?${params}`);
      if (res.ok) {
        setData(await res.json());
        setLoaded(true);
      }
    } catch (e) {
      console.error('Failed to load usage details:', e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (expanded && !loaded) {
      fetchData();
    }
  }, [expanded]);

  // Non-collapsible: load immediately
  useEffect(() => {
    if (!collapsible) {
      setExpanded(true);
    }
  }, [collapsible]);

  const handleToggle = () => {
    setExpanded(v => !v);
  };

  // Computed
  const maxTypePoints = data ? Math.max(...data.type_breakdown.map(t => t.total_points), 1) : 1;
  const maxDailyImg = data ? Math.max(...data.daily_data.map(d => d.image_calls), 1) : 1;
  const maxDailyPts = data ? Math.max(...data.daily_data.map(d => d.points_spent), 1) : 1;

  return (
    <div className="bg-gray-800/50 rounded-lg overflow-hidden">
      {/* Toggle button */}
      {collapsible && (
        <button
          onClick={handleToggle}
          className="w-full flex items-center justify-center gap-1.5 py-2 text-xs text-gray-400 hover:text-gray-200 transition-colors"
        >
          <BarChart3 className="w-3.5 h-3.5" />
          查看使用详情
          {expanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
        </button>
      )}

      {/* Content */}
      {expanded && (
        <div className={`px-3 pb-3 space-y-3 ${collapsible ? 'pt-0' : 'pt-3'}`}>
          {loading ? (
            <div className="text-center text-gray-500 text-xs py-4">加载使用详情...</div>
          ) : !data ? (
            <div className="text-center text-gray-500 text-xs py-4">无法加载</div>
          ) : (
            <>
              {/* Summary strip */}
              <div className="flex gap-3 justify-center">
                <div className="text-center">
                  <div className="text-sm font-bold text-blue-400">{data.total_image_calls.toLocaleString()}</div>
                  <div className="text-[10px] text-gray-500">生图次数</div>
                </div>
                <div className="text-center">
                  <div className="text-sm font-bold text-orange-400">{data.total_points.toLocaleString()}</div>
                  <div className="text-[10px] text-gray-500">总消耗点数</div>
                </div>
                <div className="text-center">
                  <div className="text-sm font-bold text-purple-400">{data.type_breakdown.length}</div>
                  <div className="text-[10px] text-gray-500">消耗类型</div>
                </div>
              </div>

              {/* Tabs */}
              <div className="flex gap-1 bg-gray-900/50 rounded-lg p-0.5">
                {([
                  { key: 'types' as DetailTab, label: '消耗类型', icon: Zap },
                  { key: 'daily' as DetailTab, label: '每日统计', icon: BarChart3 },
                  { key: 'records' as DetailTab, label: '消耗记录', icon: Clock },
                ]).map(tab => (
                  <button
                    key={tab.key}
                    onClick={() => setActiveTab(tab.key)}
                    className={`flex-1 flex items-center justify-center gap-1 py-1.5 text-[11px] rounded-md transition-colors ${
                      activeTab === tab.key
                        ? 'bg-gray-700/80 text-white'
                        : 'text-gray-500 hover:text-gray-300'
                    }`}
                  >
                    <tab.icon className="w-3 h-3" />
                    {tab.label}
                  </button>
                ))}
              </div>

              {/* Tab: Type breakdown */}
              {activeTab === 'types' && (
                <div className="space-y-1.5">
                  {data.type_breakdown.length === 0 ? (
                    <div className="text-center text-gray-500 text-xs py-4">无点数消耗记录</div>
                  ) : (
                    data.type_breakdown.map((t, i) => {
                      const style = getReasonStyle(t.reason);
                      const pct = maxTypePoints > 0 ? (t.total_points / maxTypePoints * 100) : 0;
                      return (
                        <div key={i} className="flex items-center gap-2">
                          <div
                            className="w-6 h-6 rounded flex items-center justify-center text-xs flex-shrink-0"
                            style={{ background: style.bg, color: style.color }}
                          >
                            {style.icon}
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center justify-between mb-0.5">
                              <span className="text-[11px] text-gray-300 truncate">{t.reason || '未知'}</span>
                              <span className="text-[10px] text-gray-500 ml-2 flex-shrink-0">{t.count}次</span>
                            </div>
                            <div className="h-1.5 bg-gray-700/50 rounded-full overflow-hidden">
                              <div
                                className="h-full rounded-full transition-all"
                                style={{ width: `${pct}%`, background: style.color }}
                              />
                            </div>
                          </div>
                          <span className="text-[11px] font-mono text-gray-300 flex-shrink-0 w-14 text-right">
                            {t.total_points}点
                          </span>
                        </div>
                      );
                    })
                  )}
                </div>
              )}

              {/* Tab: Daily chart */}
              {activeTab === 'daily' && (
                <div
                  ref={dailyScrollRef}
                  className="space-y-1 max-h-60 overflow-y-auto"
                  style={{ scrollbarWidth: 'thin' }}
                >
                  {data.daily_data.length === 0 ? (
                    <div className="text-center text-gray-500 text-xs py-4">无活动数据</div>
                  ) : (
                    data.daily_data.map((d, i) => {
                      const dateStr = d.date.split('-').slice(1).join('/');
                      const imgPct = Math.max((d.image_calls / maxDailyImg * 100), d.image_calls > 0 ? 8 : 0);
                      const ptsPct = Math.max((d.points_spent / maxDailyPts * 100), d.points_spent > 0 ? 8 : 0);
                      return (
                        <div key={i} className="flex items-center gap-2">
                          <span className="text-[10px] text-gray-500 w-10 flex-shrink-0 text-right">{dateStr}</span>
                          <div className="flex-1 space-y-0.5">
                            <div className="flex items-center gap-1">
                              <span className="text-[9px] text-gray-500 w-3">图</span>
                              <div className="flex-1 h-2.5 bg-gray-700/30 rounded-full overflow-hidden">
                                <div
                                  className="h-full bg-blue-500/80 rounded-full flex items-center justify-end pr-1 text-[8px] text-white/80"
                                  style={{ width: `${imgPct}%`, minWidth: d.image_calls > 0 ? '16px' : 0 }}
                                >
                                  {d.image_calls > 0 ? d.image_calls : ''}
                                </div>
                              </div>
                            </div>
                            <div className="flex items-center gap-1">
                              <span className="text-[9px] text-gray-500 w-3">点</span>
                              <div className="flex-1 h-2.5 bg-gray-700/30 rounded-full overflow-hidden">
                                <div
                                  className="h-full bg-orange-500/80 rounded-full flex items-center justify-end pr-1 text-[8px] text-white/80"
                                  style={{ width: `${ptsPct}%`, minWidth: d.points_spent > 0 ? '16px' : 0 }}
                                >
                                  {d.points_spent > 0 ? d.points_spent : ''}
                                </div>
                              </div>
                            </div>
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
              )}

              {/* Tab: Recent records */}
              {activeTab === 'records' && (
                <div className="space-y-0.5 max-h-60 overflow-y-auto" style={{ scrollbarWidth: 'thin' }}>
                  {data.recent_records.length === 0 ? (
                    <div className="text-center text-gray-500 text-xs py-4">无消耗记录</div>
                  ) : (
                    data.recent_records.map((r, i) => {
                      const timeStr = (r.timestamp || '').replace('T', ' ').substring(0, 16);
                      const style = getReasonStyle(r.reason);
                      return (
                        <div key={i} className="flex items-center gap-2 py-1 px-1.5 rounded hover:bg-gray-700/30">
                          <span className="text-[10px] text-gray-500 w-28 flex-shrink-0">{timeStr}</span>
                          <span
                            className="text-[10px] flex-1 truncate"
                            style={{ color: style.color }}
                            title={r.reason}
                          >
                            {r.reason || '未知'}
                          </span>
                          <span className="text-[11px] font-mono text-gray-300 flex-shrink-0">{r.points}点</span>
                        </div>
                      );
                    })
                  )}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
};
