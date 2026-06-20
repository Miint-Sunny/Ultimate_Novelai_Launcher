import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
    X, Coins, Image as ImageIcon, MessageSquare,
    Users, Calendar, TrendingUp, Clock, Activity
} from 'lucide-react';
import { getBackendUrl } from '../utils/apiConfig';

interface PlatformStatsModalProps {
    isOpen: boolean;
    onClose: () => void;
}

interface PlatformSummary {
    ai_calls: number;
    image_calls: number;
    total_calls: number;
    points_spent: number;
    active_users: number;
}

interface AllTimeStats {
    ai_calls: number;
    image_calls: number;
    total_calls: number;
    points_spent: number;
    total_users: number;
    first_record: string | null;
    last_record: string | null;
}



interface HeatmapSlot {
    hour: number;
    label: string;
    total_calls: number;
    avg_calls: number;
}

interface UserHeatmapSlot {
    hour: number;
    label: string;
    total_users: number;
    avg_users: number;
}

interface DurationHeatmapSlot {
    hour: number;
    label: string;
    avg_duration: number;
    count: number;
}

type TimeRange = 'today' | 'week' | 'month';

const TIME_RANGE_LABELS: Record<TimeRange, string> = {
    today: '今日',
    week: '本周',
    month: '本月',
};

const HEATMAP_DAYS_MAP: Record<TimeRange, number> = {
    today: 1,
    week: 7,
    month: 30,
};

export const PlatformStatsModal: React.FC<PlatformStatsModalProps> = ({ isOpen, onClose }) => {
    const [activeRange, setActiveRange] = useState<TimeRange>('today');
    const [summary, setSummary] = useState<PlatformSummary | null>(null);
    const [allTime, setAllTime] = useState<AllTimeStats | null>(null);
    const [heatmap, setHeatmap] = useState<HeatmapSlot[]>([]);
    const [heatmapDays, setHeatmapDays] = useState(1);
    const [userHeatmap, setUserHeatmap] = useState<UserHeatmapSlot[]>([]);
    const [userHeatmapDays, setUserHeatmapDays] = useState(1);
    const [durationHeatmap, setDurationHeatmap] = useState<DurationHeatmapSlot[]>([]);
    const [durationHeatmapDays, setDurationHeatmapDays] = useState(1);
    const [loading, setLoading] = useState(false);

    const fetchHeatmap = useCallback(async (days: number) => {
        try {
            const backendUrl = getBackendUrl();
            const res = await fetch(`${backendUrl}/api/platform/stats/hourly-heatmap?days=${days}`);
            if (res.ok) {
                const h = await res.json();
                setHeatmap(h.heatmap || []);
                setHeatmapDays(h.total_days || 1);
            }
        } catch (e) {
            console.error('Failed to fetch heatmap:', e);
        }
    }, []);

    const fetchUserHeatmap = useCallback(async (days: number) => {
        try {
            const backendUrl = getBackendUrl();
            const res = await fetch(`${backendUrl}/api/platform/stats/hourly-users?days=${days}`);
            if (res.ok) {
                const h = await res.json();
                setUserHeatmap(h.heatmap || []);
                setUserHeatmapDays(h.total_days || 1);
            }
        } catch (e) {
            console.error('Failed to fetch user heatmap:', e);
        }
    }, []);

    const fetchDurationHeatmap = useCallback(async (days: number) => {
        try {
            const backendUrl = getBackendUrl();
            const res = await fetch(`${backendUrl}/api/platform/stats/hourly-duration?days=${days}`);
            if (res.ok) {
                const h = await res.json();
                setDurationHeatmap(h.heatmap || []);
                setDurationHeatmapDays(h.total_days || 1);
            }
        } catch (e) {
            console.error('Failed to fetch duration heatmap:', e);
        }
    }, []);

    const fetchStats = useCallback(async (range: TimeRange) => {
        setLoading(true);
        try {
            const backendUrl = getBackendUrl();
            const [summaryRes, allTimeRes] = await Promise.all([
                fetch(`${backendUrl}/api/platform/stats?time_range=${range}`),
                fetch(`${backendUrl}/api/platform/stats/all`),
            ]);
            if (summaryRes.ok) setSummary(await summaryRes.json());
            if (allTimeRes.ok) setAllTime(await allTimeRes.json());
        } catch (e) {
            console.error('Failed to fetch platform stats:', e);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        if (isOpen) {
            fetchStats(activeRange);
            fetchHeatmap(HEATMAP_DAYS_MAP[activeRange]);
            fetchUserHeatmap(HEATMAP_DAYS_MAP[activeRange]);
            fetchDurationHeatmap(HEATMAP_DAYS_MAP[activeRange]);
        }
    }, [isOpen, activeRange, fetchStats, fetchHeatmap, fetchUserHeatmap, fetchDurationHeatmap]);

    // 计算热力图颜色
    const heatmapMax = useMemo(() => Math.max(...heatmap.map(h => h.avg_calls), 1), [heatmap]);
    const getHeatColor = useCallback((avg: number) => {
        const ratio = heatmapMax > 0 ? avg / heatmapMax : 0;
        if (ratio === 0) return 'bg-gray-800/60';
        if (ratio < 0.2) return 'bg-emerald-900/60';
        if (ratio < 0.4) return 'bg-emerald-700/70';
        if (ratio < 0.6) return 'bg-yellow-600/70';
        if (ratio < 0.8) return 'bg-orange-600/80';
        return 'bg-red-500/80';
    }, [heatmapMax]);

    // 找出峰值时段
    const peakHours = useMemo(() => {
        if (heatmap.length === 0) return [];
        const sorted = [...heatmap].sort((a, b) => b.avg_calls - a.avg_calls);
        return sorted.slice(0, 3).filter(h => h.avg_calls > 0);
    }, [heatmap]);

    // 活跃用户热力图颜色
    const userHeatmapMax = useMemo(() => Math.max(...userHeatmap.map(h => h.avg_users), 1), [userHeatmap]);
    const getUserHeatColor = useCallback((avg: number) => {
        const ratio = userHeatmapMax > 0 ? avg / userHeatmapMax : 0;
        if (ratio === 0) return 'bg-gray-800/60';
        if (ratio < 0.2) return 'bg-emerald-900/60';
        if (ratio < 0.4) return 'bg-emerald-700/70';
        if (ratio < 0.6) return 'bg-yellow-600/70';
        if (ratio < 0.8) return 'bg-orange-600/80';
        return 'bg-red-500/80';
    }, [userHeatmapMax]);

    // 活跃用户峰值时段
    const peakUserHours = useMemo(() => {
        if (userHeatmap.length === 0) return [];
        const sorted = [...userHeatmap].sort((a, b) => b.avg_users - a.avg_users);
        return sorted.slice(0, 3).filter(h => h.avg_users > 0);
    }, [userHeatmap]);

    // 生成耗时热力图颜色
    const durationHeatmapMax = useMemo(() => Math.max(...durationHeatmap.map(h => h.avg_duration), 1), [durationHeatmap]);
    const getDurationHeatColor = useCallback((avg: number) => {
        const ratio = durationHeatmapMax > 0 ? avg / durationHeatmapMax : 0;
        if (ratio === 0) return 'bg-gray-800/60';
        if (ratio < 0.2) return 'bg-emerald-900/60';
        if (ratio < 0.4) return 'bg-emerald-700/70';
        if (ratio < 0.6) return 'bg-yellow-600/70';
        if (ratio < 0.8) return 'bg-orange-600/80';
        return 'bg-red-500/80';
    }, [durationHeatmapMax]);

    // 耗时最长时段
    const peakDurationHours = useMemo(() => {
        if (durationHeatmap.length === 0) return [];
        const sorted = [...durationHeatmap].sort((a, b) => b.avg_duration - a.avg_duration);
        return sorted.slice(0, 3).filter(h => h.avg_duration > 0);
    }, [durationHeatmap]);

    // 格式化历史时间范围
    const historyRange = useMemo(() => {
        if (!allTime?.first_record) return '';
        const first = allTime.first_record.split('T')[0];
        const last = allTime.last_record?.split('T')[0] || '至今';
        return `${first} ~ ${last}`;
    }, [allTime]);

    if (!isOpen) return null;

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
            <div
                className="bg-nai-panel border border-gray-700 rounded-xl shadow-2xl w-[620px] max-h-[90vh] overflow-hidden flex flex-col"
                onClick={e => e.stopPropagation()}
            >
                {/* Header */}
                <div className="flex items-center justify-between px-5 py-4 border-b border-gray-800">
                    <div className="flex items-center gap-2">
                        <Activity className="w-5 h-5 text-nai-accent" />
                        <h2 className="text-lg font-semibold text-white">全平台统计</h2>
                    </div>
                    <button onClick={onClose} className="p-1 hover:bg-gray-800 rounded transition-colors">
                        <X className="w-5 h-5 text-gray-400" />
                    </button>
                </div>

                <div className="overflow-y-auto overflow-x-hidden flex-1 px-5 py-4 space-y-5">
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
                    <div className={`grid grid-cols-4 gap-3 transition-opacity ${loading ? 'opacity-40' : ''}`}>
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
                        <div className="bg-gray-800/50 rounded-lg p-3 text-center">
                            <Users className="w-5 h-5 text-purple-400 mx-auto mb-1" />
                            <div className="text-xl font-bold text-white">{summary?.active_users ?? '-'}</div>
                            <div className="text-xs text-gray-400">活跃用户</div>
                        </div>
                    </div>


                    {/* Hourly Heatmap */}
                    <div className={`bg-gray-800/50 rounded-lg p-4 transition-opacity ${loading ? 'opacity-40' : ''}`}>
                        <div className="flex items-center gap-2 mb-1">
                            <Clock className="w-4 h-4 text-gray-400" />
                            <span className="text-sm font-medium text-gray-300">每日负载时段</span>
                            <span className="text-[10px] text-gray-500 ml-auto">基于 {heatmapDays} 天有效数据</span>
                        </div>

                        {/* Peak Hours Highlight */}
                        {peakHours.length > 0 && (
                            <div className="flex items-center gap-2 mb-3 bg-gray-900/50 rounded-lg px-3 py-2">
                                <TrendingUp className="w-4 h-4 text-red-400 flex-shrink-0" />
                                <div className="text-xs text-gray-300">
                                    <span className="text-gray-500">峰值时段：</span>
                                    {peakHours.map((h, i) => (
                                        <span key={h.hour}>
                                            {i > 0 && '、'}
                                            <span className="text-white font-medium">{h.label}</span>
                                            <span className="text-gray-500">（日均 {h.avg_calls} 次）</span>
                                        </span>
                                    ))}
                                </div>
                            </div>
                        )}

                        {/* Heatmap Grid */}
                        <div className="grid grid-cols-12 gap-1">
                            {heatmap.map(slot => (
                                <div
                                    key={slot.hour}
                                    className={`group relative rounded ${getHeatColor(slot.avg_calls)} transition-colors cursor-default`}
                                    style={{ aspectRatio: '1' }}
                                >
                                    <div className="absolute inset-0 flex items-center justify-center">
                                        <span className="text-[10px] font-mono text-white/70">{slot.hour}</span>
                                    </div>
                                    {/* Tooltip */}
                                    <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1 bg-gray-900 text-white text-[10px] px-2 py-1 rounded opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap z-20 pointer-events-none shadow-lg">
                                        <div className="font-medium">{slot.label}–{String(slot.hour + 1).padStart(2, '0')}:00</div>
                                        <div>日均 {slot.avg_calls} 次 / 总计 {slot.total_calls} 次</div>
                                    </div>
                                </div>
                            ))}
                        </div>

                        {/* Legend */}
                        <div className="flex items-center justify-end gap-1 mt-2">
                            <span className="text-[10px] text-gray-500">低</span>
                            <div className="w-3 h-3 rounded bg-gray-800/60" />
                            <div className="w-3 h-3 rounded bg-emerald-900/60" />
                            <div className="w-3 h-3 rounded bg-emerald-700/70" />
                            <div className="w-3 h-3 rounded bg-yellow-600/70" />
                            <div className="w-3 h-3 rounded bg-orange-600/80" />
                            <div className="w-3 h-3 rounded bg-red-500/80" />
                            <span className="text-[10px] text-gray-500">高</span>
                        </div>
                    </div>

                    {/* User Activity Heatmap */}
                    <div className={`bg-gray-800/50 rounded-lg p-4 transition-opacity ${loading ? 'opacity-40' : ''}`}>
                        <div className="flex items-center gap-2 mb-1">
                            <Users className="w-4 h-4 text-gray-400" />
                            <span className="text-sm font-medium text-gray-300">活跃用户时段分布</span>
                            <span className="text-[10px] text-gray-500 ml-auto">基于 {userHeatmapDays} 天有效数据</span>
                        </div>

                        {/* Peak User Hours Highlight */}
                        {peakUserHours.length > 0 && (
                            <div className="flex items-center gap-2 mb-3 bg-gray-900/50 rounded-lg px-3 py-2">
                                <TrendingUp className="w-4 h-4 text-red-400 flex-shrink-0" />
                                <div className="text-xs text-gray-300">
                                    <span className="text-gray-500">峰值时段：</span>
                                    {peakUserHours.map((h, i) => (
                                        <span key={h.hour}>
                                            {i > 0 && '、'}
                                            <span className="text-white font-medium">{h.label}</span>
                                            <span className="text-gray-500">（日均 {h.avg_users} 人）</span>
                                        </span>
                                    ))}
                                </div>
                            </div>
                        )}

                        {/* User Heatmap Grid */}
                        <div className="grid grid-cols-12 gap-1">
                            {userHeatmap.map(slot => (
                                <div
                                    key={slot.hour}
                                    className={`group relative rounded ${getUserHeatColor(slot.avg_users)} transition-colors cursor-default`}
                                    style={{ aspectRatio: '1' }}
                                >
                                    <div className="absolute inset-0 flex items-center justify-center">
                                        <span className="text-[10px] font-mono text-white/70">{slot.hour}</span>
                                    </div>
                                    {/* Tooltip */}
                                    <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1 bg-gray-900 text-white text-[10px] px-2 py-1 rounded opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap z-20 pointer-events-none shadow-lg">
                                        <div className="font-medium">{slot.label}–{String(slot.hour + 1).padStart(2, '0')}:00</div>
                                        <div>日均 {slot.avg_users} 人 / 总计 {slot.total_users} 人</div>
                                    </div>
                                </div>
                            ))}
                        </div>

                        {/* Legend */}
                        <div className="flex items-center justify-end gap-1 mt-2">
                            <span className="text-[10px] text-gray-500">少</span>
                            <div className="w-3 h-3 rounded bg-gray-800/60" />
                            <div className="w-3 h-3 rounded bg-emerald-900/60" />
                            <div className="w-3 h-3 rounded bg-emerald-700/70" />
                            <div className="w-3 h-3 rounded bg-yellow-600/70" />
                            <div className="w-3 h-3 rounded bg-orange-600/80" />
                            <div className="w-3 h-3 rounded bg-red-500/80" />
                            <span className="text-[10px] text-gray-500">多</span>
                        </div>
                    </div>

                    {/* Generation Duration Heatmap */}
                    <div className={`bg-gray-800/50 rounded-lg p-4 transition-opacity ${loading ? 'opacity-40' : ''}`}>
                        <div className="flex items-center gap-2 mb-1">
                            <Clock className="w-4 h-4 text-gray-400" />
                            <span className="text-sm font-medium text-gray-300">平均生成耗时</span>
                            <span className="text-[10px] text-gray-500 ml-auto">基于 {durationHeatmapDays} 天有效数据</span>
                        </div>

                        {/* Peak Duration Hours */}
                        {peakDurationHours.length > 0 && (
                            <div className="flex items-center gap-2 mb-3 bg-gray-900/50 rounded-lg px-3 py-2">
                                <TrendingUp className="w-4 h-4 text-red-400 flex-shrink-0" />
                                <div className="text-xs text-gray-300">
                                    <span className="text-gray-500">最慢时段：</span>
                                    {peakDurationHours.map((h, i) => (
                                        <span key={h.hour}>
                                            {i > 0 && '、'}
                                            <span className="text-white font-medium">{h.label}</span>
                                            <span className="text-gray-500">（平均 {h.avg_duration}s）</span>
                                        </span>
                                    ))}
                                </div>
                            </div>
                        )}

                        {/* Duration Heatmap Grid */}
                        <div className="grid grid-cols-12 gap-1">
                            {durationHeatmap.map(slot => (
                                <div
                                    key={slot.hour}
                                    className={`group relative rounded ${getDurationHeatColor(slot.avg_duration)} transition-colors cursor-default`}
                                    style={{ aspectRatio: '1' }}
                                >
                                    <div className="absolute inset-0 flex items-center justify-center">
                                        <span className="text-[10px] font-mono text-white/70">{slot.hour}</span>
                                    </div>
                                    {/* Tooltip */}
                                    <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1 bg-gray-900 text-white text-[10px] px-2 py-1 rounded opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap z-20 pointer-events-none shadow-lg">
                                        <div className="font-medium">{slot.label}–{String(slot.hour + 1).padStart(2, '0')}:00</div>
                                        <div>平均 {slot.avg_duration}s / {slot.count} 次</div>
                                    </div>
                                </div>
                            ))}
                        </div>

                        {/* Legend */}
                        <div className="flex items-center justify-end gap-1 mt-2">
                            <span className="text-[10px] text-gray-500">快</span>
                            <div className="w-3 h-3 rounded bg-gray-800/60" />
                            <div className="w-3 h-3 rounded bg-emerald-900/60" />
                            <div className="w-3 h-3 rounded bg-emerald-700/70" />
                            <div className="w-3 h-3 rounded bg-yellow-600/70" />
                            <div className="w-3 h-3 rounded bg-orange-600/80" />
                            <div className="w-3 h-3 rounded bg-red-500/80" />
                            <span className="text-[10px] text-gray-500">慢</span>
                        </div>
                    </div>

                    {/* All-Time Historical Stats */}
                    <div className={`bg-gray-800/50 rounded-lg p-4 transition-opacity ${loading ? 'opacity-40' : ''}`}>
                        <div className="flex items-center gap-2 mb-3">
                            <Calendar className="w-4 h-4 text-gray-400" />
                            <span className="text-sm font-medium text-gray-300">历史全量统计</span>
                            {historyRange && (
                                <span className="text-[10px] text-gray-500 ml-auto font-mono">{historyRange}</span>
                            )}
                        </div>
                        <div className="grid grid-cols-4 gap-3">
                            <div className="bg-gray-900/50 rounded-lg p-2.5 text-center">
                                <div className="text-lg font-bold text-blue-300">{allTime?.image_calls?.toLocaleString() ?? '-'}</div>
                                <div className="text-[10px] text-gray-500">总生图</div>
                            </div>
                            <div className="bg-gray-900/50 rounded-lg p-2.5 text-center">
                                <div className="text-lg font-bold text-green-300">{allTime?.ai_calls?.toLocaleString() ?? '-'}</div>
                                <div className="text-[10px] text-gray-500">总对话</div>
                            </div>
                            <div className="bg-gray-900/50 rounded-lg p-2.5 text-center">
                                <div className="text-lg font-bold text-orange-300">{allTime?.points_spent?.toLocaleString() ?? '-'}</div>
                                <div className="text-[10px] text-gray-500">总消耗</div>
                            </div>
                            <div className="bg-gray-900/50 rounded-lg p-2.5 text-center">
                                <div className="text-lg font-bold text-purple-300">{allTime?.total_users?.toLocaleString() ?? '-'}</div>
                                <div className="text-[10px] text-gray-500">总用户</div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
};
