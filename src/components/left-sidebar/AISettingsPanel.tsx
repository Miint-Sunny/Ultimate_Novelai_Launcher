import { useState, type ReactNode, type RefObject } from 'react';
import { Check, ChevronDown, RotateCcw, X } from 'lucide-react';
import { NOISE_SCHEDULES, SAMPLER_OPTIONS } from '../../utils/generationOptions';
import { modelCapabilities } from '../generation/modelResolutionOptions';
import { HelpTip } from './HelpTip';

interface AISettingsPanelProps {
  panelRef: RefObject<HTMLDivElement | null>;
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  onReset: () => void;
  highlightSetting: string | null;
  steps: number;
  onStepsChange: (value: number) => void;
  scale: number;
  onScaleChange: (value: number) => void;
  seed: string;
  onSeedChange: (value: string) => void;
  sampler: string;
  onSamplerChange: (value: string) => void;
  scaleRescale: number;
  onScaleRescaleChange: (value: number) => void;
  noiseSchedule: string;
  onNoiseScheduleChange: (value: string) => void;
  varietyPlus: boolean;
  onVarietyPlusChange: (value: boolean) => void;
  /** 当前模型(UI id 或后端名)。用于按能力位隐藏该模型不支持的控件。 */
  model: string;
  transparentBackground: boolean;
  onTransparentBackgroundChange: (value: boolean) => void;
}

export function AISettingsPanel({
  panelRef,
  isOpen,
  onOpenChange,
  onReset,
  highlightSetting,
  steps,
  onStepsChange,
  scale,
  onScaleChange,
  seed,
  onSeedChange,
  sampler,
  onSamplerChange,
  scaleRescale,
  onScaleRescaleChange,
  noiseSchedule,
  onNoiseScheduleChange,
  varietyPlus,
  onVarietyPlusChange,
  model,
  transparentBackground,
  onTransparentBackgroundChange,
}: AISettingsPanelProps) {
  const [isAdvancedOpen, setIsAdvancedOpen] = useState(false);
  // 这两个控件在 V5 上是死的:噪声调度被官方强制写死 karras,Variety+ 整个不存在。
  // 与其留着让用户调一个不会生效的旋钮,不如照官方客户端的做法整个不渲染。
  const caps = modelCapabilities(model);

  return (
    <div ref={panelRef} className="bg-nai-panel border border-gray-700 rounded-lg p-2.5 space-y-3">
      <div
        className="flex items-center justify-between text-gray-300 cursor-pointer select-none"
        onClick={() => onOpenChange(!isOpen)}
      >
        <span className="font-bold text-sm">AI Settings</span>
        <div className="flex items-center gap-2">
          <button
            className="p-1 hover:text-white text-gray-400 transition-colors"
            title="Reset"
            onClick={(event) => {
              event.stopPropagation();
              onReset();
            }}
          >
            <RotateCcw className="w-3 h-3" />
          </button>
          <ChevronDown className={`w-4 h-4 hover:text-white transition-transform ${isOpen ? '' : '-rotate-90'}`} />
        </div>
      </div>

      {isOpen && (
        <div className="space-y-3 animate-in slide-in-from-top-2 duration-200">
          <HighlightedSetting active={highlightSetting === 'steps'}>
            <div className="flex items-center justify-between text-xs mb-1">
              <span className="text-gray-300 font-bold flex items-center">
                Steps: {steps}
                <HelpTip title="采样步数 (Steps)" body={"采样步数，控制去噪迭代次数。\n步数越高画面越精细，但生成越慢。\n步数过多反而收益递减，甚至适得其反。\n💡 步数 ≤28 时不额外消耗 Anlas"} />
              </span>
            </div>
            <RangeInput min={1} max={50} value={steps} onChange={onStepsChange} />
          </HighlightedSetting>

          <HighlightedSetting active={highlightSetting === 'scale'}>
            <div className="flex items-center justify-between text-xs mb-1">
              <span className="text-gray-300 font-bold flex items-center">
                Prompt Guidance: {scale}
                <HelpTip title="提示词引导强度 (CFG Scale)" body={"控制 AI 对提示词的遵循程度。\n· 值越低 → AI 越自由发挥，画面更绘画感、柔和、梦幻\n· 值越高 → 越严格遵循描述，细节更精细锐利\n💡 V3 及以上模型官方推荐 5~6\n💡 过高反而会反作用，色彩过饱和、画面崩坏"} />
              </span>
              {caps.varietyPlus && (
                <span className="flex items-center gap-1">
                  <button
                    onClick={() => onVarietyPlusChange(!varietyPlus)}
                    className={`px-1 py-0.5 text-[10px] rounded border flex items-center gap-1 transition-colors ${varietyPlus
                      ? 'bg-nai-accent/20 text-nai-accent border-nai-accent'
                      : 'bg-gray-800 text-gray-400 border-gray-700 hover:text-white'
                    }`}
                  >
                    {varietyPlus ? <Check className="w-2 h-2" /> : <X className="w-2 h-2" />} Variety+
                  </button>
                  <HelpTip title="多样性增强模式 (Variety+)" body={"轻微调整采样过程，提升构图与姿势的多样性。\n开启 → 增加构图和姿势的变化\n关闭 → 出图更稳定一致\n💡 在低 Prompt Guidance 下效果更明显"} />
                </span>
              )}
            </div>
            <RangeInput min={0} max={25} step={0.1} value={scale} onChange={onScaleChange} />
          </HighlightedSetting>

          <div className="grid grid-cols-2 gap-2">
            <HighlightedSetting active={highlightSetting === 'seed'}>
              <div className="flex items-center justify-between text-xs mb-1">
                <span className="text-gray-300 flex items-center">
                  Seed
                  <HelpTip title="随机种子 (Seed)" body={"随机种子，决定初始噪声。\n相同种子 + 相同参数 → 基本一致的画面\n适合微调时锁定构图。\n留空 → 每次随机生成不同结果\n💡 sampler 本身有微小随机性，相同种子也可能存在细微差别\n💡 NAI 的 seed 与外部 Stable Diffusion 不通用"} />
                </span>
                <button className="text-gray-500 hover:text-white text-xs" onClick={() => onSeedChange('')}>Clear</button>
              </div>
              <input
                type="text"
                value={seed}
                onChange={(event) => onSeedChange(event.target.value)}
                className="w-full bg-black/30 border border-gray-700 rounded px-2 py-1.5 text-xs text-white outline-none focus:border-nai-accent"
                placeholder="Random"
              />
            </HighlightedSetting>

            <HighlightedSetting active={highlightSetting === 'sampler'}>
              <div className="text-xs text-gray-300 mb-1 flex items-center">
                Sampler
                <HelpTip title="采样算法 (Sampler)" body={"决定去噪路径，影响画面风格与稳定性。\n· Euler Ancestral — 经典万能，随机性高\n· Euler — 确定性版本，构图更稳定\n· DPM++ 2S Ancestral — 细节丰富\n· DPM++ 2M SDE — 高质量 + 随机性\n· DPM++ 2M — 高质量确定性采样\n· DPM++ SDE — 兼具细节与多样性\n💡 建议保持默认或推荐 DPM++ 2M / Euler Ancestral\n💡 不同 sampler 的差异在低 Steps 时更明显"} />
              </div>
              <SelectInput value={sampler} onChange={onSamplerChange} options={SAMPLER_OPTIONS.map((option) => option.label)} />
            </HighlightedSetting>
          </div>

          <div className="pt-2 border-t border-gray-800">
            <button
              type="button"
              className="w-full flex items-center justify-between text-xs font-bold text-gray-400 hover:text-gray-200 transition-colors"
              onClick={() => setIsAdvancedOpen(!isAdvancedOpen)}
            >
              <span>Advanced Settings</span>
              <ChevronDown className={`w-3.5 h-3.5 transition-transform ${isAdvancedOpen ? '' : '-rotate-90'}`} />
            </button>

            {isAdvancedOpen && (
              <div className="mt-3 space-y-3 animate-in slide-in-from-top-1 duration-150">
                <div>
                  <div className="flex items-center justify-between text-xs mb-1">
                    <span className="text-gray-300 font-bold flex items-center">
                      Prompt Guidance Rescale: {scaleRescale}
                      <HelpTip title="CFG 引导修正系数 (Rescale)" body={"抑制高引导值带来的过饱和与色彩溢出。\n0 = 不修正，值越高 → 修正越强\n通常保持 0；Guidance >7 时可尝试 0.1~0.3\n💡 画面出现\"边缘色彩过强 / 油炸感 (deepfried)\"时调高"} />
                    </span>
                  </div>
                  <RangeInput min={0} max={1} step={0.01} value={scaleRescale} onChange={onScaleRescaleChange} />
                </div>

                {caps.transparency && (
                  <div>
                    <div className="text-xs text-gray-300 mb-1 flex items-center">
                      透明背景
                      <HelpTip title="透明背景 (V5)" body={"直接输出带 alpha 通道的图，省去后期抠图。\n开启后会在提示词里加入 transparent background，并让模型以透明方式生成。\n💡 不稳定时可在提示词里写 2.1::transparent background::\n💡 比导演工具的去背不消耗点数，效果也更好"} />
                    </div>
                    <button
                      onClick={() => onTransparentBackgroundChange(!transparentBackground)}
                      className={`w-full px-2 py-1 text-xs rounded border flex items-center justify-center gap-1 transition-colors ${transparentBackground
                        ? 'bg-nai-accent/20 text-nai-accent border-nai-accent'
                        : 'bg-gray-800 text-gray-400 border-gray-700 hover:text-white'
                      }`}
                    >
                      {transparentBackground ? <Check className="w-3 h-3" /> : <X className="w-3 h-3" />}
                      {transparentBackground ? '已开启' : '关闭'}
                    </button>
                  </div>
                )}

                {caps.noiseSchedule && (
                  <div>
                    <div className="text-xs text-gray-300 mb-1 flex items-center">
                      Noise Schedule
                      <HelpTip title="噪声衰减曲线 (Noise Schedule)" body={"决定 Sampler 在每一步的噪声衰减节奏，影响画面质感。\n· karras — 最常用，出图稳定细节好\n· exponential — 指数衰减，对比度更强\n· polyexponential — 多项式衰减，过渡平滑\n💡建议保持默认 karras"} />
                    </div>
                    <SelectInput value={noiseSchedule} onChange={onNoiseScheduleChange} options={[...NOISE_SCHEDULES]} />
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function HighlightedSetting({ active, children }: { active: boolean; children: ReactNode }) {
  return (
    <div className={`transition-all duration-500 rounded p-1 ${active ? 'bg-white/10 ring-1 ring-nai-accent' : ''}`}>
      {children}
    </div>
  );
}

function RangeInput({ min, max, step, value, onChange }: {
  min: number;
  max: number;
  step?: number;
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <input
      type="range"
      min={min}
      max={max}
      step={step}
      value={value}
      onChange={(event) => onChange(Number(event.target.value))}
      className="w-full h-1 bg-gray-700 rounded-lg appearance-none cursor-pointer accent-nai-accent"
    />
  );
}

function SelectInput({ value, onChange, options }: {
  value: string;
  onChange: (value: string) => void;
  options: string[];
}) {
  return (
    <div className="relative">
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="w-full bg-black/30 border border-gray-700 rounded px-2 py-1.5 text-xs text-white appearance-none outline-none focus:border-nai-accent"
      >
        {options.map((option) => (
          <option key={option} value={option}>{option}</option>
        ))}
      </select>
      <ChevronDown className="absolute right-2 top-2 w-3 h-3 text-gray-400 pointer-events-none" />
    </div>
  );
}
