import React, { useState, useEffect, useCallback, useRef } from 'react';
import { X, BarChart3, Coins, Image as ImageIcon, MessageSquare, Activity, Wallet, Layers, Receipt } from 'lucide-react';
import { appBackendApi } from '../api/appBackendApi';
import { botService } from '../services/botService';
import { PlatformStatsModal } from './PlatformStatsModal';
import { BillingSettlementModal } from './BillingSettlementModal';
import { UsageDetailPanel } from './UsageDetailPanel';

/* ---------- Billing Types ---------- */
interface BillingTiers {
  free: number;
  t1: number;
  t2: number;
}

interface BillingUser {
  user_id: string;
  nickname: string;
  image_calls: number;
  anlas_used: number;
  tier: number;
  tier_name: string;
  weight: number;
  image_fee: number;
  anlas_fee: number;
  total_fee: number;
}

interface TierDistItem {
  count: number;
  total_images: number;
  total_fee: number;
}

interface BillingReport {
  tiers: BillingTiers;
  tier_weights: number[];
  total_cost: number;
  actual_total: number;
  free_threshold: number;
  anlas_threshold: number;
  anlas_surcharge: number;
  anlas_total_surcharge: number;
  image_pool: number;
  users: BillingUser[];
  tier_distribution: Record<string, TierDistItem>;
  active_user_count: number;
  total_image_calls: number;
  total_anlas: number;
  billing_month?: string;
  is_estimate?: boolean;
  estimate_time?: string;
  current_user?: BillingUser | null;
  estimate_mode?: string;
}

/* ---------- Billing Section Component ---------- */
const TIER_COLORS: Record<string, string> = {
  '免费': '#6b7280',
  '一阶': '#3b82f6',
  '二阶': '#8b5cf6',
  '三阶': '#ef4444',
  '均摊': '#6366f1',
};
const TIER_BG: Record<string, string> = {
  '免费': 'bg-gray-600/20',
  '一阶': 'bg-blue-600/20',
  '二阶': 'bg-purple-600/20',
  '三阶': 'bg-red-600/20',
  '均摊': 'bg-indigo-600/20',
};

function BillingSection({ sessionId }: { sessionId: string | null }) {
  const [estimate, setEstimate] = useState<BillingReport | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      try {
        const res = await appBackendApi.request('/api/billing/estimate', undefined, {
          session_id: sessionId,
        });
        if (!cancelled && res.ok) setEstimate(await res.json());
      } catch (e) {
        console.error('Failed to load billing:', e);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    load();
    return () => { cancelled = true; };
  }, [sessionId]);

  if (loading) {
    return (
      <div className="bg-gray-800/50 rounded-lg p-4 text-center">
        <div className="text-gray-500 text-sm">加载账单信息...</div>
      </div>
    );
  }

  const me = estimate?.current_user;
  const tierName = me?.tier_name ?? '免费';
  const tierColor = TIER_COLORS[tierName] || '#6b7280';

  // Build tier table rows
  const tierRows: { name: string; weight: number; estFee: string }[] = [];
  if (estimate) {
    const dist = estimate.tier_distribution || {};
    const names = ['免费', '一阶', '二阶', '三阶'];
    for (let i = 0; i < names.length; i++) {
      const nm = names[i];
      const ed = dist[nm];
      const estPerUser = ed && ed.count > 0 ? Math.round(ed.total_fee / ed.count) : 0;
      const isEarly = estimate.estimate_mode === 'early';
      tierRows.push({
        name: nm,
        weight: estimate.tier_weights[i],
        estFee: nm === '免费' ? '¥0' : (isEarly ? (nm === '三阶' ? '≤¥25' : '-') : (ed ? `~¥${estPerUser}` : '-')),
      });
    }
  }

  return (
    <div className="space-y-3">
      {/* My Estimate Card */}
      <div className="bg-gray-800/50 rounded-lg p-4">
        <div className="flex items-center gap-2 mb-3">
          <Wallet className="w-4 h-4 text-nai-accent" />
          <span className="text-sm font-medium text-gray-300">本月账单预估</span>
          {estimate?.estimate_mode === 'early' && (
            <span className="px-1.5 py-0.5 rounded text-[10px] bg-orange-500/20 text-orange-400 border border-orange-500/30">
              当前为参考上月
            </span>
          )}
          <span className="ml-auto text-[10px] text-gray-500">
            {estimate?.billing_month || ''}
          </span>
        </div>

        {me ? (
          <div className="flex items-center gap-4">
            {/* Fee */}
            <div className="text-center">
              <div className="text-3xl font-extrabold" style={{ color: tierColor }}>
                ~¥{me.total_fee}
              </div>
              <div className="text-[10px] text-gray-500 mt-0.5">预估费用</div>
            </div>
            {/* Breakdown */}
            <div className="flex-1 grid grid-cols-3 gap-2 text-center">
              <div>
                <div className="text-lg font-bold text-blue-400">{me.image_calls.toLocaleString()}</div>
                <div className="text-[10px] text-gray-500">生图数</div>
              </div>
              <div>
                <div className="text-lg font-bold text-orange-400">{me.anlas_used.toLocaleString()}</div>
                <div className="text-[10px] text-gray-500">Anlas</div>
              </div>
              <div>
                <div className="text-lg font-bold" style={{ color: tierColor }}>
                  <span className={`inline-block px-1.5 py-0.5 rounded text-[11px] ${TIER_BG[tierName] || 'bg-gray-600/20'}`}>
                    {tierName}
                  </span>
                </div>
                <div className="text-[10px] text-gray-500">阶梯</div>
              </div>
            </div>
          </div>
        ) : (
          <div className="text-center text-gray-500 text-sm py-2">本月暂无生图记录，预估 ¥0</div>
        )}

        {/* Fee breakdown note */}
        {me && (me.image_fee > 0 || me.anlas_fee > 0) && (
          <div className="mt-2 text-[11px] text-gray-500 text-center">
            生图分摊 ¥{me.image_fee}
            {me.anlas_fee > 0 && <> + Anlas附加 ¥{me.anlas_fee}</>}
            {' · '}权重 {me.weight}
          </div>
        )}


      </div>

      {/* Tier Table */}
      {tierRows.length > 0 && (
        <div className="bg-gray-800/50 rounded-lg p-3">
          <div className="flex items-center gap-2 mb-2">
            <Layers className="w-3.5 h-3.5 text-gray-400" />
            <span className="text-xs font-medium text-gray-400">阶梯价目</span>
            <span className="ml-auto text-[10px] text-gray-600">人均/月</span>
          </div>
          <table className="w-full text-xs">
            <thead>
              <tr className="text-gray-500 border-b border-gray-700/50">
                <th className="py-1 text-left font-medium">阶梯</th>
                <th className="py-1 text-right font-medium">预估人均</th>
              </tr>
            </thead>
            <tbody>
              {tierRows.map(r => (
                <tr key={r.name} className={`border-b border-gray-800/50 ${me?.tier_name === r.name ? 'bg-nai-accent/5' : ''}`}>
                  <td className="py-1.5">
                    <span className="inline-block w-2 h-2 rounded-sm mr-1.5" style={{ background: TIER_COLORS[r.name] }} />
                    {r.name}
                  </td>
                  <td className="py-1.5 text-right font-mono" style={{ color: TIER_COLORS[r.name] }}>{r.estFee}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {/* Rules note */}
          <div className="mt-2 text-[10px] text-gray-500">
            ≤{estimate?.free_threshold || 200}张免费 · 阶梯按用量动态划分
            {estimate && estimate.anlas_threshold > 0 && (
              <> · Anlas超{estimate.anlas_threshold}点+¥{estimate.anlas_surcharge}</>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

interface ProfileModalProps {
  isOpen: boolean;
  onClose: () => void;
}

interface StatsSummary {
  ai_calls: number;
  image_calls: number;
  total_calls: number;
  points_spent: number;
}

interface DailyData {
  date: string;
  ai_calls: number;
  image_calls: number;
  points_spent: number;
}

type TimeRange = 'today' | 'week' | 'month';
type ChartMetric = 'calls' | 'points';

const TIME_RANGE_LABELS: Record<TimeRange, string> = {
  today: '今日',
  week: '本周',
  month: '本月',
};

export const ProfileModal: React.FC<ProfileModalProps> = ({ isOpen, onClose }) => {
  const [activeRange, setActiveRange] = useState<TimeRange>('today');
  const [chartMetric, setChartMetric] = useState<ChartMetric>('calls');
  const [summary, setSummary] = useState<StatsSummary | null>(null);
  const [dailyData, setDailyData] = useState<DailyData[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedBarIndex, setSelectedBarIndex] = useState<number | null>(null);
  const [showPlatformStats, setShowPlatformStats] = useState(false);
  const [showSettlement, setShowSettlement] = useState(false);
  const chartScrollRef = useRef<HTMLDivElement>(null);

  const botUserId = botService.getAuthState().botUserId;
  const sessionId = botService.getAuthState().sessionId;


  const fetchStats = useCallback(async (range: TimeRange) => {
    if (!sessionId) return;
    setLoading(true);
    try {
      const [summaryRes, dailyRes] = await Promise.all([
        appBackendApi.request('/api/user/stats', undefined, { session_id: sessionId, time_range: range }),
        appBackendApi.request('/api/user/stats/daily', undefined, { session_id: sessionId, time_range: range }),
      ]);
      if (summaryRes.ok) setSummary(await summaryRes.json());
      if (dailyRes.ok) {
        const d = await dailyRes.json();
        setDailyData(d.data || []);
      }
    } catch (e) {
      console.error('Failed to fetch stats:', e);
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    if (isOpen) fetchStats(activeRange);
  }, [isOpen, activeRange, fetchStats]);

  if (!isOpen) return null;

  const maxValue = dailyData.length > 0
    ? Math.max(...dailyData.map(d => chartMetric === 'calls' ? d.image_calls : d.points_spent), 1)
    : 1;

  return (
    <>
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
        <div
          className="bg-nai-panel border border-gray-700 rounded-xl shadow-2xl w-[560px] max-h-[85vh] overflow-hidden flex flex-col"
          onClick={e => e.stopPropagation()}
        >
          {/* Header */}
          <div className="flex items-center justify-between px-5 py-4 border-b border-gray-800">
            <h2 className="text-lg font-semibold text-white">个人中心</h2>
            <button onClick={onClose} className="p-1 hover:bg-gray-800 rounded transition-colors">
              <X className="w-5 h-5 text-gray-400" />
            </button>
          </div>

          <div className="overflow-y-auto flex-1 px-5 py-4 space-y-5 scrollbar-none" style={{ scrollbarWidth: 'none' }}>
            {/* User ID */}
            <div className="flex items-center gap-3 p-3 bg-gray-800/50 rounded-lg">
              <div className="w-10 h-10 rounded-full bg-nai-accent/20 flex items-center justify-center">
                <span className="text-nai-accent font-bold text-lg">{(botUserId || '?')[0].toUpperCase()}</span>
              </div>
              <div>
                <div className="text-sm text-gray-400">用户 ID</div>
                <div className="text-white font-mono text-sm">{botUserId || '未登录'}</div>
              </div>
              <div className="ml-auto flex items-center gap-1.5">
                <button
                  onClick={() => setShowSettlement(true)}
                  className="flex items-center gap-1.5 px-3 py-1.5 bg-gray-700/60 hover:bg-gray-600/60 text-gray-300 hover:text-white text-xs rounded-lg transition-colors"
                >
                  <Receipt className="w-3.5 h-3.5" />
                  上期账单
                </button>
                <button
                  onClick={() => setShowPlatformStats(true)}
                  className="flex items-center gap-1.5 px-3 py-1.5 bg-gray-700/60 hover:bg-gray-600/60 text-gray-300 hover:text-white text-xs rounded-lg transition-colors"
                >
                  <Activity className="w-3.5 h-3.5" />
                  全平台统计
                </button>
              </div>
            </div>

            {/* Time Range Tabs */}
            <div className="flex gap-1 bg-gray-800/50 rounded-lg p-1">
              {(Object.keys(TIME_RANGE_LABELS) as TimeRange[]).map(range => (
                <button
                  key={range}
                  onClick={() => setActiveRange(range)}
                  className={`flex-1 py-1.5 text-sm rounded-md transition-colors ${activeRange === range
                    ? 'bg-nai-accent text-black font-medium'
                    : 'text-gray-400 hover:text-white hover:bg-gray-700'
                    }`}
                >
                  {TIME_RANGE_LABELS[range]}
                </button>
              ))}
            </div>

            {/* Summary Cards */}
            <div className={`grid grid-cols-3 gap-3 transition-opacity ${loading ? 'opacity-40' : ''}`}>
              <div className="bg-gray-800/50 rounded-lg p-3 text-center">
                <ImageIcon className="w-5 h-5 text-blue-400 mx-auto mb-1" />
                <div className="text-xl font-bold text-white">{summary?.image_calls ?? '-'}</div>
                <div className="text-xs text-gray-400">生图次数</div>
              </div>
              <div className="bg-gray-800/50 rounded-lg p-3 text-center">
                <MessageSquare className="w-5 h-5 text-green-400 mx-auto mb-1" />
                <div className="text-xl font-bold text-white">{summary?.ai_calls ?? '-'}</div>
                <div className="text-xs text-gray-400">AI对话</div>
              </div>
              <div className="bg-gray-800/50 rounded-lg p-3 text-center">
                <Coins className="w-5 h-5 text-orange-400 mx-auto mb-1" />
                <div className="text-xl font-bold text-white">{summary?.points_spent ?? '-'}</div>
                <div className="text-xs text-gray-400">点数消耗</div>
              </div>
            </div>

            {/* Chart Section */}
            <div className={`bg-gray-800/50 rounded-lg p-4 transition-opacity ${loading ? 'opacity-40' : ''}`}>
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  <BarChart3 className="w-4 h-4 text-gray-400" />
                  <span className="text-sm font-medium text-gray-300">使用趋势</span>
                </div>
                <div className="flex gap-1 bg-gray-900/50 rounded p-0.5">
                  <button
                    onClick={() => setChartMetric('calls')}
                    className={`px-2 py-0.5 text-xs rounded transition-colors ${chartMetric === 'calls' ? 'bg-nai-accent text-black' : 'text-gray-400 hover:text-white'
                      }`}
                  >
                    生图次数
                  </button>
                  <button
                    onClick={() => setChartMetric('points')}
                    className={`px-2 py-0.5 text-xs rounded transition-colors ${chartMetric === 'points' ? 'bg-nai-accent text-black' : 'text-gray-400 hover:text-white'
                      }`}
                  >
                    点数消耗
                  </button>
                </div>
              </div>

              {dailyData.length === 0 ? (
                <div className="text-center text-gray-500 text-sm py-8">暂无数据</div>
              ) : (
                <div
                  ref={chartScrollRef}
                  className="overflow-x-auto"
                  onWheel={(e) => {
                    if (chartScrollRef.current && e.deltaY !== 0) {
                      e.preventDefault();
                      chartScrollRef.current.scrollLeft += e.deltaY;
                    }
                  }}
                >
                  <div className="flex items-end gap-2 h-36 pt-6" style={{ minWidth: `${dailyData.length * 48}px` }}>
                    {dailyData.map((d, i) => {
                      const value = chartMetric === 'calls' ? d.image_calls : d.points_spent;
                      const heightPct = maxValue > 0 ? (value / maxValue) * 100 : 0;
                      const dateLabel = d.date.includes(':') ? d.date : d.date.slice(5);
                      const isSelected = selectedBarIndex === i;
                      return (
                        <div
                          key={i}
                          className="flex flex-col items-center gap-1 relative cursor-pointer"
                          style={{ width: '40px', flexShrink: 0 }}
                          onClick={() => setSelectedBarIndex(isSelected ? null : i)}
                        >
                          {isSelected && (
                            <div className="absolute top-0 left-1/2 -translate-x-1/2 bg-gray-900 text-white text-xs px-2 py-1 rounded whitespace-nowrap z-10 shadow-lg">
                              {chartMetric === 'calls' ? <>{value} 次</> : <>{value} 点</>}
                            </div>
                          )}
                          <div className="w-full flex flex-col items-center" style={{ height: '100px' }}>
                            <div className="flex-1" />
                            <div
                              className={`w-6 rounded-t transition-all ${chartMetric === 'calls' ? 'bg-blue-500/80' : 'bg-orange-500'} ${isSelected ? 'ring-2 ring-white/50' : ''}`}
                              style={{ height: `${heightPct}px` }}
                            />
                          </div>
                          <span className="text-[10px] text-gray-500">{dateLabel}</span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>

            {/* Billing Section */}
            <BillingSection sessionId={sessionId} />

            {/* Usage Detail for current period */}
            {botUserId && (
              <UsageDetailPanel userId={botUserId} period="current" />
            )}
          </div>
        </div>
      </div>
      <PlatformStatsModal isOpen={showPlatformStats} onClose={() => setShowPlatformStats(false)} />
      <BillingSettlementModal isOpen={showSettlement} onClose={() => setShowSettlement(false)} />
    </>
  );
};
