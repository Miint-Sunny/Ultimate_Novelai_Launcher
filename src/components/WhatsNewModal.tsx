/**
 * 新版本功能导览（What's New Tour）
 *
 * 行为：
 * - 仅在用户首次进入新版本（changelog 头条版本号未读）时自动弹出，代替 ChangelogModal
 * - 关闭时一并标记 changelog_last_seen_version，下次刷新不再弹任何窗口
 * - 多页分步式：4 张幻灯片，逐个介绍 Beta24 的新特性
 * - 全部使用纯色 + 透明度（无任何渐变）
 *
 * 触发流程：
 *   App 加载 → ChangelogModal 检查 → 若未读，先派发 'whats-new-open' 让本组件接管
 *   本组件检查到匹配的 tour 数据则展示，关闭时落库；否则放行让 ChangelogModal 接管
 */
import React, { useEffect, useMemo, useState } from 'react';
import {
  X,
  ChevronLeft,
  ChevronRight,
  Sparkles,
  BookOpen,
  Languages,
  Layers,
  Link2,
  Tag,
  Tags,
  Palette,
  Users,
  User,
  ExternalLink,
  MousePointer2,
  ArrowUp,
  EyeOff,
  Trash2,
  Settings,
  Ban,
} from 'lucide-react';
import { changelog } from '../data/changelog';

const STORAGE_KEY = 'changelog_last_seen_version';

// hasWhatsNewForLatest / shouldShowWhatsNew 定义在 SLIDES_BY_VERSION 之后,见文件中段

interface FeatureSlide {
  key: string;
  badgeText: string;          // 顶部小徽章文字
  Icon: React.ComponentType<{ className?: string; strokeWidth?: number; style?: React.CSSProperties }>;
  iconColor: string;          // 徽章图标色
  title: string;
  subtitle: string;
  bullets: string[];
  preview: React.ReactNode;
}

// ==================== 预览区：Wiki 预览 ====================
const WikiPreviewMock: React.FC = () => {
  const tags = [
    { tag: '1girl', cn: '少女', count: '4.5M', active: false },
    { tag: 'long_hair', cn: '长发', count: '3.1M', active: true },
    { tag: 'school_uniform', cn: '校服', count: '820k', active: false },
    { tag: 'cat_ears', cn: '猫耳', count: '410k', active: false },
    { tag: 'blue_eyes', cn: '蓝眼', count: '1.2M', active: false },
    { tag: 'hair_ribbon', cn: '发带', count: '530k', active: false },
  ];

  return (
    <div className="relative h-full w-full flex items-center justify-center gap-4 px-4">
      <style>{`
        @keyframes wikiCursorPath {
          0%, 14% { transform: translate(166px, 168px); opacity: 0; }
          28%, 76% { transform: translate(100px, 62px); opacity: 1; }
          90%, 100% { transform: translate(100px, 62px); opacity: 0; }
        }
        @keyframes wikiHoverRow {
          0%, 24%, 86%, 100% { background: transparent; box-shadow: none; }
          36%, 76% { background: rgba(252, 237, 164, 0.1); box-shadow: inset 0 0 0 1px rgba(252, 237, 164, 0.14); }
        }
        @keyframes wikiCardReveal {
          0%, 32%, 88%, 100% { opacity: 0; transform: translateX(-10px) scale(0.97); filter: blur(2px); }
          44%, 78% { opacity: 1; transform: translateX(0) scale(1); filter: blur(0); }
        }
        @keyframes wikiHintPulse {
          0%, 32%, 86%, 100% { opacity: 0.35; }
          44%, 78% { opacity: 0.9; }
        }
        @keyframes wikiImageSwap {
          0%, 44%, 100% { opacity: 0.3; transform: scale(0.96); }
          54%, 78% { opacity: 0.85; transform: scale(1); }
        }
      `}</style>

      <div className="relative w-[200px] shrink-0 bg-[#0f0f0f] rounded-md border border-[#fceda4]/10 overflow-hidden">
        {tags.map(s => (
          <div
            key={s.tag}
            className="relative px-2.5 py-1.5 flex items-center gap-2 border-l-2"
            style={{
              borderLeftColor: s.active ? '#fcd34d' : '#fcd34d55',
              animation: s.active ? 'wikiHoverRow 4.2s ease-in-out infinite' : undefined,
            }}
          >
            <Tag className="shrink-0 w-3.5 h-3.5 text-[#fcd34d]/75" />
            <div className="flex flex-col min-w-0 flex-1 leading-tight gap-0.5">
              <span className={`font-tag text-[13px] truncate ${s.active ? 'text-white' : 'text-[#d4d4d4]'}`}>{s.tag}</span>
              <span className={`text-[10px] truncate ${s.active ? 'text-white/55' : 'text-[#6e7681]'}`}>{s.cn}</span>
            </div>
            <span className={`shrink-0 text-[10px] tabular-nums ${s.active ? 'text-white/60' : 'text-[#6e7681]'}`}>{s.count}</span>
          </div>
        ))}

        <div
          className="pointer-events-none absolute left-0 top-0 z-10"
          style={{ animation: 'wikiCursorPath 4.2s ease-in-out infinite' }}
        >
          <div className="relative h-4 w-4">
            <MousePointer2
              className="absolute left-[-1px] top-[-1px] h-[18px] w-[18px] text-black"
              strokeWidth={3}
              fill="black"
            />
            <MousePointer2
              className="absolute left-0 top-0 h-4 w-4 text-white"
              strokeWidth={2.3}
              fill="white"
            />
          </div>
        </div>
      </div>

      <div
        className="w-[260px] shrink-0 rounded-lg bg-[#111315] overflow-hidden border border-[#fceda4]/22 shadow-[0_18px_50px_rgba(0,0,0,0.35)]"
        style={{ animation: 'wikiCardReveal 4.2s ease-in-out infinite' }}
      >
        <div className="relative h-[120px] bg-black/40 flex items-center justify-center">
          <div className="absolute inset-0 opacity-35 bg-[radial-gradient(circle_at_35%_35%,rgba(252,237,164,0.22),transparent_38%),linear-gradient(135deg,rgba(125,211,252,0.16),rgba(240,171,252,0.12))]" />
          <div className="relative flex flex-col items-center gap-1 text-white/30 text-[11px]" style={{ animation: 'wikiImageSwap 4.2s ease-in-out infinite' }}>
            <BookOpen className="w-7 h-7 opacity-70" strokeWidth={1.5} />
            <span>示例图轮播</span>
          </div>
          <div className="absolute bottom-2 left-0 right-0 flex items-center justify-center gap-1">
            <span className="h-1.5 w-4 rounded-full bg-[#fceda4]" />
            <span className="h-1.5 w-1.5 rounded-full bg-white/25" />
            <span className="h-1.5 w-1.5 rounded-full bg-white/25" />
          </div>
        </div>
        <div className="p-2.5">
          <div className="font-tag text-[13px] leading-tight text-[#fceda4]">long_hair</div>
          <div className="mt-0.5 text-[10px] leading-snug text-white/42">长发 / hair_long</div>
          <p className="mt-1.5 text-[11px] leading-relaxed text-white/72 line-clamp-3">
            指角色头发垂至肩部以下的长度。Danbooru 上常见发型标签之一，通常和 very_long_hair 等标签联用。
          </p>
          <div className="mt-2 flex items-center justify-between text-[10px] text-white/35">
            <span>#7234156</span>
            <span className="inline-flex items-center gap-1 text-[#fceda4]/70">
              <span>Wiki</span>
              <ExternalLink className="h-3 w-3" strokeWidth={1.8} />
            </span>
          </div>
        </div>
      </div>
    </div>
  );
};

const WikiPreviewMockStatic: React.FC = () => (
    <div className="relative h-full w-full flex items-center justify-center gap-2 px-4">
    {/* 左侧：补全列表（高亮其中一项） */}
    <div className="w-[200px] shrink-0 bg-[#0f0f0f] rounded-md border border-[#fceda4]/10 overflow-hidden">
      {[
        { tag: '1girl', cn: '少女', count: '4.5M', sel: false, color: '#fcd34d' },
        { tag: 'long_hair', cn: '长发', count: '3.1M', sel: true, color: '#fcd34d' },
        { tag: 'school_uniform', cn: '校服', count: '820k', sel: false, color: '#fcd34d' },
        { tag: 'cat_ears', cn: '猫耳', count: '410k', sel: false, color: '#fcd34d' },
      ].map((s, i) => (
        <div
          key={i}
          className={`px-2.5 py-1.5 flex items-center gap-2 border-l-2 ${
            s.sel ? 'bg-white/[0.06]' : ''
          }`}
          style={{ borderLeftColor: s.sel ? s.color : `${s.color}55` }}
        >
          <Tag className="shrink-0 w-3.5 h-3.5" style={{ color: s.color, opacity: s.sel ? 1 : 0.75 }} />
          <div className="flex flex-col min-w-0 flex-1 leading-tight gap-0.5">
            <span className={`font-tag text-[13px] truncate ${s.sel ? 'text-white' : 'text-[#d4d4d4]'}`}>{s.tag}</span>
            <span className={`text-[10px] truncate ${s.sel ? 'text-white/55' : 'text-[#6e7681]'}`}>{s.cn}</span>
          </div>
          <span className={`shrink-0 text-[10px] tabular-nums ${s.sel ? 'text-white/60' : 'text-[#6e7681]'}`}>{s.count}</span>
        </div>
      ))}
    </div>

    {/* 提示箭头 */}
    <div className="flex flex-col items-center text-[#fceda4]/55">
      <span className="text-[10px] mb-0.5">悬停</span>
      <ChevronRight className="w-4 h-4" strokeWidth={2} />
    </div>

    {/* 右侧：Wiki 预览卡 */}
    <div className="w-[260px] shrink-0 rounded-lg bg-[#111315] overflow-hidden border border-[#fceda4]/22">
      {/* 顶部图区 */}
      <div className="relative h-[120px] bg-black/40 flex items-center justify-center">
        <div className="w-full h-full flex items-center justify-center text-white/15 text-[11px]">
          <div className="flex flex-col items-center gap-1">
            <BookOpen className="w-7 h-7 opacity-40" strokeWidth={1.5} />
            <span>示例图轮播</span>
          </div>
        </div>
        {/* 指示点 */}
        <div className="absolute bottom-2 left-0 right-0 flex items-center justify-center gap-1">
          <span className="h-1.5 w-4 rounded-full bg-[#fceda4]" />
          <span className="h-1.5 w-1.5 rounded-full bg-white/25" />
          <span className="h-1.5 w-1.5 rounded-full bg-white/25" />
        </div>
      </div>
      {/* 文本区 */}
      <div className="p-2.5">
        <div className="font-tag text-[13px] leading-tight text-[#fceda4]">long_hair</div>
        <div className="mt-0.5 text-[10px] leading-snug text-white/42">长发 / hair_long</div>
        <p className="mt-1.5 text-[11px] leading-relaxed text-white/72 line-clamp-3">
          指角色头发垂至肩部以下的长度。Danbooru 上最常见的发型标签之一，常与 hair_between_eyes、very_long_hair 联用。
        </p>
        <div className="mt-2 flex items-center justify-between text-[10px] text-white/35">
          <span>#7234156</span>
          <span className="inline-flex items-center gap-1 text-[#fceda4]/70">
            <span>Wiki</span>
            <ExternalLink className="h-3 w-3" strokeWidth={1.8} />
          </span>
        </div>
      </div>
    </div>
  </div>
);

// ==================== 预览区：关联推荐 ====================
const RelatedTagsMock: React.FC = () => {
  const related = [
    { tag: 'solo', cn: '单人' },
    { tag: 'long_hair', cn: '长发' },
    { tag: 'looking_at_viewer', cn: '看向画面' },
    { tag: 'school_uniform', cn: '校服' },
    { tag: 'smile', cn: '微笑' },
    { tag: 'hair_ribbon', cn: '发带' },
    { tag: 'simple_background', cn: '纯色背景' },
    { tag: 'blue_eyes', cn: '蓝眼' },
    { tag: 'bangs', cn: '刘海' },
    { tag: 'blush', cn: '脸红' },
    { tag: 'upper_body', cn: '上半身' },
    { tag: 'white_shirt', cn: '白衬衫' },
  ];

  return (
    <div className="relative h-full w-full flex items-center justify-center px-4">
      <style>{`
        @keyframes relatedCursorPath {
          0%, 52% { transform: translate(410px, 218px); opacity: 0; }
          64%, 88% { transform: translate(360px, 158px); opacity: 1; }
          90%, 100% { transform: translate(360px, 158px); opacity: 0; }
        }
        @keyframes relatedPanelPop {
          0%, 8% { opacity: 0; transform: translate(-50%, -48%) scale(0.98); filter: blur(1px); }
          18%, 100% { opacity: 1; transform: translate(-50%, -50%) scale(1); filter: blur(0); }
        }
        @keyframes relatedRowScroll {
          0%, 76% { transform: translateX(0); }
          90%, 100% { transform: translateX(-132px); }
        }
        @keyframes relatedArrowClick {
          0%, 72%, 92%, 100% { background: transparent; color: rgba(252, 237, 164, 0.6); transform: scale(1); }
          80%, 86% { background: rgba(252, 237, 164, 0.12); color: #fceda4; transform: scale(0.92); }
        }
        @keyframes relatedSkeletonFade {
          0%, 18% { opacity: 0; }
          26%, 44% { opacity: 1; }
          54%, 100% { opacity: 0; }
        }
        @keyframes relatedResultsFade {
          0%, 50% { opacity: 0; transform: translateY(2px); }
          62%, 100% { opacity: 1; transform: translateY(0); }
        }
      `}</style>

      <div className="relative w-[430px] h-[235px]">
        <div
          className="absolute left-1/2 top-1/2 w-[330px] -translate-x-1/2 -translate-y-1/2 rounded-lg bg-[#0f0f0f] shadow-[0_16px_40px_-10px_rgba(0,0,0,0.85),0_0_0_1px_rgba(252,237,164,0.08)] overflow-hidden"
          style={{ animation: 'relatedPanelPop 4.8s ease-in-out infinite' }}
        >
          <div className="flex items-start gap-2 px-3 py-2.5">
            <div className="min-w-0 flex-1">
              <div className="font-tag text-[14px] leading-tight text-[#fceda4] truncate">black_long_thighhighs</div>
              <div className="text-[11px] leading-tight text-white/50 mt-1">黑色长过膝袜</div>
            </div>
            <button className="shrink-0 w-6 h-6 flex items-center justify-center text-white/40 rounded-md">
              <X className="w-3.5 h-3.5" strokeWidth={2} />
            </button>
          </div>

          <div className="px-2 pb-1.5">
            <div className="flex items-center gap-1 mb-1.5">
              <button className="px-2 h-6 text-[11px] font-mono bg-[#74270D]/50 text-orange-200 rounded">{'{+}'}</button>
              <button className="px-2 h-6 text-[11px] font-mono bg-blue-500/20 text-blue-200 rounded">{'[-]'}</button>
              <div className="flex-1" />
              <button className="w-6 h-6 flex items-center justify-center text-sm bg-blue-500/15 text-blue-200 rounded">-</button>
              <span className="w-9 text-center text-[12px] font-mono tabular-nums font-medium text-white/80">1.0</span>
              <button className="w-6 h-6 flex items-center justify-center text-sm bg-[#74270D]/40 text-orange-200 rounded">+</button>
            </div>
            <div className="flex items-center gap-1">
              {[0.7, 0.8, 0.9, 1.1, 1.2].map(w => {
                const isOrange = w > 1;
                const base = isOrange ? 'bg-[#74270D]/35 text-orange-200' : 'bg-blue-500/15 text-blue-200';
                return (
                <button key={w} className={`flex-1 h-6 text-[11px] font-mono tabular-nums rounded ${base}`}>
                  {w}
                </button>
                );
              })}
              <button className="px-2 h-6 text-[11px] text-white/50 rounded bg-white/[0.04]">
                清除
              </button>
            </div>
          </div>

          <div className="mx-2 h-px bg-white/[0.08]" />
          <div className="px-2 py-1 flex items-center gap-1">
            <button
              type="button"
              disabled
              className="shrink-0 w-5 h-6 flex items-center justify-center text-white/15 cursor-not-allowed"
            >
              <ChevronLeft className="w-3.5 h-3.5" strokeWidth={2.5} />
            </button>
            <div className="relative flex-1 w-0 min-w-0 overflow-hidden">
              <div className="absolute inset-0 px-1 py-1 flex items-center gap-3" style={{ animation: 'relatedSkeletonFade 4.8s ease-in-out infinite' }}>
                {[10, 8, 12, 10].map((w, i) => (
                  <div key={i} className="shrink-0 flex flex-col gap-0.5 py-0.5">
                    <div className="h-[14px] bg-white/[0.06] animate-pulse rounded-sm" style={{ width: `${w * 4}px` }} />
                    <div className="h-[12px] bg-white/[0.04] animate-pulse rounded-sm" style={{ width: `${w * 3}px` }} />
                  </div>
                ))}
              </div>
              <div className="flex items-baseline gap-x-3 gap-y-0.5 whitespace-nowrap py-0.5" style={{ animation: 'relatedResultsFade 4.8s ease-in-out infinite, relatedRowScroll 4.8s ease-in-out infinite' }}>
                {related.map((r, i) => (
                  <button key={r.tag} className="group shrink-0 inline-flex flex-col items-start text-left bg-transparent border-0 p-0">
                    <span
                      className="font-tag text-[12px] leading-tight underline underline-offset-2"
                      style={{ color: 'rgba(255,255,255,0.8)', textDecorationColor: 'transparent' }}
                    >
                      {r.tag}
                    </span>
                    <span className="text-[10px] leading-tight text-white/40">
                      {r.cn}
                    </span>
                  </button>
                ))}
              </div>
            </div>
            <button
              type="button"
              className="shrink-0 w-5 h-6 flex items-center justify-center rounded text-[#fceda4]/60"
              style={{ animation: 'relatedArrowClick 4.8s ease-in-out infinite' }}
            >
              <ChevronRight className="w-3.5 h-3.5" strokeWidth={2.5} />
            </button>
          </div>

          <div className="mx-2 h-px bg-white/[0.08]" />
          <div className="px-2 py-1.5 flex items-center gap-0.5">
            <button className="flex items-center gap-1.5 px-2 h-7 text-[11px] text-white/60 rounded">
              <ExternalLink className="w-3.5 h-3.5 shrink-0" strokeWidth={1.75} />
              <span>Wiki</span>
            </button>
            <button className="flex items-center gap-1.5 px-2 h-7 text-[11px] text-white/60 rounded">
              <ArrowUp className="w-3.5 h-3.5 shrink-0" strokeWidth={1.75} />
              <span>置顶</span>
            </button>
            <button className="flex items-center gap-1.5 px-2 h-7 text-[11px] text-white/60 rounded">
              <EyeOff className="w-3.5 h-3.5 shrink-0" strokeWidth={1.75} />
              <span>禁用</span>
            </button>
            <div className="flex-1" />
            <button className="flex items-center gap-1.5 px-2 h-7 text-[11px] text-red-400/75 rounded">
              <Trash2 className="w-3.5 h-3.5 shrink-0" strokeWidth={1.75} />
              <span>删除</span>
            </button>
          </div>
        </div>

        <div className="pointer-events-none absolute left-0 top-0 z-10" style={{ animation: 'relatedCursorPath 4.8s ease-in-out infinite' }}>
          <div className="relative h-4 w-4">
            <MousePointer2 className="absolute left-[-1px] top-[-1px] h-[18px] w-[18px] text-black" strokeWidth={3} fill="black" />
            <MousePointer2 className="absolute left-0 top-0 h-4 w-4 text-white" strokeWidth={2.3} fill="white" />
          </div>
        </div>
      </div>
    </div>
  );
};

const RelatedTagsMockStatic: React.FC = () => (
  <div className="h-full w-full flex flex-col items-center justify-center gap-3 px-4">
    {/* 顶部：选中的 chip */}
    <div className="flex items-center gap-2">
      <span className="text-[11px] text-white/45">点击芯片</span>
      <ChevronRight className="w-3 h-3 text-white/30" />
      <span
        className="px-2 py-0.5 rounded text-[12px] font-tag border"
        style={{ background: '#fceda41a', borderColor: '#fceda44d', color: '#fceda4' }}
      >
        1girl
      </span>
    </div>

    {/* 标签面板模拟 */}
    <div className="w-[420px] max-w-full bg-[#0f0f0f] rounded-lg border border-[#fceda4]/20 overflow-hidden">
      {/* 标题区 */}
      <div className="px-3 py-2 border-b border-white/8 flex items-center justify-between">
        <div>
          <div className="font-tag text-[13px] leading-tight text-[#fceda4]">1girl</div>
          <div className="mt-0.5 text-[10px] text-white/40">少女</div>
        </div>
        <Link2 className="w-3.5 h-3.5 text-[#fceda4]/55" strokeWidth={1.8} />
      </div>

      {/* 关联推荐行 */}
      <div className="px-3 py-2 border-t border-[#fceda4]/8">
        <div className="text-[10px] text-white/40 mb-1.5 flex items-center gap-1">
          <Sparkles className="w-3 h-3 text-[#fceda4]/60" strokeWidth={2} />
          <span>关联推荐 · Danbooru 共现</span>
        </div>
        <div className="flex items-baseline gap-x-3 gap-y-0.5 flex-wrap">
          {[
            { tag: 'long_hair', cn: '长发', strong: true },
            { tag: 'school_uniform', cn: '校服', strong: true },
            { tag: 'solo', cn: '单人', strong: false },
            { tag: 'hair_ribbon', cn: '发带', strong: false },
            { tag: 'looking_at_viewer', cn: '看向画面', strong: false, added: true },
            { tag: 'simple_background', cn: '纯色背景', strong: false },
          ].map((r, i) => (
            <div key={i} className="flex flex-col items-start leading-tight">
              <span
                className={`font-tag text-[12px] ${
                  r.added
                    ? 'text-white/25 line-through'
                    : r.strong
                      ? 'text-[#fceda4]'
                      : 'text-white/80'
                }`}
              >
                {r.tag}
              </span>
              <span
                className={`text-[10px] ${
                  r.added ? 'text-white/15' : r.strong ? 'text-[#fceda4]/55' : 'text-white/40'
                }`}
              >
                {r.cn}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>

    <div className="flex items-center gap-3 text-[10px] text-white/45">
      <span className="flex items-center gap-1">
        <span className="w-2 h-2 rounded-full bg-[#fceda4]" /> 强相关
      </span>
      <span className="flex items-center gap-1">
        <span className="w-2 h-2 rounded-full bg-white/45" /> 普通
      </span>
      <span className="flex items-center gap-1">
        <span className="w-2 h-2 rounded-full bg-white/15" /> 已加入（划掉）
      </span>
    </div>
  </div>
);

// ==================== 预览区：中文推荐命中率提升 ====================
const ChineseHitMock: React.FC = () => {
  const results = [
    { tag: 'long_hair', cn: '长发' },
    { tag: 'school_uniform', cn: '校服' },
    { tag: 'pleated_skirt', cn: '百褶裙' },
    { tag: 'serafuku', cn: '水手服' },
    { tag: 'black_hair', cn: '黑发' },
    { tag: 'hair_ribbon', cn: '发带' },
    { tag: 'kneehighs', cn: '过膝袜' },
    { tag: 'looking_at_viewer', cn: '看向画面' },
  ];

  return (
    <div className="h-full w-full flex flex-col items-center justify-center gap-3 px-4">
      <style>{`
        @keyframes chineseTyping {
          0%, 14% { width: 0; }
          34%, 100% { width: 7em; }
        }
        @keyframes chineseResultIn {
          0%, 42% { opacity: 0; transform: translateY(6px); }
          56%, 100% { opacity: 1; transform: translateY(0); }
        }
        @keyframes chineseCountGlow {
          0%, 42% { color: rgba(255,255,255,0.45); }
          56%, 100% { color: #fceda4; }
        }
      `}</style>

      <div className="w-[430px] max-w-full">
        <div className="px-3 py-2 rounded-md border border-[#fceda4]/30 bg-black/40 flex items-center gap-2">
          <span className="text-[10px] text-white/40 font-mono">输入</span>
          <span
            className="inline-flex items-center font-tag text-[14px] text-white overflow-hidden whitespace-nowrap"
            style={{ animation: 'chineseTyping 4.6s steps(7, end) infinite' }}
          >
            <span>长发校服少女</span>
            <span className="ml-1 inline-block w-px h-4 bg-[#fceda4] animate-pulse" />
          </span>
        </div>
      </div>

      <div className="w-[430px] max-w-full bg-[#0f0f0f] rounded-lg shadow-[0_16px_40px_-10px_rgba(0,0,0,0.85),0_0_0_1px_rgba(252,237,164,0.08)] overflow-hidden">
        <div className="px-3 py-2 border-b border-white/8 flex items-center justify-between">
          <span className="text-[11px] text-[#fceda4]/80">中文语义匹配</span>
          <span className="text-[10px] tabular-nums" style={{ animation: 'chineseCountGlow 4.6s ease-in-out infinite' }}>
            命中 8 条
          </span>
        </div>
        <div className="grid grid-cols-2">
          {results.map((s, i) => (
            <div
              key={s.tag}
              className="px-2.5 py-1.5 flex items-center gap-1.5 border-l-2 border-b border-white/[0.04]"
              style={{
                borderLeftColor: '#fcd34d55',
                animation: 'chineseResultIn 4.6s ease-in-out infinite',
                animationDelay: `${i * 70}ms`,
              }}
            >
              <Tag className="shrink-0 w-3 h-3 text-[#fcd34d]/75" />
              <div className="flex flex-col min-w-0 leading-tight">
                <span className="font-tag text-[11px] text-[#d4d4d4] truncate">{s.tag}</span>
                <span className="text-[9px] text-[#6e7681] truncate">{s.cn}</span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

const ChineseHitMockStatic: React.FC = () => (
  <div className="h-full w-full flex flex-col items-center justify-center gap-3 px-4">
    {/* 输入框模拟 */}
    <div className="w-[420px] max-w-full">
      <div className="px-3 py-2 rounded-md border border-[#fceda4]/30 bg-black/40 flex items-center gap-2">
        <span className="text-[10px] text-white/40 font-mono">输入</span>
        <span className="font-tag text-[14px] text-white">长发校服</span>
        <span className="ml-auto inline-block w-px h-4 bg-[#fceda4] animate-pulse" />
      </div>
    </div>

    {/* 双列对比 */}
    <div className="w-[460px] max-w-full grid grid-cols-2 gap-3">
      {/* 旧版 */}
      <div className="relative bg-[#0f0f0f] rounded-md border border-white/10 overflow-hidden">
        <div className="px-2 py-1 text-[10px] text-white/40 border-b border-white/8 flex items-center justify-between">
          <span>旧版 · 仅 autocomplete</span>
          <span className="text-red-400/60">未命中</span>
        </div>
        <div className="px-2.5 py-3 text-center text-[10px] text-white/30">
          无匹配结果
        </div>
      </div>
      {/* 新版 */}
      <div className="relative bg-[#0f0f0f] rounded-md border border-[#fceda4]/20 overflow-hidden">
        <div className="px-2 py-1 text-[10px] text-[#fceda4]/80 border-b border-[#fceda4]/10 flex items-center justify-between">
          <span>新版 · DanbooruSearch</span>
          <span>命中 4 条</span>
        </div>
        {[
          { tag: 'long_hair', cn: '长发' },
          { tag: 'school_uniform', cn: '校服' },
          { tag: 'pleated_skirt', cn: '百褶裙' },
          { tag: 'serafuku', cn: '水手服' },
        ].map((s, i) => (
          <div
            key={i}
            className="px-2 py-1 flex items-center gap-1.5 border-l-2"
            style={{ borderLeftColor: '#fcd34d55' }}
          >
            <Tag className="shrink-0 w-3 h-3 text-[#fcd34d]/75" />
            <div className="flex flex-col min-w-0 leading-tight">
              <span className="font-tag text-[11px] text-[#d4d4d4] truncate">{s.tag}</span>
              <span className="text-[9px] text-[#6e7681] truncate">{s.cn}</span>
            </div>
          </div>
        ))}
      </div>
    </div>

    <div className="text-[10px] text-white/45 text-center max-w-[420px]">
      Danbooru autocomplete 与 DanbooruSearch HF Space 并行，统一去重合并
    </div>
  </div>
);

// ==================== 预览区：分类独立补全列表 ====================
const SectionedListMock: React.FC = () => {
  const sections = [
    {
      label: '角色',
      Icon: User,
      color: '#7dd3fc',
      delay: '0s',
      visibleRows: 3,
      items: [
        { tag: 'hatsune_miku', cn: '初音未来' },
        { tag: 'hoshino_ai', cn: '星野爱' },
        { tag: 'frieren', cn: '芙莉莲' },
        { tag: 'rem_(re:zero)', cn: '雷姆' },
        { tag: 'asuna_(sao)', cn: '亚丝娜' },
        { tag: 'makima_(chainsaw_man)', cn: '玛奇玛' },
      ],
    },
    {
      label: '标签',
      Icon: Tag,
      color: '#fcd34d',
      delay: '0.8s',
      visibleRows: 5,
      items: [
        { tag: 'long_hair', cn: '长发' },
        { tag: 'cat_ears', cn: '猫耳' },
        { tag: 'simple_background', cn: '纯色背景' },
        { tag: 'looking_at_viewer', cn: '看向画面' },
        { tag: 'school_uniform', cn: '校服' },
        { tag: 'blue_eyes', cn: '蓝眼' },
      ],
    },
  ];

  return (
    <div className="h-full w-full flex items-center justify-center px-4">
      <style>{`
        @keyframes sectionIndependentScroll {
          0%, 28% { transform: translateY(0); }
          46%, 72% { transform: translateY(-72px); }
          90%, 100% { transform: translateY(0); }
        }
        @keyframes sectionScrollbarThumb {
          0%, 28% { transform: translateY(0); opacity: 0.35; }
          46%, 72% { transform: translateY(18px); opacity: 0.85; }
          90%, 100% { transform: translateY(0); opacity: 0.35; }
        }
      `}</style>

      <div className="w-[320px] max-w-full bg-[#0f0f0f] rounded-md border border-[#fceda4]/10 overflow-hidden shadow-[0_16px_40px_-10px_rgba(0,0,0,0.85)]">
        {sections.map(sec => {
          const SecIcon = sec.Icon;
          return (
            <div key={sec.label} className="relative border-b border-white/[0.06] last:border-b-0">
              <div className="relative overflow-hidden" style={{ height: `${sec.visibleRows * 46}px` }}>
                <div
                  className="flex flex-col"
                  style={{ animation: 'sectionIndependentScroll 4.8s ease-in-out infinite', animationDelay: sec.delay }}
                >
                  {[...sec.items, ...sec.items.slice(0, 2)].map((s, i) => (
                    <div
                      key={`${s.tag}-${i}`}
                      className="px-2.5 py-1.5 flex items-center gap-2 border-l-2"
                      style={{ borderLeftColor: `${sec.color}55` }}
                    >
                      <SecIcon className="shrink-0 w-3 h-3" style={{ color: sec.color, opacity: 0.75 }} />
                      <div className="flex flex-col min-w-0 flex-1 leading-tight gap-0.5">
                        <span className="font-tag text-[12px] text-[#d4d4d4] truncate">{s.tag}</span>
                        <span className="text-[9px] text-[#6e7681] truncate">{s.cn}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

const SectionedListMockStatic: React.FC = () => {
  const sections = [
    {
      label: '画师串',
      Icon: Palette,
      color: '#f0abfc',
      items: [
        { tag: 'wlop_style', cn: 'WLOP 风格' },
        { tag: 'mucha_style', cn: '慕夏风格' },
      ],
    },
    {
      label: 'OC',
      Icon: Users,
      color: '#86efac',
      items: [
        { tag: 'lily_oc', cn: '我的莉莉' },
      ],
    },
    {
      label: '角色',
      Icon: User,
      color: '#7dd3fc',
      items: [
        { tag: 'hatsune_miku', cn: '初音未来' },
        { tag: 'hoshino_ai', cn: '星野爱' },
      ],
    },
    {
      label: '标签',
      Icon: Tag,
      color: '#fcd34d',
      items: [
        { tag: 'long_hair', cn: '长发' },
        { tag: 'cat_ears', cn: '猫耳' },
        { tag: 'simple_background', cn: '纯色背景' },
      ],
    },
  ];

  return (
    <div className="h-full w-full flex items-center justify-center px-4">
      <div className="w-[280px] bg-[#0f0f0f] rounded-md border border-[#fceda4]/10 overflow-hidden flex flex-col">
        {sections.map((sec, si) => {
          const SecIcon = sec.Icon;
          return (
            <div key={si} className="flex flex-col">
              {/* 分组分隔 */}
              {si > 0 && <div className="h-px bg-white/8" />}
              {/* 分组头 */}
              <div className="px-2 py-1 flex items-center gap-1.5 bg-white/[0.02]">
                <SecIcon className="w-3 h-3" style={{ color: sec.color }} />
                <span className="text-[10px]" style={{ color: `${sec.color}cc` }}>
                  {sec.label}
                </span>
                <span className="ml-auto text-[9px] text-white/30 tabular-nums">{sec.items.length}/20</span>
              </div>
              {/* 分组内容 */}
              {sec.items.map((s, i) => (
                <div
                  key={i}
                  className="px-2.5 py-1 flex items-center gap-2 border-l-2"
                  style={{ borderLeftColor: `${sec.color}55` }}
                >
                  <SecIcon className="shrink-0 w-3 h-3" style={{ color: sec.color, opacity: 0.75 }} />
                  <div className="flex flex-col min-w-0 flex-1 leading-tight gap-0.5">
                    <span className="font-tag text-[12px] text-[#d4d4d4] truncate">{s.tag}</span>
                    <span className="text-[10px] text-[#6e7681] truncate">{s.cn}</span>
                  </div>
                </div>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
};

// ==================== 预览区：旧入口消失 + 新入口出现 ====================
// 动画时间线 (周期 7s, 真实复刻 LeftSidebar 顶部 + Character Prompts 行布局):
//   0-1.8s   旧布局: 灵感 / 画师管理(Palette) / 预设 + OC管理按钮
//            短暂红色脉动旧入口, 顶部出现红色 "旧入口下线" 提示
//   1.8-3.2s 画师管理 & OC管理 同时淡出 + 缩起 (max-width:0 → 真消失)
//   3.2-4.6s 新 Tags 图标在 Palette 原位置上浮现 (放大回弹 + 金色光晕)
//   4.6-6.4s 新图标 hover tooltip "Tag 管理器" (含上箭头)
//   6.4-7s   循环复位
const TagManagerOverviewMock: React.FC = () => (
  <div className="relative h-full w-full flex items-center justify-center px-4 py-3">
    <style>{`
      /* Palette: 起始可见 → 22-46% 淡出 → 一直不可见 → 94-100% 淡回(下个周期复位) */
      @keyframes tmPaletteFadeOut {
        0%, 22% { opacity: 1; transform: scale(1); }
        46%, 94% { opacity: 0; transform: scale(0.6); }
        100% { opacity: 1; transform: scale(1); }
      }
      /* OC 按钮: 跟 Palette 同节奏, 但需要 max-width 塌缩才能让旁边按钮贴拢 */
      @keyframes tmOldFadeOut {
        0%, 22% { opacity: 1; transform: scale(1); max-width: 100px; margin-left: 6px; }
        28%, 42% { opacity: 0.4; transform: scale(0.85); filter: blur(0.5px); }
        46%, 94% { opacity: 0; transform: scale(0.2); max-width: 0; margin-left: 0; padding-left: 0; padding-right: 0; border-width: 0; }
        100% { opacity: 1; transform: scale(1); max-width: 100px; margin-left: 6px; }
      }
      @keyframes tmOldPulse {
        0%, 8% { box-shadow: inset 0 0 0 1px rgba(248,113,113,0); background-color: transparent; }
        14%, 22% { box-shadow: inset 0 0 0 1.5px rgba(248,113,113,0.7); background-color: rgba(248,113,113,0.1); }
        28%, 100% { box-shadow: none; background-color: transparent; }
      }
      @keyframes tmRedHintIn {
        0%, 6% { opacity: 0; transform: translateY(-2px); }
        12%, 42% { opacity: 1; transform: translateY(0); }
        48%, 100% { opacity: 0; transform: translateY(-2px); }
      }
      /* Tags: 起始不可见 → 46-56% 浮现 → 72-86% 稳定 → 88-94% 淡出 (在 Palette 复位前先消失) */
      @keyframes tmNewIconIn {
        0%, 46% { opacity: 0; transform: scale(0.3); }
        56%, 64% { opacity: 1; transform: scale(1.18); }
        72%, 86% { opacity: 1; transform: scale(1); }
        94%, 100% { opacity: 0; transform: scale(0.3); }
      }
      @keyframes tmNewIconGlow {
        0%, 46%, 100% { box-shadow: 0 0 0 0 rgba(252,237,164,0); }
        54%, 66% { box-shadow: 0 0 0 6px rgba(252,237,164,0.2), 0 0 22px 6px rgba(252,237,164,0.4); }
        74%, 86% { box-shadow: 0 0 0 0 rgba(252,237,164,0); }
      }
      @keyframes tmTooltipIn {
        0%, 66% { opacity: 0; transform: translate(-50%, 6px); }
        72%, 84% { opacity: 1; transform: translate(-50%, 0); }
        90%, 100% { opacity: 0; transform: translate(-50%, 6px); }
      }
    `}</style>

    {/* 两块小片段:仅复刻关键按钮区域 */}
    <div className="flex flex-col items-stretch gap-3 w-[360px]">
      {/* === 片段 1: 提示词面板顶部图标行 === */}
      <div className="bg-nai-panel rounded-lg border border-gray-700/60 px-3 py-2.5 flex items-center gap-2 shadow-[0_8px_24px_-8px_rgba(0,0,0,0.5)]">
        {/* 左侧 提示/排除 Tab pill */}
        <div className="inline-flex items-center gap-0.5 p-0.5 rounded-full bg-nai-input border border-gray-700">
          <span className="inline-flex items-center gap-1 px-2.5 h-6 rounded-full bg-[#fceda4] text-black text-[10px] font-bold">
            <Sparkles className="w-3 h-3" /> 提示
          </span>
          <span className="inline-flex items-center gap-1 px-2.5 h-6 text-[10px] font-bold text-white/55">
            <Ban className="w-3 h-3" />
            排除
          </span>
        </div>

        <div className="flex-1" />

        {/* 灵感 (保留, 紫色渐变) */}
        <div className="w-7 h-7 rounded-lg p-0.5 bg-gradient-to-br from-indigo-500 via-purple-500 to-pink-500 ring-1 ring-white/20 grid place-items-center text-white shadow-sm">
          <Sparkles className="w-3.5 h-3.5" />
        </div>

        {/* 画师管理 (淡出) 与 新 Tags (淡入) 重叠在同一槽位 */}
        <div className="relative w-7 h-7">
          <div
            className="absolute inset-0 grid place-items-center text-gray-400 rounded-md"
            style={{ animation: 'tmPaletteFadeOut 7s ease-in-out infinite, tmOldPulse 7s ease-in-out infinite' }}
          >
            <Palette className="w-5 h-5" />
          </div>
          <div className="absolute inset-0 grid place-items-center">
            <div
              className="w-7 h-7 rounded-md grid place-items-center"
              style={{ animation: 'tmNewIconIn 7s ease-in-out infinite, tmNewIconGlow 7s ease-in-out infinite' }}
            >
              <Tags className="w-5 h-5 text-[#fceda4]" />
            </div>
            <div
              className="pointer-events-none absolute left-1/2 top-full mt-2 -translate-x-1/2 px-2 py-1 rounded bg-black/90 border border-white/15 text-[10px] text-white whitespace-nowrap z-10"
              style={{ animation: 'tmTooltipIn 7s ease-in-out infinite' }}
            >
              Tag 管理器
              <span className="absolute left-1/2 bottom-full -translate-x-1/2 w-0 h-0 border-l-[4px] border-r-[4px] border-b-[5px] border-l-transparent border-r-transparent border-b-black/90" />
            </div>
          </div>
        </div>

        {/* 预设设置 (保留) */}
        <div className="w-7 h-7 grid place-items-center text-gray-400">
          <Settings className="w-5 h-5" />
        </div>
      </div>

      {/* === 片段 2: Character Prompts 按钮行 === */}
      <div className="bg-nai-panel rounded-lg border border-gray-700/60 px-3 py-2.5 flex items-end gap-2 shadow-[0_8px_24px_-8px_rgba(0,0,0,0.5)]">
        <div className="flex-1 min-w-0">
          <div className="text-[11px] font-bold text-white">Character Prompts</div>
          <div className="text-[9px] text-white/40">为角色设置独立提示词</div>
        </div>
        <div
          className="overflow-hidden inline-flex items-center"
          style={{ animation: 'tmOldFadeOut 7s ease-in-out infinite' }}
        >
          <div
            className="inline-flex items-center gap-1 px-2 h-6 rounded text-[10px] font-bold border border-gray-700 bg-nai-input text-white/80 whitespace-nowrap"
            style={{ animation: 'tmOldPulse 7s ease-in-out infinite' }}
          >
            <Users className="w-3 h-3" />
            OC管理
          </div>
        </div>
        <div className="inline-flex items-center gap-1 px-2 h-6 rounded text-[10px] font-bold border border-gray-700 bg-nai-input text-white/80">
          <PlusIcon /> 添加角色
        </div>
      </div>

      {/* === 提示条 === */}
      <div
        className="flex items-center gap-1.5 text-[10px] pl-1"
        style={{ animation: 'tmRedHintIn 7s ease-in-out infinite' }}
      >
        <span className="w-1.5 h-1.5 rounded-full bg-red-400" />
        <span className="text-red-300/85">旧入口下线</span>
        <span className="text-white/35">→ 已合并到「Tag 管理器」</span>
      </div>
    </div>
  </div>
);

const PlusIcon: React.FC = () => (
  <span className="inline-block w-3 text-center leading-none text-[12px]">+</span>
);

// ==================== 幻灯片数据 ====================
const BETA26_SLIDES: FeatureSlide[] = [
  {
    key: 'tagmgr',
    badgeText: 'Tag 管理器',
    Icon: Tags,
    iconColor: '#fceda4',
    title: '角色 / 画风 / 场景，一站管理',
    subtitle: '全新统一 Tag 管理器,替代原画师串与 OC 管理入口,所有 subtype 同一面板切换',
    bullets: [
      '左侧 subtype 侧栏一键切换,各类共享筛选/收藏/最近使用',
      '画风卡片重做为竖向网格,带主题色占位 + 实时预览',
      '收藏的他人作品编辑时自动 fork 为本地副本,可改任意字段',
    ],
    preview: <TagManagerOverviewMock />,
  },
];

const BETA24_SLIDES: FeatureSlide[] = [
  {
    key: 'wiki',
    badgeText: 'Wiki 预览',
    Icon: BookOpen,
    iconColor: '#fceda4',
    title: '补全列表悬停，显示Wiki预览',
    subtitle: '悬停补全项即可弹出 Danbooru Wiki 浮卡，不打断输入节奏',
    bullets: [
      '标题、别名、中文摘要原地渲染',
      '多张示例图自动轮播 + 指示点',
      '一键直达原 Wiki 页面',
    ],
    preview: <WikiPreviewMock />,
  },
  {
    key: 'related',
    badgeText: '关联推荐',
    Icon: Link2,
    iconColor: '#fceda4',
    title: '打开标签面板，获得关联推荐',
    subtitle: '点开任意标签，自动罗列 Danbooru 上最常一起出现的高频组合',
    bullets: [
      '强相关排前（金色高亮），普通靠后',
      '已在提示词的标签灰显划掉，不重复推荐',
      '点击直接追加到当前位置，Shift 键插到末尾',
    ],
    preview: <RelatedTagsMock />,
  },
  {
    key: 'chinese',
    badgeText: '中文命中率',
    Icon: Languages,
    iconColor: '#67e8f9',
    title: '中文匹配增强，命中更多标签',
    subtitle: '接入 DanbooruSearch HF Space 语义搜索，与 autocomplete 互补',
    bullets: [
      '输入「长发」「校服」「百褶裙」直接映射 Danbooru 标签',
      '同义词、词形变化也能识别',
      '与原 autocomplete 并行去重，无延迟感',
    ],
    preview: <ChineseHitMock />,
  },
  {
    key: 'sections',
    badgeText: '分类独立补全',
    Icon: Layers,
    iconColor: '#fceda4',
    title: '分类候选独立滚动，容纳更多标签',
    subtitle: '画师 / OC / 角色 / 标签四类候选独立分组，独立滚动',
    bullets: [
      '每类上限统一提至 20，长列表不再盖过其他来源',
      '彩色侧边色条与图标一目了然',
      '某一组内滚动不影响其他分组的可见项',
    ],
    preview: <SectionedListMock />,
  },
];

// ==================== 按版本聚合幻灯片 ====================
// 新版本只展示自己专属的幻灯片,不带出旧版本的内容
const SLIDES_BY_VERSION: Record<string, FeatureSlide[]> = {
  Beta26: BETA26_SLIDES,
  Beta24: BETA24_SLIDES,
};

/** 当前 changelog 头条版本是否配置了 WhatsNew 导览 */
export const hasWhatsNewForLatest = (): boolean => {
  if (changelog.length === 0) return false;
  return changelog[0].version in SLIDES_BY_VERSION;
};

// ==================== 主组件 ====================
interface WhatsNewModalProps {
  /** 用于外部主动打开（菜单入口）；不传则按未读自动判定 */
  forceOpen?: boolean;
  onClose?: () => void;
}

/** 派发全局事件，请求打开 What's New */
export const openWhatsNew = () => {
  window.dispatchEvent(new CustomEvent('open-whats-new'));
};

/** 当前最新版本是否需要展示 What's New（即 changelog 头条版本配置了导览且未读） */
export const shouldShowWhatsNew = (): boolean => {
  if (!hasWhatsNewForLatest()) return false;
  const latest = changelog[0].version;
  const lastSeen = localStorage.getItem(STORAGE_KEY);
  return lastSeen !== latest;
};

export const WhatsNewModal: React.FC<WhatsNewModalProps> = ({ forceOpen, onClose }) => {
  const [isOpen, setIsOpen] = useState(false);
  const [step, setStep] = useState(0);

  const slides = useMemo<FeatureSlide[]>(() => {
    const latest = changelog[0]?.version;
    return (latest && SLIDES_BY_VERSION[latest]) || [];
  }, []);
  const total = slides.length;
  const current = slides[step];
  const isLast = step === total - 1;

  // 自动判定：仅在最新版本未读时弹
  useEffect(() => {
    if (forceOpen) return;
    if (shouldShowWhatsNew()) {
      setStep(0);
      setIsOpen(true);
    }
  }, [forceOpen]);

  // 外部 forceOpen
  useEffect(() => {
    if (forceOpen) {
      setStep(0);
      setIsOpen(true);
    }
  }, [forceOpen]);

  // 监听全局事件
  useEffect(() => {
    const handler = () => {
      setStep(0);
      setIsOpen(true);
    };
    window.addEventListener('open-whats-new', handler);
    return () => window.removeEventListener('open-whats-new', handler);
  }, []);

  // 键盘左右键 + ESC
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight') {
        e.preventDefault();
        setStep(prev => Math.min(prev + 1, total - 1));
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        setStep(prev => Math.max(prev - 1, 0));
      } else if (e.key === 'Escape') {
        e.preventDefault();
        handleClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, total]);

  const handleClose = () => {
    setIsOpen(false);
    if (changelog.length > 0) {
      // 标记 latest 版本为已读，下次刷新 ChangelogModal 也不再弹
      localStorage.setItem(STORAGE_KEY, changelog[0].version);
    }
    onClose?.();
  };

  const handleNext = () => {
    if (isLast) {
      handleClose();
      return;
    }
    setStep(s => s + 1);
  };

  const handlePrev = () => {
    setStep(s => Math.max(0, s - 1));
  };

  const headerVersion = useMemo(() => changelog[0]?.version ?? '', []);

  if (!isOpen || !current) return null;

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/65 backdrop-blur-sm" onClick={handleClose} />

      <div
        className="relative bg-nai-panel border border-gray-700 rounded-2xl shadow-2xl w-full max-w-2xl max-h-[88vh] flex flex-col overflow-hidden animate-in fade-in zoom-in-95 duration-200"
        onClick={e => e.stopPropagation()}
      >
        {/* 头部：版本徽章 + 当前章节 + 关闭 */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-gray-700/50">
          <div className="flex items-center gap-2 min-w-0">
            <span className="shrink-0 px-2 py-0.5 rounded bg-[#fceda4]/12 border border-[#fceda4]/30 text-[11px] font-mono text-[#fceda4]">
              {headerVersion}
            </span>
          </div>
          <button
            onClick={handleClose}
            className="p-1 rounded-lg text-gray-400 hover:text-white hover:bg-white/8 transition-colors"
            title="关闭（Esc）"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* 中间：预览 + 文案 */}
        <div className="flex-1 overflow-y-auto">
          <div className="px-6 pt-5 pb-3">
            <div className="flex items-center gap-2.5">
              <span className="shrink-0 text-base font-mono font-semibold text-[#fceda4]">
                {step + 1}.
              </span>
              <h3 className="text-base font-semibold text-white leading-tight">{current.title}</h3>
            </div>
          </div>
          {/* 预览舞台 */}
          <div className="relative h-[300px] bg-black/40 border-t border-white/5 overflow-hidden">
            {/* 子弹背景：底色色块（纯色 + 透明度）*/}
            <div
              className="absolute inset-0"
              style={{ background: `${current.iconColor}0a` }}
              aria-hidden
            />
            <div
              key={current.key}
              className="relative h-full w-full animate-in fade-in slide-in-from-bottom-2 duration-300"
            >
              {current.preview}
            </div>
          </div>

          {/* 文案区 */}
        </div>

        {/* 底部：进度点 + 上一页/下一页 */}
        <div className="px-5 py-3 border-t border-gray-700/50 flex items-center gap-3">
          {/* 进度点 */}
          <div className="flex items-center gap-1.5">
            {slides.map((s, i) => {
              const active = i === step;
              return (
                <button
                  key={s.key}
                  onClick={() => setStep(i)}
                  className={`h-1.5 rounded-full transition-all duration-200 ${
                    active ? 'w-5 bg-[#fceda4]' : 'w-1.5 bg-white/25 hover:bg-white/40'
                  }`}
                  title={s.badgeText}
                />
              );
            })}
            <span className="ml-2 text-[10px] text-white/35 tabular-nums">
              {step + 1} / {total}
            </span>
          </div>

          {/* 操作按钮 */}
          <div className="ml-auto flex items-center gap-2">
            <button
              onClick={handlePrev}
              disabled={step === 0}
              className={`h-8 px-3 rounded-md text-[12px] inline-flex items-center gap-1 transition-colors ${
                step === 0
                  ? 'text-white/25 cursor-not-allowed'
                  : 'text-white/70 hover:text-white hover:bg-white/8'
              }`}
            >
              <ChevronLeft className="w-3.5 h-3.5" strokeWidth={2.5} />
              上一页
            </button>
            <button
              onClick={handleNext}
              className="h-8 px-4 rounded-md bg-nai-accent text-black text-[12px] font-semibold hover:bg-nai-accent/90 transition-colors inline-flex items-center gap-1"
            >
              {isLast ? '完成' : '下一页'}
              {!isLast && <ChevronRight className="w-3.5 h-3.5" strokeWidth={2.5} />}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
