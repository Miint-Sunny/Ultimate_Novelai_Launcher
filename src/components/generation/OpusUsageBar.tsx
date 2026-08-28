import { useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import type { OpusUsage } from '../../api/localSidecarApi';

/**
 * Opus「体力条」。形态对齐 NovelAI 官方(2026-08-28 抓取):
 * 生成按钮正上方一条**极细**的横条,左侧「N% of Opus Generations remaining」,
 * 右侧一个「更多信息」链接;点开是一张说明卡,含正文、粗条、恢复状态。
 *
 * 为什么必须显示:额度耗尽时 NovelAI **不报错、不返回 402**,它照常出图然后
 * 开始扣 Anlas。这条是用户唯一能看到的越界提示。
 *
 * 只在「Opus + 有读数 + 当前模型确实消耗这条额度」三者同时成立时出现——
 * 给 4.5 用户显示一条他们生成时根本不消耗的额度,是另一种形式的误导。
 */

/** 官方口径:满条约 1730 张普通小图(实测 1600–1700,官方展开面板按此换算)。 */
const IMAGES_PER_PERCENT = 17.3;

function estimateImages(percent: number): number {
  return Math.round(Math.max(0, percent) * IMAGES_PER_PERCENT);
}

function formatRecovery(usage: OpusUsage): string {
  if (usage.percent > 100) return '已超过 100%,恢复暂停中。';
  if (usage.timeUntilNextPercent <= 0) return '恢复暂停中。';
  const minutes = Math.round(usage.timeUntilNextPercent / 60);
  if (minutes < 60) return `约 ${minutes} 分钟后恢复 1%。`;
  return `约 ${Math.round(minutes / 60)} 小时后恢复 1%。`;
}

export function OpusUsageBar({ usage }: { usage: OpusUsage }) {
  const [isDetailOpen, setIsDetailOpen] = useState(false);
  // 条本身按 100% 封顶画,数字照实显示(官方发过一次性超额补偿,实测见过 170%)
  const filled = Math.max(0, Math.min(100, usage.percent));
  const exhausted = usage.isNegative || usage.percent <= 0;
  const low = !exhausted && usage.percent <= 10;
  const accent = exhausted ? 'bg-red-500' : low ? 'bg-amber-500' : 'bg-nai-accent';

  return (
    <>
      <div className="px-3 pt-1.5 select-none">
        <div className="flex items-baseline justify-between gap-2 mb-1">
          <span className={`text-[10px] leading-none truncate ${exhausted ? 'text-red-400' : 'text-gray-500'}`}>
            {exhausted
              ? '免费额度已用尽,继续生成将消耗 Anlas'
              : `剩余 ${usage.percent}% 的 Opus 免费生成额度`}
          </span>
          <button
            onClick={() => setIsDetailOpen(true)}
            title="查看 Opus 免费额度说明"
            className="text-[10px] leading-none shrink-0 text-gray-500 hover:text-white underline underline-offset-2 transition-colors"
          >
            更多信息
          </button>
        </div>
        <div className="h-[3px] rounded-full bg-gray-700/50 overflow-hidden">
          <div className={`h-full rounded-full transition-all ${accent}`} style={{ width: `${filled}%` }} />
        </div>
      </div>

      {isDetailOpen && createPortal(
        <div
          className="fixed inset-0 z-[9999] bg-black/80 backdrop-blur-sm flex items-center justify-center p-4"
          onClick={() => setIsDetailOpen(false)}
        >
          <div
            className="bg-nai-panel border border-gray-700 rounded-xl shadow-2xl w-full max-w-md p-5"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-3 mb-3">
              <h3 className="text-base font-bold text-white">Opus 免费额度</h3>
              <button
                onClick={() => setIsDetailOpen(false)}
                title="关闭"
                className="p-1 -m-1 text-gray-400 hover:text-white transition-colors shrink-0"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <p className="text-sm text-gray-300 leading-relaxed mb-4">
              Opus 订阅包含普通分辨率、28 步以内的 NovelAI Diffusion V5 免费生成。
              这份额度有上限,并会随时间自动恢复;用尽后仍可继续生成,但会消耗 Anlas。
            </p>

            <div className="text-sm font-bold text-white mb-2">
              剩余 {usage.percent}%
              <span className="text-gray-400 font-normal">(约 {estimateImages(usage.percent)} 张)</span>
            </div>
            <div className="h-2 rounded-full bg-gray-800 overflow-hidden mb-3">
              <div className={`h-full rounded-full transition-all ${accent}`} style={{ width: `${filled}%` }} />
            </div>

            <p className="text-xs text-gray-500 leading-relaxed">
              {formatRecovery(usage)}
              <br />
              只有 V5 会消耗这份额度,V4.5 及更早的模型对 Opus 仍是无限生成。
            </p>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}

/**
 * 体力条是否该出现:得是 Opus、有这个字段、且当前模型确实吃这条额度。
 * 三个条件缺一不可——对 4.5 显示一条它不消耗的额度只会误导。
 */
export function shouldShowOpusUsage(
  usage: OpusUsage | undefined,
  isOpus: boolean,
  modelUsesOpusQuota: boolean,
): usage is OpusUsage {
  return !!usage && isOpus && modelUsesOpusQuota;
}
