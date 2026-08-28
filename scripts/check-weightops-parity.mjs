#!/usr/bin/env node
// 加权操作对等校验(P8):直接加载纯逻辑层 promptWeightOps.ts(无 React/DOM,
// node --experimental-strip-types 可直接加载),断言 chip 编辑器双端共享的加权操作
// 纯函数语义;并对迁移后的三个 hook 文件与 prompt-editor 边界做结构断言。
//
// 运行: node --experimental-strip-types scripts/check-weightops-parity.mjs
// (node >= 23.6 默认启用 type stripping,显式 flag 亦兼容)
//
// 等价性锚点说明:各用例的期望输出均从抽取前两端原实现逐行推导,注释标注原行号:
//   M = src/components/mobile/fullscreen-editor/useFullscreenTagActions.ts 抽取前
//   D = src/components/desktop-chip-editor/useDesktopTagActions.ts 抽取前(useDesktopTagActions)
//   P = 同文件抽取前 useDesktopPanelActions
//
// 校验内容:
//   1. groupContinuousIndices 连段分组(原 M20-33,桌面三处内联)
//   2. resolveTargetIndices 选区→组展开(原 M43-53 / D46-56 / P193-200)
//   3. applyBrace/applyBracket 各标签形态与跳选(原 M56-77 / D59-98 / P203-244)
//   4. applyNumericWeight 单标签/连续段/跳选(原 M78-101 / D99-123 / P253-266)
//   5. clearWeights 组连带清除(原 M102-119 / D124-139 / P245-252)
//   6. convertSDWeights SD→NAI(原 M120-130 / D140-148 / P267-273)
//   7. toggleHidden ~隐藏~ 切换与锚点(原 M138-149 / D155-167 / P290-302)
//   8. 管线级等价锚点:两端「下标解析 + 纯操作」组合输出一致;toggleHide 端差异保留
//   9. 不可变性:所有纯函数不改入参数组
//  10. 结构断言(文本扫描):三 hook import 共享模块、无私有副本残留、
//      promptWeightOps 无 react/外部内部依赖、prompt-editor 不 import promptWeightOps
//  11. 权重语法防雷(P7):detectAbnormalWeight 名字尾数字判据(词字符+数字紧贴 ::,
//      含中日文词字符、个位数命中、合法权重前缀豁免)与 ≥10 旧信号合并、建议写法存在

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const { analyzeTagGroups, detectAbnormalWeight, formatAbnormalWeightTip } = await import('../src/utils/promptTags.ts');
const {
  resolveTargetIndices,
  groupContinuousIndices,
  applyBrace,
  applyBracket,
  applyNumericWeight,
  clearWeights,
  convertSDWeights,
  toggleHidden,
} = await import('../src/utils/promptWeightOps.ts');

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

// ---- 1. 连段分组 ----
check('groupContinuousIndices: 连段/跳选/单点/空(原 M20-33)', () => {
  assert.deepEqual(groupContinuousIndices([0, 1, 2]), [[0, 1, 2]]);
  assert.deepEqual(groupContinuousIndices([0, 1, 3, 5, 6]), [[0, 1], [3], [5, 6]]);
  assert.deepEqual(groupContinuousIndices([2]), [[2]]);
  assert.deepEqual(groupContinuousIndices([]), []); // 原实现调用方均守卫空选区,共享版防御性返回 []
});

// ---- 2. 选区 → 目标下标 ----
check('resolveTargetIndices: 空选区/多选排序不展开/单选非组原样(原 M43-53 / D46-56)', () => {
  const groups = analyzeTagGroups(['{a', 'b', 'c}', 'd']);
  assert.deepEqual(resolveTargetIndices(new Set(), groups), []);
  assert.deepEqual(resolveTargetIndices([2, 0], groups), [0, 2]); // 多选即使落组也不展开
  assert.deepEqual(resolveTargetIndices(new Set([3]), groups), [3]);
});

check('resolveTargetIndices: 单选落在 {} 组/数值组上 → 展开为全组下标(原 M47-51 / D49-53 / P195-198)', () => {
  const braceGroups = analyzeTagGroups(['{a', 'b', 'c}', 'd']);
  assert.deepEqual(resolveTargetIndices([1], braceGroups), [0, 1, 2]);
  assert.deepEqual(resolveTargetIndices([0], braceGroups), [0, 1, 2]);
  const numericGroups = analyzeTagGroups(['1.2::a', 'b', 'c::']);
  assert.deepEqual(resolveTargetIndices(new Set([2]), numericGroups), [0, 1, 2]);
  // 桌面面板 getGroupIndices 等价形式:单下标数组走同一条展开路径
  assert.deepEqual(resolveTargetIndices([3], braceGroups), [3]);
});

// ---- 3. 加 {} / 加 [] ----
check('applyBrace: 单标签/连续段/跳选分段(原 M56-66 / D59-78 / P203-223)', () => {
  assert.deepEqual(applyBrace(['tag'], [0]), ['{tag}']);
  assert.deepEqual(applyBrace(['a', 'b', 'c'], [0, 1, 2]), ['{a', 'b', 'c}']);
  assert.deepEqual(applyBrace(['a', 'b', 'c', 'd'], [0, 1, 3]), ['{a', 'b}', 'c', '{d}']);
});

check('applyBrace: (tag)/{tag}/[[tag]]/(tag:1.2) 各形态直接首尾包裹(原实现不做语义识别)', () => {
  assert.deepEqual(applyBrace(['(tag)'], [0]), ['{(tag)}']);
  assert.deepEqual(applyBrace(['{tag}'], [0]), ['{{tag}}']);
  assert.deepEqual(applyBrace(['[[tag]]'], [0]), ['{[[tag]]}']);
  assert.deepEqual(applyBrace(['(tag:1.2)'], [0]), ['{(tag:1.2)}']);
});

check('applyBracket: 单标签/连续段/各形态(原 M67-77 / D79-98 / P224-244)', () => {
  assert.deepEqual(applyBracket(['tag'], [0]), ['[tag]']);
  assert.deepEqual(applyBracket(['a', 'b'], [0, 1]), ['[a', 'b]']);
  assert.deepEqual(applyBracket(['{tag}'], [0]), ['[{tag}]']);
  assert.deepEqual(applyBracket(['(tag)'], [0]), ['[(tag)]']);
  assert.deepEqual(applyBracket(['(tag:1.2)'], [0]), ['[(tag:1.2)]']);
});

// ---- 4. 数值权重 ----
check('applyNumericWeight: 单标签 w::tag:: 空格转下划线(原 M82-85 / D113-115 / P257-258)', () => {
  assert.deepEqual(applyNumericWeight(['tag a'], [0], 1.2), ['1.2::tag_a::']);
  assert.deepEqual(applyNumericWeight(['{tag}'], [0], 1.2), ['1.2::tag::']);
  assert.deepEqual(applyNumericWeight(['[[tag]]'], [0], 1.2), ['1.2::tag::']);
  assert.deepEqual(applyNumericWeight(['1.2::tag::'], [0], 1.5), ['1.5::tag::']);
  // cleanTagName 不剥圆括号,SD 形态原样进入权重语法(既有行为锚点)
  assert.deepEqual(applyNumericWeight(['(tag:1.2)'], [0], 1.5), ['1.5::(tag:1.2)::']);
  assert.deepEqual(applyNumericWeight(['(tag)'], [0], 0.8), ['0.8::(tag)::']);
  // 隐藏标签被数值设定时 ~ 一并清洗(原 cleanTagName 行为)
  assert.deepEqual(applyNumericWeight(['~tag'], [0], 1.2), ['1.2::tag::']);
});

check('applyNumericWeight: 连续段清洗后首加 w:: 尾加 ::;跳选按段各自处理(原 M86-98 / D113-121)', () => {
  assert.deepEqual(applyNumericWeight(['a', 'b', 'c'], [0, 1, 2], 1.5), ['1.5::a', 'b', 'c::']);
  assert.deepEqual(applyNumericWeight(['a', 'b', 'c', 'd'], [0, 2, 3], 0.8), ['0.8::a::', 'b', '0.8::c', 'd::']);
  assert.deepEqual(applyNumericWeight(['{a', 'b}'], [0, 1], 1.3), ['1.3::a', 'b::']);
});

// ---- 5. 清除权重 ----
check('clearWeights: 各形态清洗为纯标签名(原 M115-117 / D137 / P249)', () => {
  assert.deepEqual(clearWeights(['{tag}'], [0]), ['tag']);
  assert.deepEqual(clearWeights(['[[tag]]'], [0]), ['tag']);
  assert.deepEqual(clearWeights(['1.2::tag::'], [0]), ['tag']);
  // cleanTagName 不剥圆括号(既有行为锚点)
  assert.deepEqual(clearWeights(['(tag:1.2)'], [0]), ['(tag:1.2)']);
  assert.deepEqual(clearWeights(['(tag)'], [0]), ['(tag)']);
  assert.deepEqual(clearWeights(['~tag'], [0]), ['tag']);
});

check('clearWeights: 下标落组 → 连带全组清洗;缺省 groups 不展开(原 M106-114 / D128-136 / P248)', () => {
  const numericGroups = analyzeTagGroups(['1.2::a', 'b', 'c::']);
  assert.deepEqual(clearWeights(['1.2::a', 'b', 'c::'], [1], numericGroups), ['a', 'b', 'c']);
  const braceGroups = analyzeTagGroups(['{a', 'b}']);
  assert.deepEqual(clearWeights(['{a', 'b}'], [0], braceGroups), ['a', 'b']);
  // 桌面面板语义:下标已经组展开,不再连带(原 P245-252 无展开循环)
  assert.deepEqual(clearWeights(['1.2::a', 'b', 'c::'], [1]), ['1.2::a', 'b', 'c::']);
});

// ---- 6. SD → NAI ----
check('convertSDWeights: (tag)/(tag:w) 各形态转换,非 SD 原样(原 M124-128 / D144-146 / P270)', () => {
  assert.deepEqual(convertSDWeights(['(tag)'], [0]), ['{tag}']);
  assert.deepEqual(convertSDWeights(['(tag:1.2)'], [0]), ['1.2::tag::']);
  assert.deepEqual(convertSDWeights(['(tag:1.0)'], [0]), ['tag']);
  assert.deepEqual(convertSDWeights(['(my tag:1.2)'], [0]), ['1.2::my_tag::']);
  assert.deepEqual(convertSDWeights(['{tag}'], [0]), ['{tag}']);
  assert.deepEqual(convertSDWeights(['[[tag]]'], [0]), ['[[tag]]']);
  assert.deepEqual(convertSDWeights(['tag'], [0]), ['tag']);
  // 桌面面板无守卫直接 convertSDToNAI(原 P270):非 SD 输入原样返回,与守卫版等价
  assert.deepEqual(convertSDWeights(['1.2::tag::'], [0]), ['1.2::tag::']);
});

// ---- 7. ~隐藏~ 切换 ----
check('toggleHidden: 加 ~/去 ~,保留前导空白(原 M142-146 / D159-163 / P294-298)', () => {
  assert.deepEqual(toggleHidden(['tag'], [0]), ['~tag']);
  assert.deepEqual(toggleHidden(['~tag'], [0]), ['tag']);
  assert.deepEqual(toggleHidden(['  tag'], [0]), ['  ~tag']);
  assert.deepEqual(toggleHidden(['  ~tag'], [0]), ['  tag']);
});

check('toggleHidden: 隐藏状态锚定首下标,全选区统一加或去(原 M142 / D159)', () => {
  assert.deepEqual(toggleHidden(['~a', 'b'], [0, 1]), ['a', 'b']);
  // 首下标非隐藏 → 全员加 ~(已隐藏的会叠成双 ~,既有行为锚点)
  assert.deepEqual(toggleHidden(['a', '~b'], [0, 1]), ['~a', '~~b']);
});

check('toggleHidden: anchorIndex 显式锚点(桌面面板语义,锚 tagPanel.index 而非组首,原 P294)', () => {
  assert.deepEqual(toggleHidden(['a', '~b'], [0, 1], 1), ['a', 'b']);
  assert.deepEqual(toggleHidden(['~a', 'b'], [0, 1], 1), ['~~a', '~b']);
});

// ---- 8. 管线级等价锚点(下标解析 + 纯操作,复刻两端原调用序列) ----
check('管线: 移动端单选组内标签 addBrace → 全组包裹(原 M43-66)', () => {
  const tags = ['x', '{a', 'b', 'c}', 'y'];
  const groups = analyzeTagGroups(tags);
  const indices = resolveTargetIndices(new Set([2]), groups);
  assert.deepEqual(indices, [1, 2, 3]);
  assert.deepEqual(applyBrace(tags, indices), ['x', '{{a', 'b', 'c}}', 'y']);
});

check('管线: 桌面面板数值组中段 setNumericWeight → 整组重设(原 P193-200 + P253-266)', () => {
  const tags = ['1.2::a', 'b::', 'z'];
  const groups = analyzeTagGroups(tags);
  const indices = resolveTargetIndices([1], groups);
  assert.deepEqual(indices, [0, 1]);
  assert.deepEqual(applyNumericWeight(tags, indices, 1.4), ['1.4::a', 'b::', 'z']);
});

check('管线: toggleHide 端差异保留 —— 桌面多选不展开 vs 移动端单选组展开(原 D155-167 vs M138-149)', () => {
  const tags = ['{a', 'b}'];
  const groups = analyzeTagGroups(tags);
  // 桌面 tag 行为:原始选区排序直下,不组展开
  assert.deepEqual(toggleHidden(tags, [1]), ['{a', '~b}']);
  // 移动端行为:单选落组先展开再切换,锚在展开后首下标
  const indices = resolveTargetIndices(new Set([1]), groups);
  assert.deepEqual(indices, [0, 1]);
  assert.deepEqual(toggleHidden(tags, indices), ['~{a', '~b}']);
});

// ---- 9. 不可变性 ----
check('不可变: 所有纯函数返回新数组,入参数组不被修改', () => {
  const ops = [
    (t) => applyBrace(t, [0]),
    (t) => applyBracket(t, [0]),
    (t) => applyNumericWeight(t, [0], 1.2),
    (t) => clearWeights(t, [0], analyzeTagGroups(t)),
    (t) => convertSDWeights(t, [0]),
    (t) => toggleHidden(t, [0]),
  ];
  for (const op of ops) {
    const input = ['(tag:1.2)', 'b'];
    const snapshot = [...input];
    const out = op(input);
    assert.deepEqual(input, snapshot);
    assert.notEqual(out, input);
  }
});

// ---- 10. 结构断言(文本扫描) ----
const readSrc = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');

check('结构: 移动端 useFullscreenTagActions 经共享模块,无私有副本残留', () => {
  const src = readSrc('../src/components/mobile/fullscreen-editor/useFullscreenTagActions.ts');
  assert.ok(src.includes("from '../../../utils/promptWeightOps'"));
  assert.equal(src.includes('groupContinuousIndices ='), false); // 私有副本已删
  assert.equal(src.includes('isSDWeightFormat'), false); // SD 判定收编进共享模块
  assert.equal(src.includes('convertSDToNAI(t['), false);
});

check('结构: 桌面 useDesktopTagActions/useDesktopPanelActions 经共享模块', () => {
  const src = readSrc('../src/components/desktop-chip-editor/useDesktopTagActions.ts');
  assert.ok(src.includes("from '../../utils/promptWeightOps'"));
  assert.equal(src.includes('isSDWeightFormat'), false);
  // 三处内连连段分组已收编
  assert.equal(src.includes('let cur ='), false);
});

check('结构: promptWeightOps 无 React/DOM 依赖,内部依赖仅 ./promptTags', () => {
  const src = readSrc('../src/utils/promptWeightOps.ts');
  assert.equal(src.includes("'react'"), false);
  assert.equal(src.includes('"react"'), false);
  assert.equal(src.includes('document.'), false);
  assert.equal(src.includes('window.'), false);
  const imports = [...src.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]);
  assert.ok(imports.length > 0);
  // 运行时代码需显式 .ts 扩展名(node ESM 解析),同 snapshotRegenerate.ts 的既有约定
  for (const mod of imports) assert.equal(mod, './promptTags.ts', mod);
});

check('结构: prompt-editor/ 下 TipTap 主编辑器不 import promptWeightOps(本期边界)', () => {
  const dir = new URL('../src/components/prompt-editor/', import.meta.url);
  const files = readdirSync(dir).filter((f) => /\.tsx?$/.test(f));
  assert.ok(files.length > 0);
  for (const f of files) {
    const src = readFileSync(new URL(f, dir), 'utf8');
    assert.equal(src.includes('promptWeightOps'), false, f);
  }
});

// ---- 11. 权重语法防雷(P7) ----
check('detectAbnormalWeight: 名字尾数字紧贴 :: 命中(个位数同样命中)', () => {
  const w = detectAbnormalWeight('na_tarapisu153::');
  assert.ok(w && w.reason === 'attached-to-word');
  assert.equal(w.token, '153');
  assert.ok(w.message.includes('153'));
  assert.ok(typeof w.suggestion === 'string' && w.suggestion.length > 0); // 必须给出可执行建议
  assert.ok(w.suggestion.includes('na_tarapisu153')); // 尾部 :: 场景给出具体改写
  const w5 = detectAbnormalWeight('na_tarapisu5::');
  assert.ok(w5 && w5.reason === 'attached-to-word');
  assert.equal(w5.token, '5'); // 旧判据(≥10)漏掉的个位数尾巴
});

check('detectAbnormalWeight: 合法权重与普通标签不命中', () => {
  assert.equal(detectAbnormalWeight('1.2::tag::'), null); // 合法数值权重
  assert.equal(detectAbnormalWeight('tag::'), null); // 无数字
  assert.equal(detectAbnormalWeight('白发红瞳少女::'), null); // 纯中文标签
  assert.equal(detectAbnormalWeight('1.2::白发红瞳::'), null); // 合法权重 + 中文内容
  assert.equal(detectAbnormalWeight('{tag}'), null);
  assert.equal(detectAbnormalWeight('-12::tag::'), null); // 负号开头的合法权重前缀豁免
});

check('detectAbnormalWeight: 中日文字符算词字符;合法权重包裹的名字尾同样命中', () => {
  const zh = detectAbnormalWeight('画师153::');
  assert.ok(zh && zh.reason === 'attached-to-word');
  assert.equal(zh.token, '153'); // "师"是词字符,153 紧贴它 → 名字尾
  const jp = detectAbnormalWeight('イラスト7::');
  assert.ok(jp && jp.reason === 'attached-to-word');
  assert.equal(jp.token, '7'); // 假名也是词字符
  const wrapped = detectAbnormalWeight('1.2::na_tarapisu153::');
  assert.ok(wrapped && wrapped.reason === 'attached-to-word');
  assert.equal(wrapped.token, '153'); // 真实高危场景:数值权重组里画师名收尾
});

check('detectAbnormalWeight: ≥10 大数字旧信号保留(带 reason)', () => {
  const w = detectAbnormalWeight('b 12::');
  assert.ok(w && w.reason === 'large-number'); // 数字不紧贴词字符,但数值可疑
  assert.equal(w.token, '12');
  assert.ok(w.message.includes('12'));
});

check('detectAbnormalWeight: formatAbnormalWeightTip 拼齐说明与建议', () => {
  const w = detectAbnormalWeight('na_tarapisu153::');
  const tip = formatAbnormalWeightTip(w);
  assert.ok(tip.includes(w.message));
  assert.ok(tip.includes(w.suggestion));
});

console.log(`\n${checks} 项加权操作对等校验全部通过。`);
