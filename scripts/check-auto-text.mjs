#!/usr/bin/env node
// autoText 发包变换的对等校验:引号内容 → `teXt:` 块,以及它的逆操作。
//
// 运行: node --experimental-strip-types scripts/check-auto-text.mjs
//
// 为什么单独一份:这条变换改的是**真正发出去的提示词**,而它的错法全都不报错——
//   1. 撇号误判:`don't` 被当成引号开头,后面整段被吃进文字块,图上开始出现乱码;
//   2. 用户手写了 `text:` 还继续自动加,两个块叠在一起;
//   3. CJK 顺序不反转,竖排的字从左往右念;
//   4. 剥离时只认标记不重算,把用户自己写的 `teXt:` 一起吃掉;
//   5. 能力位没门住,V4 系也发块——V4 不认,块里的字直接变成普通 tag。
// 逐条对齐 Plana-App 的 auto_text.dart(它又是逐条照抄官方实现)。

import assert from 'node:assert/strict';

await import('./lib/load-frontend-module.mjs');

const { applyAutoText, stripAutoText, extractQuoted, splitPromptChunks } =
  await import('../src/utils/autoText.ts');
const { buildRequestPayload } = await import('../src/services/novelai.ts');
const { buildPromptPair } = await import('../src/components/generation/generationPrompts.ts');
const { importedPositivePrompt } = await import('../src/components/left-sidebar/metadataImportActions.ts');
const { DEFAULT_PROMPT_PRESETS } = await import('../src/services/localLibrary/promptPresets.ts');

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

// ---- 1. 引号抽取 ----

check('抽取: 五种引号配对都认', () => {
  assert.deepEqual(extractQuoted('a "one" b'), ['one']);
  assert.deepEqual(extractQuoted('a “two” b'), ['two']);
  assert.deepEqual(extractQuoted('a 「three」 b'), ['three']);
  assert.deepEqual(extractQuoted("a 'four' b"), ['four']);
  assert.deepEqual(extractQuoted('a ‘five’ b'), ['five']);
});

check('抽取: 英文撇号不误判 —— don\'t / it\'s 安全', () => {
  assert.deepEqual(extractQuoted("1girl, don't stop, it's fine"), []);
  // 撇号前不是字母数字时才当引号开头
  assert.deepEqual(extractQuoted("1girl, 'yes' please"), ['yes']);
  // 这条专门盯住**开头**那侧的守卫:撇号与真引号混在一起时,少了它就会从 it's
  // 的撇号开引,把中间整段("s a 'test")吞进文字块。上面两条都区分不出来。
  assert.deepEqual(extractQuoted("it's a 'test' here"), ['test']);
});

check('抽取: 没有配对收尾的引号当普通字符跳过', () => {
  assert.deepEqual(extractQuoted('1girl, "unclosed'), []);
  assert.deepEqual(extractQuoted('1girl, 「不闭合'), []);
});

check('抽取: 内容去空白,纯空白的引号丢掉', () => {
  assert.deepEqual(extractQuoted('a "  padded  " b'), ['padded']);
  assert.deepEqual(extractQuoted('a "   " b'), []);
});

// ---- 2. 不插手的情形 ----

check('不插手: 用户手写 text: 就完全不动(不分大小写)', () => {
  for (const prompt of ['1girl, text: mine, "ignored"', '1girl, Text: mine, "ignored"', '1girl, TEXT: mine, "x"']) {
    assert.equal(applyAutoText(prompt), prompt);
  }
});

check('不插手: 角色提示词里手写 text: 也算', () => {
  const prompt = '1girl, "hello"';
  assert.equal(applyAutoText(prompt, { characters: [{ prompt: 'char, text: mine' }] }), prompt);
});

check('不插手: text:: 是权重语法不是文字块,不能因此罢工', () => {
  assert.equal(applyAutoText('1girl, text::1.2, "hello"'), '1girl, text::1.2, "hello", teXt: hello');
});

check('不插手: 没有引号内容时原样返回', () => {
  assert.equal(applyAutoText('1girl, no quotes'), '1girl, no quotes');
});

// ---- 3. 块的形状 ----

check('块: 引号本身保留,块追加在末尾,多段用空行分隔', () => {
  assert.equal(applyAutoText('1girl, "a", "b"'), '1girl, "a", "b", teXt: a\n\nb');
});

check('块: 标记是 teXt: 这个大小写变体(剥离时靠它区分自动与手写)', () => {
  assert.ok(applyAutoText('1girl, "a"').includes('teXt:'));
  assert.ok(!applyAutoText('1girl, "a"').includes('Text:'));
});

check('块: 引号原样留在提示词里,不是被搬走', () => {
  assert.equal(applyAutoText('"a"'), '"a", teXt: a');
});

check('块: 拼接前吃掉末尾的空白与逗号,不留双逗号', () => {
  assert.equal(applyAutoText('1girl, "a", '), '1girl, "a", teXt: a');
  assert.equal(applyAutoText('1girl, "a"  '), '1girl, "a", teXt: a');
});

check('块: 第一块为空时不留前导逗号(内容全来自角色)', () => {
  assert.equal(applyAutoText('', { characters: [{ prompt: '"x"' }] }), 'teXt: x');
  assert.equal(applyAutoText('  ,  ', { characters: [{ prompt: '"x"' }] }), 'teXt: x');
});

// ---- 4. CJK 顺序 ----

check('顺序: CJK 占比 > 30% 时整体反转(竖排右起)', () => {
  assert.equal(applyAutoText('1girl, 「你好」, 「世界」'), '1girl, 「你好」, 「世界」, teXt: 世界\n\n你好');
});

check('顺序: 拉丁文本不反转', () => {
  assert.equal(applyAutoText('1girl, "first", "second"'), '1girl, "first", "second", teXt: first\n\nsecond');
});

// ---- 5. 多角色阅读顺序 ----

check('顺序: 带坐标时按阅读顺序 —— 先分行,行内从左到右', () => {
  const characters = [
    { prompt: 'c, "right"', center: { x: 0.8, y: 0.2 } },
    { prompt: 'c, "left"', center: { x: 0.2, y: 0.2 } },
    { prompt: 'c, "below"', center: { x: 0.5, y: 0.9 } },
  ];
  assert.equal(
    applyAutoText('base', { characters, useCoords: true }),
    'base, teXt: left\n\nright\n\nbelow',
  );
});

check('顺序: 不用坐标时保持原顺序', () => {
  const characters = [
    { prompt: 'c, "right"', center: { x: 0.8, y: 0.2 } },
    { prompt: 'c, "left"', center: { x: 0.2, y: 0.2 } },
  ];
  assert.equal(applyAutoText('base', { characters, useCoords: false }), 'base, teXt: right\n\nleft');
});

check('顺序: 关掉的角色不参与', () => {
  const characters = [{ prompt: 'c, "on"' }, { prompt: 'c, "off"', enabled: false }];
  assert.equal(applyAutoText('base', { characters }), 'base, teXt: on');
});

// ---- 6. 提示词分块 ----

check('分块: 只改第一块,后面的块原样保留', () => {
  assert.equal(applyAutoText('a, "x" | b, "y"'), 'a, "x", teXt: x| b, "y"');
});

check('分块: || 之间的竖线不算分隔符', () => {
  assert.deepEqual(splitPromptChunks('a||b|c||d'), ['a||b|c||d']);
  assert.deepEqual(splitPromptChunks('a|b'), ['a', 'b']);
});

check('分块: 超过 6 块的部分并进最后一块,不丢内容', () => {
  const chunks = splitPromptChunks('1|2|3|4|5|6|7|8');
  assert.equal(chunks.length, 6);
  assert.equal(chunks[5], '6|7|8');
  assert.equal(chunks.join('|'), '1|2|3|4|5|6|7|8');
});

// ---- 7. 逆操作 ----

check('剥离: apply 之后 strip 能逐字还原', () => {
  for (const src of ['1girl, "hello"', '1girl, 「你好」, 「世界」', '"only"', 'a, "x"|b, "y"']) {
    assert.equal(stripAutoText(applyAutoText(src)), src, `往返不逐字: ${src}`);
  }
});

check('剥离: 块边界前的空白会被规范掉,且规范一次之后稳定', () => {
  // apply 拼接前要吃掉第一块末尾的空白与逗号,所以 `"x" |` 里那个空格回不来。
  // 与 Plana / 官方同行为,不"修正" —— 对模型等价,但要写明白它不是逐字往返。
  const src = 'a, "x" | b, "y"';
  const once = stripAutoText(applyAutoText(src));
  assert.equal(once, 'a, "x"| b, "y"');
  assert.equal(stripAutoText(applyAutoText(once)), once, '规范之后应当不再变化');
});

check('剥离: 用户手改过的块原样保留 —— 判定是重算而不是认标记', () => {
  // 重算不出这个内容,说明是用户自己写/改的,不能吃掉
  assert.equal(stripAutoText('1girl, teXt: 我自己写的'), '1girl, teXt: 我自己写的');
});

check('剥离: 没有块时不动', () => {
  assert.equal(stripAutoText('1girl, "hello"'), '1girl, "hello"');
});

check('剥离: 带角色的往返也要逐字', () => {
  const characters = [{ prompt: 'c, "from char"', center: { x: 0.3, y: 0.5 } }];
  const src = '1girl, "base"';
  const applied = applyAutoText(src, { characters, useCoords: true });
  assert.ok(applied.includes('teXt:'));
  assert.equal(stripAutoText(applied, { characters, useCoords: true }), src);
});

// ---- 8. 一路发到载荷 ----

const baseParams = (overrides = {}) => ({
  positivePrompt: '1girl, "hello"',
  negativePrompt: 'lowres',
  model: 'v5-full',
  width: 832,
  height: 1216,
  steps: 28,
  scale: 5,
  sampler: 'k_euler_ancestral',
  cfgRescale: 0,
  noiseSchedule: 'karras',
  ucPreset: 'heavy',
  qualityToggle: true,
  varietyPlus: false,
  normalizeVibeStrength: true,
  characterPrompts: [],
  seed: 1,
  ...overrides,
});

check('载荷: 能力位门住 —— V5 出块,V4 系不出', () => {
  for (const model of ['v5-full', 'v5-curated']) {
    assert.ok(buildRequestPayload(baseParams({ model })).input.includes('teXt: hello'), model);
  }
  for (const model of ['v4.5-full', 'v4.5-curated', 'v4-full']) {
    assert.ok(!buildRequestPayload(baseParams({ model })).input.includes('teXt:'), model);
  }
});

check('载荷: input 与 v4_prompt.base_caption 同源(两处都得是变换后的)', () => {
  const payload = buildRequestPayload(baseParams());
  assert.equal(payload.parameters.v4_prompt.caption.base_caption, payload.input);
  assert.ok(payload.input.includes('teXt: hello'));
});

check('载荷: 负向提示词不做这个变换', () => {
  const payload = buildRequestPayload(baseParams({ negativePrompt: 'lowres, "not text"' }));
  assert.ok(!payload.parameters.v4_negative_prompt.caption.base_caption.includes('teXt:'));
});

check('载荷: 块落在质量尾之后 —— 官方的位置', () => {
  const preset = DEFAULT_PROMPT_PRESETS.find((item) => item.id === 'v5-standard');
  const { positive } = buildPromptPair({
    positivePrompt: '1girl, "hello"',
    negativePrompt: '',
    activePreset: preset,
  });
  const input = buildRequestPayload(baseParams({ positivePrompt: positive })).input;
  assert.ok(input.indexOf(preset.positive) < input.indexOf('teXt:'), '质量尾应该在块之前');
  assert.ok(input.endsWith('teXt: hello'));
});

// ---- 9. 导入侧 ----

check('导入: 输入框拿到的是用户原文,不是发出去那一份', () => {
  const source = '1girl, "hello"';
  const sent = applyAutoText(source);
  assert.notEqual(sent, source);
  assert.equal(importedPositivePrompt({ prompt: sent }), source);
});

check('导入: 带角色时也能剥干净(重算要用同一批角色)', () => {
  const characters = [{ prompt: 'c, "from char"', center: { x: 0.3, y: 0.5 } }];
  const source = '1girl, "base"';
  const sent = applyAutoText(source, { characters, useCoords: true });
  assert.equal(importedPositivePrompt({ prompt: sent, characterPrompts: characters }), source);
});

check('导入: 算不出来的块原样保留 —— 别人家的块、用户手改的块都不吃', () => {
  const handEdited = '1girl, teXt: 我自己改的';
  assert.equal(importedPositivePrompt({ prompt: handEdited }), handEdited);
  // 角色对不上时同样保守:宁可留着,也不要吃掉可能是用户写的内容
  const characters = [{ prompt: 'c, "from char"', center: { x: 0.3, y: 0.5 } }];
  const sent = applyAutoText('1girl, "base"', { characters, useCoords: true });
  assert.equal(importedPositivePrompt({ prompt: sent }), sent);
});

check('导入: 反复导入不会叠块', () => {
  let prompt = '1girl, "hello"';
  for (let round = 0; round < 3; round += 1) {
    prompt = importedPositivePrompt({ prompt: applyAutoText(prompt) });
  }
  assert.equal(prompt, '1girl, "hello"');
});

console.log(`\n${checks} 项 autoText 校验全部通过。`);
