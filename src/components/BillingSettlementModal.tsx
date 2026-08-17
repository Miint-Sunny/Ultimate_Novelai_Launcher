import React, { useState, useEffect } from 'react';
import { X, Wallet, Layers, CheckCircle, QrCode, Download } from 'lucide-react';
import { appBackendApi } from '../api/appBackendApi';
import { botService } from '../services/botService';
import { UsageDetailPanel } from './UsageDetailPanel';

/* ---------- Types ---------- */
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

interface SettlementReport {
  tiers: { free: number; t1: number; t2: number };
  tier_weights: number[];
  total_cost: number;
  actual_total: number;
  free_threshold: number;
  anlas_threshold: number;
  anlas_surcharge: number;
  users: BillingUser[];
  tier_distribution: Record<string, TierDistItem>;
  active_user_count: number;
  total_image_calls: number;
  billing_month: string;
  period_start: string;
  period_end: string;
  current_user: BillingUser | null;
  payment_status: 'free' | 'unpaid' | 'paid';
  dismissed: boolean;
}

const TIER_COLORS: Record<string, string> = {
  '免费': '#707274',
  '一阶': '#3b82f6',
  '二阶': '#22d3ee',
  '三阶': '#ef4444',
  '均摊': '#38bdf8',
};

const TIER_BG: Record<string, string> = {
  '免费': 'bg-gray-600/20',
  '一阶': 'bg-blue-600/20',
  '二阶': 'bg-cyan-600/20',
  '三阶': 'bg-red-600/20',
  '均摊': 'bg-sky-600/20',
};

const STATUS_CONFIG = {
  free: { label: '无需支付', color: 'text-gray-400', bg: 'bg-gray-600/20', icon: CheckCircle },
  unpaid: { label: '未支付', color: 'text-orange-400', bg: 'bg-orange-600/20', icon: Wallet },
  paid: { label: '已支付', color: 'text-green-400', bg: 'bg-green-600/20', icon: CheckCircle },
};

interface BillingSettlementModalProps {
  isOpen: boolean;
  onClose: () => void;
}

type PaymentMethod = 'wechat' | 'alipay';

export const BillingSettlementModal: React.FC<BillingSettlementModalProps> = ({ isOpen, onClose }) => {
  const [report, setReport] = useState<SettlementReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [marking, setMarking] = useState(false);
  const [payMethod, setPayMethod] = useState<PaymentMethod>('wechat');
  const [paymentQrUrl, setPaymentQrUrl] = useState('');

  const sessionId = botService.getAuthState().sessionId;

  useEffect(() => {
    if (!isOpen || !sessionId) return;
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      try {
        const res = await appBackendApi.request('/api/billing/settlement', undefined, {
          session_id: sessionId,
        });
        if (!cancelled && res.ok) {
          setReport(await res.json());
        }
      } catch (e) {
        console.error('Failed to load settlement:', e);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    load();
    return () => { cancelled = true; };
  }, [isOpen, sessionId]);

  useEffect(() => {
    const amount = report?.current_user?.total_fee ?? 0;
    if (!isOpen || report?.payment_status !== 'unpaid' || amount <= 0) {
      setPaymentQrUrl('');
      return;
    }
    let objectUrl = '';
    let cancelled = false;
    setPaymentQrUrl('');
    void appBackendApi.blob('/api/billing/qrcode', undefined, { type: payMethod })
      .then(blob => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setPaymentQrUrl(objectUrl);
      })
      .catch(() => {
        if (!cancelled) setPaymentQrUrl('');
      });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [isOpen, payMethod, report]);

  const handleClose = async () => {
    // Dismiss on close
    if (sessionId && report && !report.dismissed) {
      try {
        await appBackendApi.request('/api/billing/dismiss', { method: 'POST' }, {
          session_id: sessionId,
        });
      } catch { /* ignore */ }
    }
    onClose();
  };

  const handleMarkPaid = async () => {
    if (!sessionId || marking) return;
    setMarking(true);
    try {
      const res = await appBackendApi.request('/api/billing/mark_paid', { method: 'POST' }, {
        session_id: sessionId,
      });
      if (res.ok) {
        setReport(prev => prev ? { ...prev, payment_status: 'paid', dismissed: true } : prev);
      }
    } catch (e) {
      console.error('Failed to mark paid:', e);
    } finally {
      setMarking(false);
    }
  };

  if (!isOpen) return null;

  const me = report?.current_user;
  const tierName = me?.tier_name ?? '免费';
  const tierColor = TIER_COLORS[tierName] || '#707274';
  const rawStatus = report?.payment_status ?? 'unpaid';
  const status = rawStatus in STATUS_CONFIG ? rawStatus as keyof typeof STATUS_CONFIG : 'paid';
  const statusCfg = STATUS_CONFIG[status];
  const StatusIcon = statusCfg.icon;

  // Build tier table
  const tierRows: { name: string; count: number; avgFee: string; range: string; totalFee: number }[] = [];
  if (report) {
    const dist = report.tier_distribution || {};
    const t = report.tiers;
    const ranges: Record<string, string> = {
      '免费': `≤${t.free}张`,
      '一阶': t.t1 > 0 ? `${t.free + 1}~${t.t1}张` : '-',
      '二阶': t.t2 > 0 ? `${(t.t1 || t.free) + 1}~${t.t2}张` : '-',
      '三阶': t.t2 > 0 ? `>${t.t2}张` : '-',
    };
    for (const nm of ['免费', '一阶', '二阶', '三阶']) {
      const d = dist[nm];
      const avg = d && d.count > 0 ? Math.round(d.total_fee / d.count) : 0;
      tierRows.push({
        name: nm,
        count: d?.count ?? 0,
        avgFee: nm === '免费' ? '¥0' : (d ? `¥${avg}` : '-'),
        range: ranges[nm],
        totalFee: d?.total_fee ?? 0,
      });
    }
  }
  const tierTotal = tierRows.reduce((s, r) => s + r.totalFee, 0);

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={handleClose}>
      <div
        className="bg-nai-panel border border-gray-700 rounded-xl shadow-2xl w-[480px] max-h-[85vh] overflow-hidden flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-800">
          <div className="flex items-center gap-2">
            <Wallet className="w-5 h-5 text-nai-accent" />
            <h2 className="text-lg font-semibold text-white">账单结算</h2>
            {report && (
              <span className="text-xs text-gray-500 ml-1">{report.billing_month}</span>
            )}
          </div>
          <button onClick={handleClose} className="p-1 hover:bg-gray-800 rounded transition-colors">
            <X className="w-5 h-5 text-gray-400" />
          </button>
        </div>

        <div className="overflow-y-auto flex-1 px-5 py-4 space-y-4 scrollbar-none" style={{ scrollbarWidth: 'none' }}>
          {loading ? (
            <div className="text-center text-gray-500 text-sm py-8">加载结算信息...</div>
          ) : !report ? (
            <div className="text-center text-gray-500 text-sm py-8">无法加载结算信息</div>
          ) : (
            <>
              {/* Status Badge */}
              <div className={`flex items-center gap-2 px-3 py-2 rounded-lg ${statusCfg.bg}`}>
                <StatusIcon className={`w-4 h-4 ${statusCfg.color}`} />
                <span className={`text-sm font-medium ${statusCfg.color}`}>{statusCfg.label}</span>
              </div>

              {/* Amount Card */}
              <div className="bg-gray-800/50 rounded-lg p-4">
                {me ? (
                  <>
                    <div className="flex items-center gap-4">
                      <div className="text-center">
                        <div className="text-3xl font-extrabold" style={{ color: tierColor }}>
                          ¥{me.total_fee}
                        </div>
                        <div className="text-[10px] text-gray-500 mt-0.5">应付金额</div>
                      </div>
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
                  </>
                ) : (
                  <div className="text-center text-gray-500 text-sm py-2">本周期无生图记录，无需支付</div>
                )}
              </div>

              {/* Tier Table */}
              {tierRows.length > 0 && (
                <div className="bg-gray-800/50 rounded-lg p-3">
                  <div className="flex items-center gap-2 mb-2">
                    <Layers className="w-3.5 h-3.5 text-gray-400" />
                    <span className="text-xs font-medium text-gray-400">阶梯结算明细</span>
                    <span className="ml-auto text-[10px] text-gray-600">人均/期</span>
                  </div>
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-gray-500 border-b border-gray-700/50">
                        <th className="py-1 text-left font-medium">阶梯</th>
                        <th className="py-1 text-right font-medium">张数</th>
                        <th className="py-1 text-right font-medium">人数</th>
                        <th className="py-1 text-right font-medium">人均费用</th>
                      </tr>
                    </thead>
                    <tbody>
                      {tierRows.map(r => (
                        <tr key={r.name} className={`border-b border-gray-800/50 ${me?.tier_name === r.name ? 'bg-nai-accent/5' : ''}`}>
                          <td className="py-1.5">
                            <span className="inline-block w-2 h-2 rounded-sm mr-1.5" style={{ background: TIER_COLORS[r.name] }} />
                            {r.name}
                          </td>
                          <td className="py-1.5 text-right text-gray-500 text-[10px]">{r.range}</td>
                          <td className="py-1.5 text-right text-gray-400">{r.count}人</td>
                          <td className="py-1.5 text-right font-mono" style={{ color: TIER_COLORS[r.name] }}>{r.avgFee}</td>
                        </tr>
                      ))}
                      {/* Total row */}
                      <tr className="border-t border-gray-600/50">
                        <td className="py-1.5 font-medium text-gray-300" colSpan={3}>总计</td>
                        <td className="py-1.5 text-right font-mono font-medium text-white">¥{tierTotal}</td>
                      </tr>
                    </tbody>
                  </table>
                  <div className="mt-2 text-[10px] text-gray-500">
                    ≤{report.free_threshold}张免费 · 活跃用户 {report.active_user_count}人
                    {report.anlas_threshold > 0 && (
                      <> · Anlas超{report.anlas_threshold}点+¥{report.anlas_surcharge}</>
                    )}
                  </div>
                </div>
              )}

              {/* Usage Detail */}
              {me && report && (
                <UsageDetailPanel
                  userId={me.user_id}
                  periodStart={report.period_start}
                  periodEnd={report.period_end}
                />
              )}

              {/* Payment Section */}
              {status === 'unpaid' && me && me.total_fee > 0 && (
                <div className="bg-gray-800/50 rounded-lg p-4">
                  <div className="flex items-center gap-2 mb-3">
                    <QrCode className="w-4 h-4 text-nai-accent" />
                    <span className="text-sm font-medium text-gray-300">扫码支付</span>
                  </div>

                  {/* Payment method tabs */}
                  <div className="flex gap-1 bg-gray-900/50 rounded-lg p-0.5 mb-3">
                    <button
                      onClick={() => setPayMethod('wechat')}
                      className={`flex-1 flex items-center justify-center gap-1.5 py-1.5 text-xs rounded-md transition-colors ${
                        payMethod === 'wechat' ? 'bg-green-600/30 text-green-400' : 'text-gray-500 hover:text-gray-300'
                      }`}
                    >
                      <span>💬</span> 微信
                    </button>
                    <button
                      onClick={() => setPayMethod('alipay')}
                      className={`flex-1 flex items-center justify-center gap-1.5 py-1.5 text-xs rounded-md transition-colors ${
                        payMethod === 'alipay' ? 'bg-blue-600/30 text-blue-400' : 'text-gray-500 hover:text-gray-300'
                      }`}
                    >
                      <span>💙</span> 支付宝
                    </button>
                  </div>

                  <div className="flex flex-col items-center gap-3">
                    <div className="w-48 rounded-lg overflow-hidden bg-white">
                      <img
                        key={payMethod}
                        src={paymentQrUrl}
                        alt={payMethod === 'wechat' ? '微信收款码' : '支付宝收款码'}
                        className="w-full h-auto"
                        onError={(e) => {
                          (e.target as HTMLImageElement).style.display = 'none';
                          (e.target as HTMLImageElement).parentElement!.innerHTML = '<div class="text-gray-400 text-xs text-center py-8">收款码<br/>待配置</div>';
                        }}
                      />
                    </div>
                    <div className="flex items-center gap-3">
                      <div className="text-sm text-gray-300">
                        {payMethod === 'wechat' ? '微信' : '支付宝'}扫码支付 <span className="font-bold text-white">¥{me.total_fee}</span>
                      </div>
                      <button
                        onClick={() => {
                          if (!paymentQrUrl) return;
                          const a = document.createElement('a');
                          a.href = paymentQrUrl;
                          a.download = `payment_qr_${payMethod}.png`;
                          a.target = '_blank';
                          a.click();
                        }}
                        className="flex items-center gap-1 px-2 py-1 text-[11px] text-gray-400 hover:text-gray-200 bg-gray-700/50 hover:bg-gray-700 rounded transition-colors"
                        title="保存收款码"
                      >
                        <Download className="w-3 h-3" />
                        保存
                      </button>
                    </div>
                  </div>
                  <button
                    onClick={handleMarkPaid}
                    disabled={marking}
                    className="mt-3 w-full py-2 bg-nai-accent/20 hover:bg-nai-accent/30 text-nai-accent text-sm font-medium rounded-lg transition-colors disabled:opacity-50"
                  >
                    {marking ? '提交中...' : '我已支付'}
                  </button>
                </div>
              )}

              {/* Paid */}
              {status === 'paid' && (
                <div className="bg-green-900/20 border border-green-700/30 rounded-lg p-3 text-center">
                  <CheckCircle className="w-5 h-5 text-green-400 mx-auto mb-1" />
                  <div className="text-sm text-green-400">已确认支付</div>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
};
