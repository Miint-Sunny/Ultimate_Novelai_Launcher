import React, { useCallback, useEffect, useRef, useState } from 'react';
import { BarChart3, Coins, Image as ImageIcon, MessageSquare, Receipt } from 'lucide-react';
import { botService } from '../../../services/botService';
import { appBackendApi } from '../../../api/appBackendApi';
import { BillingSettlementModal } from '../../BillingSettlementModal';

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

export const MobileProfileSettingsSection: React.FC = () => {
  const [profileRange, setProfileRange] = useState<TimeRange>('today');
  const [profileChartMetric, setProfileChartMetric] = useState<ChartMetric>('calls');
  const [profileSummary, setProfileSummary] = useState<StatsSummary | null>(null);
  const [profileDailyData, setProfileDailyData] = useState<DailyData[]>([]);
  const [profileLoading, setProfileLoading] = useState(false);
  const [selectedBarIndex, setSelectedBarIndex] = useState<number | null>(null);
  const [showSettlement, setShowSettlement] = useState(false);
  const chartScrollRef = useRef<HTMLDivElement>(null);

  const fetchProfileStats = useCallback(async (range: TimeRange) => {
    const sessionId = botService.getAuthState().sessionId;
    if (!sessionId) return;
    setProfileLoading(true);
    try {
      const [summaryRes, dailyRes] = await Promise.all([
        appBackendApi.request('/api/user/stats', undefined, { session_id: sessionId, time_range: range }),
        appBackendApi.request('/api/user/stats/daily', undefined, { session_id: sessionId, time_range: range }),
      ]);
      if (summaryRes.ok) setProfileSummary(await summaryRes.json());
      if (dailyRes.ok) {
        const data = await dailyRes.json();
        setProfileDailyData(data.data || []);
      }
    } catch (error) {
      console.error('Failed to fetch stats:', error);
    } finally {
      setProfileLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchProfileStats(profileRange);
  }, [profileRange, fetchProfileStats]);

  const botUserId = botService.getAuthState().botUserId;
  const maxValue = profileDailyData.length > 0
    ? Math.max(...profileDailyData.map((data) => profileChartMetric === 'calls' ? data.image_calls : data.points_spent), 1)
    : 1;

  return (
    <div className="p-4 space-y-4">
      <div className="flex items-center gap-3 p-4 bg-gray-800/50 rounded-xl">
        <div className="w-12 h-12 rounded-full bg-nai-accent/20 flex items-center justify-center">
          <span className="text-nai-accent font-bold text-xl">{(botUserId || '?')[0].toUpperCase()}</span>
        </div>
        <div className="flex-1">
          <div className="text-xs text-gray-400">用户 ID</div>
          <div className="text-white font-mono text-sm">{botUserId || '未登录'}</div>
        </div>
        <button
          onClick={() => setShowSettlement(true)}
          className="flex items-center gap-1.5 px-3 py-2 bg-gray-700/60 active:bg-gray-600/60 text-gray-300 text-xs rounded-lg transition-colors"
        >
          <Receipt className="w-3.5 h-3.5" />
          上期账单
        </button>
      </div>

      <BillingSettlementModal isOpen={showSettlement} onClose={() => setShowSettlement(false)} />

      <div className="flex gap-1 bg-gray-800/50 rounded-xl p-1">
        {(Object.keys(TIME_RANGE_LABELS) as TimeRange[]).map((range) => (
          <button
            key={range}
            onClick={() => {
              setProfileRange(range);
              setSelectedBarIndex(null);
            }}
            className={`flex-1 py-2 text-sm rounded-lg transition-colors ${profileRange === range
              ? 'bg-nai-accent text-black font-medium'
              : 'text-gray-400 active:bg-gray-700'
              }`}
          >
            {TIME_RANGE_LABELS[range]}
          </button>
        ))}
      </div>

      <div className={`grid grid-cols-3 gap-3 transition-opacity ${profileLoading ? 'opacity-40' : ''}`}>
        <div className="bg-gray-800/50 rounded-xl p-3 text-center">
          <ImageIcon className="w-5 h-5 text-blue-400 mx-auto mb-1" />
          <div className="text-xl font-bold text-white">{profileSummary?.image_calls ?? '-'}</div>
          <div className="text-xs text-gray-400">生图次数</div>
        </div>
        <div className="bg-gray-800/50 rounded-xl p-3 text-center">
          <MessageSquare className="w-5 h-5 text-green-400 mx-auto mb-1" />
          <div className="text-xl font-bold text-white">{profileSummary?.ai_calls ?? '-'}</div>
          <div className="text-xs text-gray-400">AI对话</div>
        </div>
        <div className="bg-gray-800/50 rounded-xl p-3 text-center">
          <Coins className="w-5 h-5 text-orange-400 mx-auto mb-1" />
          <div className="text-xl font-bold text-white">{profileSummary?.points_spent ?? '-'}</div>
          <div className="text-xs text-gray-400">点数消耗</div>
        </div>
      </div>

      <div className={`bg-gray-800/50 rounded-xl p-4 transition-opacity ${profileLoading ? 'opacity-40' : ''}`}>
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <BarChart3 className="w-4 h-4 text-gray-400" />
            <span className="text-sm font-medium text-gray-300">使用趋势</span>
          </div>
          <div className="flex gap-1 bg-gray-900/50 rounded p-0.5">
            <button
              onClick={() => {
                setProfileChartMetric('calls');
                setSelectedBarIndex(null);
              }}
              className={`px-2 py-0.5 text-xs rounded transition-colors ${profileChartMetric === 'calls' ? 'bg-nai-accent text-black' : 'text-gray-400'}`}
            >
              生图次数
            </button>
            <button
              onClick={() => {
                setProfileChartMetric('points');
                setSelectedBarIndex(null);
              }}
              className={`px-2 py-0.5 text-xs rounded transition-colors ${profileChartMetric === 'points' ? 'bg-nai-accent text-black' : 'text-gray-400'}`}
            >
              点数消耗
            </button>
          </div>
        </div>

        {profileDailyData.length === 0 ? (
          <div className="text-center text-gray-500 text-sm py-8">暂无数据</div>
        ) : (
          <div
            ref={chartScrollRef}
            className="overflow-x-auto"
            onWheel={(event) => {
              if (chartScrollRef.current && event.deltaY !== 0) {
                event.preventDefault();
                chartScrollRef.current.scrollLeft += event.deltaY;
              }
            }}
          >
            <div className="flex items-end gap-2 h-36 pt-6" style={{ minWidth: `${profileDailyData.length * 48}px` }}>
              {profileDailyData.map((data, index) => {
                const value = profileChartMetric === 'calls' ? data.image_calls : data.points_spent;
                const heightPct = maxValue > 0 ? (value / maxValue) * 100 : 0;
                const dateLabel = profileRange === 'today' ? data.date : data.date.slice(5);
                const isSelected = selectedBarIndex === index;
                return (
                  <div
                    key={index}
                    className="flex flex-col items-center gap-1 relative cursor-pointer"
                    style={{ width: '40px', flexShrink: 0 }}
                    onClick={() => setSelectedBarIndex(isSelected ? null : index)}
                  >
                    {isSelected && (
                      <div className="absolute top-0 left-1/2 -translate-x-1/2 bg-gray-900 text-white text-xs px-2 py-1 rounded whitespace-nowrap z-10 shadow-lg">
                        {profileChartMetric === 'calls' ? <>{value} 次</> : <>{value} 点</>}
                      </div>
                    )}
                    <div className="w-full flex flex-col items-center" style={{ height: '100px' }}>
                      <div className="flex-1" />
                      <div
                        className={`w-6 rounded-t transition-all ${profileChartMetric === 'calls' ? 'bg-blue-500/80' : 'bg-orange-500'} ${isSelected ? 'ring-2 ring-white/50' : ''}`}
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
    </div>
  );
};
