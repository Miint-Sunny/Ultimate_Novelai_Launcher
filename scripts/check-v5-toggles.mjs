#!/usr/bin/env node
// V5 开关词条表与其纯操作的对等校验。
//
// 运行: node --experimental-strip-types scripts/check-v5-toggles.mjs
//
// 为什么值得单独一份:这批词拼错了**服务端不报错**,只是悄悄不生效。也就是说
// 表里写错一个字母,本地一切正常、出图也正常,只是用户以为开了的东西没开——
// 这类错没有任何运行时反馈,只能在这里钉住。
//
// 同样钉住两条**刻意的缺席**:`res_mult:Nx` 没有出处,`transparent background`
// 另有专门开关。它们不该被"顺手补全"进表里,所以反向断言。

import assert from 'node:assert/strict';

const { V5_TOGGLE_GROUPS, activeV5Toggles, toggleV5Word } = await import(
  '../src/services/naiV5Toggles.ts'
);

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

const literals = V5_TOGGLE_GROUPS.flatMap((g) => g.options.map((o) => o.literal));

check('表: 字面量非空、唯一,且没有前后空白', () => {
  assert.ok(literals.length >= 12);
  assert.equal(new Set(literals).size, literals.length, '字面量重复');
  for (const l of literals) assert.equal(l, l.trim(), `「${l}」带空白`);
});

check('表: 每组有 id / 标题 / 说明,互斥组至少两档', () => {
  const ids = V5_TOGGLE_GROUPS.map((g) => g.id);
  assert.equal(new Set(ids).size, ids.length, '组 id 重复');
  for (const g of V5_TOGGLE_GROUPS) {
    assert.ok(g.id && g.title && g.hint, `${g.id} 缺字段`);
    assert.ok(['exclusive', 'independent'].includes(g.kind));
    if (g.kind === 'exclusive') assert.ok(g.options.length >= 2);
  }
});

check('表: complexity 四档、visual novel 五档,逐字对齐 NAI5_All_Prompting.md', () => {
  const complexity = V5_TOGGLE_GROUPS.find((g) => g.id === 'complexity');
  assert.deepEqual(
    complexity.options.map((o) => o.literal),
    ['low complexity', 'medium complexity', 'high complexity', 'ultra complexity'],
  );
  // 五档,不是三档。art 与 chibi 是我照旧版文档抄漏的,别再漏回去。
  const vn = V5_TOGGLE_GROUPS.find((g) => g.id === 'visual-novel');
  assert.deepEqual(
    vn.options.map((o) => o.literal),
    [
      'visual novel art',
      'visual novel bg',
      'visual novel cg',
      'visual novel sprite',
      'visual novel chibi',
    ],
  );
});

check('表: 三条刻意的缺席 —— res_mult / transparent background / location', () => {
  assert.ok(!literals.some((l) => /res_mult/i.test(l)), 'res_mult 没有出处,不该进表');
  assert.ok(
    !literals.some((l) => l.toLowerCase() === 'transparent background'),
    'transparent background 已有专门开关,进表会有两个入口打架',
  );
  // location 在旧版文档里有、当前正本里 0 命中(连同 indoors/outdoors 一起被移除)。
  // 我照旧版抄进来过一次,这条断言防止再抄回来。
  assert.ok(
    !literals.some((l) => l.toLowerCase() === 'location'),
    'location 在当前 nai5-prompting 里已无出处,不该进表',
  );
});

check('检测: 权重要分正负 —— 正权重算开,负权重不算', () => {
  assert.ok(activeV5Toggles('1girl, high complexity').has('high complexity'));
  assert.ok(activeV5Toggles('1girl, 1.3::high complexity::').has('high complexity'));
  // 0~1 是减弱不是反转,仍然算开
  assert.ok(activeV5Toggles('1boy, 0.6::attractive male::.').has('attractive male'));
  // 负权重是文档记载的反向用法(complexity 有画面固化倾向,负权重反而更好)。
  // 点亮按钮会诱导用户再点一次去"关",结果把那条负权重删掉——所以不算开。
  assert.equal(activeV5Toggles('1girl, -1::ultra complexity::').size, 0);
  assert.equal(activeV5Toggles('1boy, -5::attractive male::.').size, 0);
});

check('检测: 大小写不敏感', () => {
  assert.ok(activeV5Toggles('1girl, HIGH Complexity').has('high complexity'));
});

check('检测: 全角逗号与换行同样算分隔符', () => {
  assert.ok(activeV5Toggles('1girl，depthness').has('depthness'));
  assert.ok(activeV5Toggles('1girl,\nhas alpha').has('has alpha'));
});

check('检测: 权重跨标签生效,未闭合会吃到结尾', () => {
  // 一段里两个标签共享同一个权重
  const shared = activeV5Toggles('1girl, 1.3::depthness, attractive male::, x');
  assert.ok(shared.has('depthness') && shared.has('attractive male'));
  // 漏写收尾 :: 时权重一直吃到结尾——文档专门警告过的坑,按真实语义建模
  const bleed = activeV5Toggles('1girl, 1.4::high complexity, visual novel bg, from below.');
  assert.ok(bleed.has('high complexity') && bleed.has('visual novel bg'));
});

check('检测: 句末标点不挡匹配', () => {
  // 这套方法论里 tag 常跟在自然语句后面,`ultra complexity.` 是真实写法
  assert.ok(activeV5Toggles('1girl, solo, ultra complexity.').has('ultra complexity'));
  assert.ok(activeV5Toggles('1boy, 0.6::attractive male::.').has('attractive male'));
});

check('检测: 顿号也算分隔符', () => {
  assert.ok(
    activeV5Toggles('1girl,\tsolo,full body、high complexity，from below.').has('high complexity'),
  );
});

check('检测: 长词不被短词吃掉,子串不误报', () => {
  const active = activeV5Toggles('1girl, alpha transparency');
  assert.ok(active.has('alpha transparency'));
  assert.ok(!active.has('has alpha'));
  // 整条标签才算命中:`low complexity background` 不是 `low complexity`
  assert.equal(activeV5Toggles('low complexity background').size, 0);
  // 真实存在的近邻标签不该误报
  assert.equal(activeV5Toggles('1girl, depth of field, bokeh').size, 0, 'depth of field ≠ depthness');
  assert.equal(activeV5Toggles('1girl, 1boy, male focus, solo focus').size, 0, 'male focus ≠ attractive male');
  // 散文里的普通英文词不是标签
  assert.equal(
    activeV5Toggles('1girl.\nThe story centers on a remote coastal location.').size,
    0,
  );
});

check('摘除: 拆开权重段时要把开括号与收尾符交接好', () => {
  // 只删标签会让 `1.5::` 跟着没了,剩下的收尾符会错误闭合**之前别的**权重段
  assert.equal(
    toggleV5Word('1girl, 1.5::high complexity, detailed background::, x', 'complexity', 'high complexity'),
    '1girl, 1.5::detailed background::, x',
  );
  // 同段里还有另一个受管词时,不能把它孤儿化
  assert.equal(
    toggleV5Word('1girl, 1.3::depthness, attractive male::, x', 'v5-extras', 'depthness'),
    '1girl, 1.3::attractive male::, x',
  );
});

check('切换: 互斥组换档是一步,不会两档并存', () => {
  let p = toggleV5Word('1girl', 'complexity', 'high complexity');
  assert.equal(p, '1girl, high complexity');
  p = toggleV5Word(p, 'complexity', 'ultra complexity');
  assert.equal(p, '1girl, ultra complexity');
  assert.equal(activeV5Toggles(p).size, 1);
});

check('切换: 互斥组能收拾用户手动造出的双档并存', () => {
  const messy = '1girl, low complexity, smiling, ultra complexity';
  const p = toggleV5Word(messy, 'complexity', 'high complexity');
  const active = activeV5Toggles(p);
  assert.deepEqual([...active], ['high complexity']);
  assert.ok(p.includes('smiling'), '不该误伤同组之外的标签');
});

check('切换: 再点一次是摘除,且不留空档', () => {
  const p = toggleV5Word('1girl, depthness, smiling', 'v5-extras', 'depthness');
  assert.equal(p, '1girl, smiling');
  assert.ok(!/,\s*,/.test(p), '留下了连续逗号');
});

check('切换: 独立组各自为政,互不影响', () => {
  let p = toggleV5Word('1girl', 'v5-extras', 'depthness');
  p = toggleV5Word(p, 'v5-extras', 'has alpha');
  const active = activeV5Toggles(p);
  assert.ok(active.has('depthness') && active.has('has alpha'));
});

check('切换: 空提示词只留字面量,首尾不挂逗号', () => {
  const p = toggleV5Word('', 'v5-extras', 'depthness');
  assert.equal(p, 'depthness');
});

check('切换: 未知组 / 不属于该组的字面量,原样返回', () => {
  assert.equal(toggleV5Word('1girl', 'nope', 'depthness'), '1girl');
  assert.equal(toggleV5Word('1girl', 'complexity', 'depthness'), '1girl');
});

check('切换: 不改动用户的排版习惯(换行分组保留)', () => {
  const p = toggleV5Word('1girl,\nsmiling', 'v5-extras', 'depthness');
  assert.ok(p.includes('\n'), '换行被吃掉了');
});

console.log(`\n${checks} 项 V5 开关词条校验全部通过。`);
