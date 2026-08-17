#!/usr/bin/env node
// 图库视图对等校验(P5):直接加载纯逻辑层 galleryViewLogic.ts(无 React/DOM,
// node --experimental-strip-types 可直接加载),断言日期分组、筛选谓词、勾选收敛、
// 页码换算与预取窗口的纯逻辑;并对快照复跑装配层与图库相关组件做结构断言。
//
// 运行: node --experimental-strip-types scripts/check-gallery-parity.mjs
// (node >= 23.6 默认启用 type stripping,显式 flag 亦兼容)
//
// 校验内容:
//   1. dateGroupLabel 今天/昨天/同年/跨年边界;groupHistoryByDate 分组顺序与计数;
//      formatSectionTime 补零
//   2. matchesGalleryFilter:query(seed 子串/prompt 大小写/模型名)、models 含未知桶、
//      timeRange 各档边界、模型∧时间∧query 全 AND
//   3. convergeSelectionIds 丢弃不可见项,无变化时内容不变
//   4. prefetchWindowIndexes 边界;galleryPageCount/historyIndexToPage/pageToHistoryIndex
//      有无 live task 两态
//   5. distinctModelKeys 排序 + 未知桶最后
//   6. buildSnapshotRegenerateParams:无 metadata 返回 null、seed 置空、字段透传、
//      禁用角色提示词滤掉、超尺寸 clamp 到 MAX_TOTAL_PIXELS 内
//   7. 结构断言(文本扫描):sheet 无 deleteHistoryItem、收敛/时刻徽标接线、
//      图库展示组件不碰 revokeObjectURL

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const {
  UNKNOWN_MODEL_KEY,
  EMPTY_GALLERY_FILTER,
  dateGroupLabel,
  groupHistoryByDate,
  formatSectionTime,
  isGalleryFilterActive,
  modelKeyOf,
  matchesGalleryFilter,
  filterHistory,
  distinctModelKeys,
  convergeSelectionIds,
  prefetchWindowIndexes,
  galleryPageCount,
  historyIndexToPage,
  pageToHistoryIndex,
} = await import('../src/components/mobile/gallery/galleryViewLogic.ts');
const { buildSnapshotRegenerateParams } = await import('../src/components/generation/snapshotRegenerate.ts');
const { MAX_TOTAL_PIXELS } = await import('../src/components/generation/modelResolutionOptions.ts');

let checks = 0;
const check = (name, fn) => {
  checks += 1;
  try {
    fn();
    console.log(`ok ${checks} - ${name}`);
  } catch (error) {
    console.error(`not ok ${checks} - ${name}`);
    throw error;
  }
};

// 本地时间构造(月份 1-based);测试全部用显式 now,避免跨日漂移
const at = (year, month, day, hour = 12, minute = 0) =>
  new Date(year, month - 1, day, hour, minute).getTime();

const NOW = at(2026, 8, 17, 15, 30);

let seq = 0;
const makeItem = (over = {}) => {
  seq += 1;
  return {
    id: `img-${seq}`,
    imageUrl: `blob:img-${seq}`,
    seed: 1000 + seq,
    timestamp: NOW,
    width: 832,
    height: 1216,
    ...over,
  };
};

const fullMeta = (over = {}) => ({
  positivePrompt: 'Masterpiece, 1GIRL, solo',
  negativePrompt: 'Lowres, bad anatomy',
  model: 'nai-diffusion-4-5-full',
  steps: 28,
  scale: 5,
  sampler: 'k_euler',
  cfgRescale: 0.3,
  noiseSchedule: 'karras',
  ucPreset: 'heavy',
  qualityToggle: true,
  varietyPlus: false,
  ...over,
});
const metaItem = (itemOver = {}, metaOver = {}) =>
  makeItem({ ...itemOver, metadata: fullMeta(metaOver) });

// ---- 1. 日期分组 ----
check('dateGroupLabel: 今天/昨天边界(按日历日,不看时刻)', () => {
  assert.equal(dateGroupLabel(at(2026, 8, 17, 0, 0), NOW), '今天');
  assert.equal(dateGroupLabel(at(2026, 8, 17, 23, 59), NOW), '今天');
  assert.equal(dateGroupLabel(at(2026, 8, 16, 0, 0), NOW), '昨天');
  assert.equal(dateGroupLabel(at(2026, 8, 16, 23, 59), NOW), '昨天');
});

check('dateGroupLabel: 同年 M月d日 / 跨年 YYYY年M月d日', () => {
  assert.equal(dateGroupLabel(at(2026, 1, 1), NOW), '1月1日');
  assert.equal(dateGroupLabel(at(2026, 3, 5), NOW), '3月5日');
  assert.equal(dateGroupLabel(at(2025, 12, 31), NOW), '2025年12月31日');
  assert.equal(dateGroupLabel(at(2024, 2, 29), NOW), '2024年2月29日');
});

check('groupHistoryByDate: 分组顺序 = 组内首图出现序(新的在前),计数正确', () => {
  const items = [
    makeItem({ timestamp: at(2026, 8, 17, 9) }),
    makeItem({ timestamp: at(2026, 8, 17, 8) }),
    makeItem({ timestamp: at(2026, 8, 16, 23) }),
    makeItem({ timestamp: at(2026, 8, 3, 12) }),
    makeItem({ timestamp: at(2026, 8, 3, 11) }),
    makeItem({ timestamp: at(2025, 12, 31, 12) }),
  ];
  const groups = groupHistoryByDate(items, NOW);
  assert.deepEqual(groups.map((g) => g.label), ['今天', '昨天', '8月3日', '2025年12月31日']);
  assert.deepEqual(groups.map((g) => g.items.length), [2, 1, 2, 1]);
  assert.equal(new Set(groups.map((g) => g.key)).size, 4); // 同日同 key
});

check('groupHistoryByDate: 空列表 → 空分组', () => {
  assert.deepEqual(groupHistoryByDate([], NOW), []);
});

check('formatSectionTime: HH:mm 补零', () => {
  assert.equal(formatSectionTime(at(2026, 8, 17, 9, 5)), '09:05');
  assert.equal(formatSectionTime(at(2026, 8, 17, 0, 0)), '00:00');
  assert.equal(formatSectionTime(at(2026, 8, 17, 16, 45)), '16:45');
  assert.equal(formatSectionTime(at(2026, 8, 17, 23, 59)), '23:59');
});

// ---- 2. 筛选谓词 ----
check('matchesGalleryFilter: query 命中 seed 子串', () => {
  const item = makeItem({ seed: 123456789 });
  assert.equal(matchesGalleryFilter(item, { ...EMPTY_GALLERY_FILTER, query: '3456' }, NOW), true);
  assert.equal(matchesGalleryFilter(item, { ...EMPTY_GALLERY_FILTER, query: '987' }, NOW), false);
});

check('matchesGalleryFilter: query 大小写不敏感,命中正/负面提示词', () => {
  const item = metaItem();
  assert.equal(matchesGalleryFilter(item, { ...EMPTY_GALLERY_FILTER, query: '1girl' }, NOW), true);
  assert.equal(matchesGalleryFilter(item, { ...EMPTY_GALLERY_FILTER, query: 'MASTERPIECE' }, NOW), true);
  assert.equal(matchesGalleryFilter(item, { ...EMPTY_GALLERY_FILTER, query: 'LOWRES' }, NOW), true);
  assert.equal(matchesGalleryFilter(item, { ...EMPTY_GALLERY_FILTER, query: 'scenery' }, NOW), false);
});

check('matchesGalleryFilter: query 命中模型名;纯空白 query 不限', () => {
  const item = metaItem();
  assert.equal(matchesGalleryFilter(item, { ...EMPTY_GALLERY_FILTER, query: 'diffusion-4-5' }, NOW), true);
  assert.equal(matchesGalleryFilter(item, { ...EMPTY_GALLERY_FILTER, query: '   ' }, NOW), true);
});

check('matchesGalleryFilter: models 集合;无元数据归 UNKNOWN_MODEL_KEY 桶', () => {
  const known = metaItem();
  const legacy = makeItem(); // 无 metadata 的老图/导入图
  assert.equal(modelKeyOf(legacy), UNKNOWN_MODEL_KEY);
  assert.equal(matchesGalleryFilter(legacy, { ...EMPTY_GALLERY_FILTER, models: [UNKNOWN_MODEL_KEY] }, NOW), true);
  assert.equal(matchesGalleryFilter(known, { ...EMPTY_GALLERY_FILTER, models: [UNKNOWN_MODEL_KEY] }, NOW), false);
  assert.equal(matchesGalleryFilter(known, { ...EMPTY_GALLERY_FILTER, models: ['nai-diffusion-4-5-full'] }, NOW), true);
  assert.equal(matchesGalleryFilter(legacy, { ...EMPTY_GALLERY_FILTER, models: ['nai-diffusion-4-5-full'] }, NOW), false);
  assert.equal(matchesGalleryFilter(legacy, EMPTY_GALLERY_FILTER, NOW), true); // 空数组 = 不限
});

check('matchesGalleryFilter: timeRange=today 仅 diff=0', () => {
  const filter = { ...EMPTY_GALLERY_FILTER, timeRange: 'today' };
  assert.equal(matchesGalleryFilter(makeItem({ timestamp: at(2026, 8, 17, 0, 1) }), filter, NOW), true);
  assert.equal(matchesGalleryFilter(makeItem({ timestamp: at(2026, 8, 16, 23, 59) }), filter, NOW), false);
});

check('matchesGalleryFilter: timeRange=yesterday 仅 diff=1', () => {
  const filter = { ...EMPTY_GALLERY_FILTER, timeRange: 'yesterday' };
  assert.equal(matchesGalleryFilter(makeItem({ timestamp: at(2026, 8, 16, 12) }), filter, NOW), true);
  assert.equal(matchesGalleryFilter(makeItem({ timestamp: at(2026, 8, 17, 12) }), filter, NOW), false);
  assert.equal(matchesGalleryFilter(makeItem({ timestamp: at(2026, 8, 15, 12) }), filter, NOW), false);
});

check('matchesGalleryFilter: timeRange=last7d 覆盖 diff 0..6', () => {
  const filter = { ...EMPTY_GALLERY_FILTER, timeRange: 'last7d' };
  assert.equal(matchesGalleryFilter(makeItem({ timestamp: at(2026, 8, 17, 12) }), filter, NOW), true);
  assert.equal(matchesGalleryFilter(makeItem({ timestamp: at(2026, 8, 11, 12) }), filter, NOW), true);
  assert.equal(matchesGalleryFilter(makeItem({ timestamp: at(2026, 8, 10, 12) }), filter, NOW), false);
});

check('matchesGalleryFilter: timeRange=last30d 覆盖 diff 0..29', () => {
  const filter = { ...EMPTY_GALLERY_FILTER, timeRange: 'last30d' };
  assert.equal(matchesGalleryFilter(makeItem({ timestamp: at(2026, 8, 17, 12) }), filter, NOW), true);
  assert.equal(matchesGalleryFilter(makeItem({ timestamp: at(2026, 7, 19, 12) }), filter, NOW), true);
  assert.equal(matchesGalleryFilter(makeItem({ timestamp: at(2026, 7, 18, 12) }), filter, NOW), false);
});

check('matchesGalleryFilter: 模型∧时间∧query 全 AND,任一不满足即排除', () => {
  const item = metaItem({ timestamp: at(2026, 8, 16, 10) });
  const base = { query: '1girl', models: ['nai-diffusion-4-5-full'], timeRange: 'yesterday' };
  assert.equal(matchesGalleryFilter(item, base, NOW), true);
  assert.equal(matchesGalleryFilter(item, { ...base, query: 'scenery' }, NOW), false);
  assert.equal(matchesGalleryFilter(item, { ...base, models: ['nai-diffusion-3'] }, NOW), false);
  assert.equal(matchesGalleryFilter(item, { ...base, timeRange: 'today' }, NOW), false);
});

check('filterHistory: 逐成员应用 matchesGalleryFilter', () => {
  const items = [metaItem(), makeItem()];
  const out = filterHistory(items, { ...EMPTY_GALLERY_FILTER, models: [UNKNOWN_MODEL_KEY] }, NOW);
  assert.deepEqual(out.map((i) => i.id), [items[1].id]);
});

check('isGalleryFilterActive: 空筛选不激活;query/models/timeRange 任一即激活', () => {
  assert.equal(isGalleryFilterActive(EMPTY_GALLERY_FILTER), false);
  assert.equal(isGalleryFilterActive({ ...EMPTY_GALLERY_FILTER, query: '  ' }), false); // 空白不激活
  assert.equal(isGalleryFilterActive({ ...EMPTY_GALLERY_FILTER, query: 'x' }), true);
  assert.equal(isGalleryFilterActive({ ...EMPTY_GALLERY_FILTER, models: [UNKNOWN_MODEL_KEY] }), true);
  assert.equal(isGalleryFilterActive({ ...EMPTY_GALLERY_FILTER, timeRange: 'last7d' }), true);
});

// ---- 3. 勾选收敛 ----
check('convergeSelectionIds: 丢弃不可见项', () => {
  const next = convergeSelectionIds(new Set(['a', 'b', 'c']), new Set(['a', 'c', 'd']));
  assert.deepEqual([...next].sort(), ['a', 'c']);
});

check('convergeSelectionIds: 无变化时内容不变(返回原集合的拷贝)', () => {
  const selected = new Set(['a', 'c']);
  const next = convergeSelectionIds(selected, new Set(['a', 'c', 'd']));
  assert.deepEqual([...next].sort(), ['a', 'c']);
  assert.notEqual(next, selected); // 拷贝语义:调用方须自行做前置判断避免死循环
});

check('convergeSelectionIds: 全部筛光 → 空集', () => {
  assert.equal(convergeSelectionIds(new Set(['a']), new Set(['b'])).size, 0);
});

// ---- 4. 页码换算与预取窗口 ----
check('prefetchWindowIndexes: 首/末边界与 radius>1', () => {
  assert.deepEqual(prefetchWindowIndexes(10, 0), [1]); // 最新在左,左邻越界
  assert.deepEqual(prefetchWindowIndexes(10, 9), [8]); // 末尾右邻越界
  assert.deepEqual(prefetchWindowIndexes(10, 4, 2), [3, 5, 2, 6]);
  assert.deepEqual(prefetchWindowIndexes(1, 0), []);
  assert.deepEqual(prefetchWindowIndexes(3, 0, 2), [1, 2]);
});

check('页码换算: 无 live task 时页 = history 下标', () => {
  assert.equal(galleryPageCount(5, false), 5);
  assert.equal(historyIndexToPage(2, false), 2);
  assert.equal(pageToHistoryIndex(0, false), 0);
  assert.equal(pageToHistoryIndex(4, false), 4);
});

check('页码换算: live task 占第 0 页,history 顺移;落在任务卡返回 null', () => {
  assert.equal(galleryPageCount(5, true), 6);
  assert.equal(historyIndexToPage(0, true), 1);
  assert.equal(pageToHistoryIndex(0, true), null);
  assert.equal(pageToHistoryIndex(1, true), 0);
  assert.equal(pageToHistoryIndex(5, true), 4);
});

// ---- 5. 模型选项 ----
check('distinctModelKeys: 去重排序,未知桶固定最后', () => {
  const items = [
    metaItem({}, { model: 'nai-diffusion-4-5-full' }),
    makeItem(),
    metaItem({}, { model: 'nai-diffusion-3' }),
    metaItem({}, { model: 'nai-diffusion-3' }),
  ];
  assert.deepEqual(distinctModelKeys(items), ['nai-diffusion-3', 'nai-diffusion-4-5-full', UNKNOWN_MODEL_KEY]);
});

// ---- 6. 快照复跑装配 ----
check('buildSnapshotRegenerateParams: 无 metadata 返回 null', () => {
  assert.equal(buildSnapshotRegenerateParams(makeItem()), null);
});

check('buildSnapshotRegenerateParams: 字段透传,seed 置 undefined(由生成链路摇新)', () => {
  const item = metaItem({ seed: 42 });
  const params = buildSnapshotRegenerateParams(item);
  assert.equal(params.positivePrompt, 'Masterpiece, 1GIRL, solo');
  assert.equal(params.negativePrompt, 'Lowres, bad anatomy');
  assert.equal(params.model, 'nai-diffusion-4-5-full');
  assert.equal(params.width, 832);
  assert.equal(params.height, 1216);
  assert.equal(params.steps, 28);
  assert.equal(params.scale, 5);
  assert.equal(params.sampler, 'k_euler');
  assert.equal(params.cfgRescale, 0.3);
  assert.equal(params.noiseSchedule, 'karras');
  assert.equal(params.ucPreset, 'heavy');
  assert.equal(params.qualityToggle, true);
  assert.equal(params.varietyPlus, false);
  assert.equal(params.seed, undefined);
});

check('buildSnapshotRegenerateParams: 禁用角色提示词被滤掉', () => {
  const item = metaItem({}, {
    characterPrompts: [
      { positive: 'kept', negative: 'n1', enabled: true },
      { positive: 'dropped', negative: 'n2', enabled: false },
    ],
  });
  const params = buildSnapshotRegenerateParams(item);
  assert.equal(params.characterPrompts.length, 1);
  assert.equal(params.characterPrompts[0].positive, 'kept');
});

check('buildSnapshotRegenerateParams: 超尺寸快照被 clamp 到 MAX_TOTAL_PIXELS 内', () => {
  const item = metaItem({ width: 2048, height: 2048 });
  const params = buildSnapshotRegenerateParams(item);
  assert.ok(params.width * params.height <= MAX_TOTAL_PIXELS);
  assert.ok(params.width < 2048 || params.height < 2048);
  assert.equal(params.width % 64, 0);
  assert.equal(params.height % 64, 0);
  assert.ok(params.resolutionSource.includes('2048×2048')); // 原图尺寸留痕
});

// ---- 7. 结构断言(文本扫描) ----
const readSrc = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');

check('结构: MobileExpandedGallerySheet 移除单张删除入口,接入收敛与时刻徽标', () => {
  const src = readSrc('../src/components/mobile/MobileExpandedGallerySheet.tsx');
  assert.equal(src.includes('deleteHistoryItem'), false);
  assert.ok(src.includes('convergeSelection'));
  assert.ok(src.includes('formatSectionTime'));
});

check('结构: useMobileGallerySelection 提供 enterSelectionWith 与 convergeSelection', () => {
  const src = readSrc('../src/components/mobile/gallery/useMobileGallerySelection.ts');
  assert.ok(src.includes('enterSelectionWith'));
  assert.ok(src.includes('convergeSelection'));
});

check('结构: useMobileGenerateRunner 经快照复跑参数 + CustomEvent 接入图库重生成', () => {
  const src = readSrc('../src/components/mobile/generate/useMobileGenerateRunner.ts');
  assert.ok(src.includes('buildSnapshotRegenerateParams'));
  assert.ok(src.includes('CustomEvent'));
});

check('结构: 图库展示组件不碰 revokeObjectURL(对象 URL 生命周期只归 GenerationContext)', () => {
  for (const rel of [
    '../src/components/mobile/MobileImagePage.tsx',
    '../src/components/mobile/gallery/MobileCompactGalleryStrip.tsx',
    '../src/components/mobile/gallery/MobileCurrentImageToolbar.tsx',
    '../src/components/mobile/MobileExpandedGallerySheet.tsx',
    '../src/components/mobile/MobileFullscreenImageViewer.tsx',
  ]) {
    assert.equal(readSrc(rel).includes('revokeObjectURL'), false, rel);
  }
});

console.log(`\n${checks} 项图库视图对等校验全部通过。`);
