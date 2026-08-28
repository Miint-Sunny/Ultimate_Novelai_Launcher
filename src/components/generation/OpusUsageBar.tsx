import type { OpusUsage } from '../../api/localSidecarApi';

/**
 * Opus「体力条」。
 *
 * V5 之前 Opus 的小图生成是无限的;V5 起它走一条会耗尽、也会持续恢复的额度。
 * 这个条之所以必须显示,不是为了好看:**额度耗尽时 NovelAI 不报错、也不返回
 * 402,它照常出图,然后开始扣 Anlas**。界面上没有这个数,用户就是在毫不知情
 * 的情况下从免费切到付费。
 *
 * 只对 Opus 且选中 V5 时显示——低档位订阅根本没有这个字段,4.5 及以下也不消耗它。
 */
export function OpusUsageBar({ usage }: { usage: OpusUsage }) {
  // percent 可以大于 100(官方发过一次性超额补偿),条本身按 100 封顶画,
  // 但数字照实显示。
  const clamped = Math.max(0, Math.min(100, usage.percent));
  const exhausted = usage.isNegative || usage.percent <= 0;
  const low = !exhausted && usage.percent <= 10;

  return (
    <div className="px-0.5 py-1">
      <div className="flex items-baseline justify-between mb-1">
        <span className="text-[10px] text-gray-400">
          剩余 V5 免费额度
        </span>
        <span
          className={`text-[10px] font-mono font-bold ${
            exhausted ? 'text-red-400' : low ? 'text-yellow-400' : 'text-gray-300'
          }`}
        >
          {usage.percent}%
        </span>
      </div>
      <div className="h-1 rounded-full bg-gray-700 overflow-hidden">
        <div
          className={`h-full rounded-full transition-[width] duration-500 ${
            exhausted ? 'bg-red-500' : low ? 'bg-yellow-500' : 'bg-nai-accent'
          }`}
          style={{ width: `${clamped}%` }}
        />
      </div>
      {exhausted && (
        <div className="mt-1 text-[10px] text-red-400 leading-snug">
          额度已用尽,继续生成将消耗 Anlas
        </div>
      )}
    </div>
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
