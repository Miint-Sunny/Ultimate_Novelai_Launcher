#!/usr/bin/env node
// V5 文字渲染辅助的纯函数校验:引号检测、载体检查、手写块关闭、预算告警、
// 补全让路判定。断言的就是 src/utils/textRenderHints.ts 线上那份实现本身。
//
// 运行: node --experimental-strip-types scripts/check-text-render.mjs
//
// 为什么单独一份:这条规则是从官方 bundle 常量 + 2026-08-28 实测载荷反推的,
// 错法全部属于「不报错但行为错」——中文引号不触发、text:: 权重被当成文字块、
// 手写块没关掉自动生成就重复插入。用锚点用例钉住。

import assert from 'node:assert/strict';

await import('./lib/load-frontend-module.mjs');

const {
  CLIENT_TEXT_BLOCK_PREFIX,
  MANUAL_TEXT_BLOCK_PATTERN,
  TEXT_RENDER_TOKEN_BUDGET,
  QUOTE_PAIRS,
  hasManualTextBlock,
  hasTextCarrier,
  findQuoteSpans,
  isInsideUnclosedQuote,
  estimateTextRenderTokens,
  detectTextRenderHints,
} = await import('../src/utils/textRenderHints.ts');

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

// ---- 1. 常量锚点(官方 bundle 逐字) ----

check('常量: 五种引号配对与官方 bundle 的 tV 一致', () => {
  assert.deepEqual(QUOTE_PAIRS, {
    '"': '"',
    '“': '”',
    '「': '」',
    "'": "'",
    '‘': '’',
  });
});

check('常量: 手写块检测带 (?!:) 负向前瞻,text:: 权重语法不算文字块', () => {
  assert.equal(MANUAL_TEXT_BLOCK_PATTERN.source.includes('(?!:)'), true);
  assert.equal(hasManualTextBlock('1girl, text: Hello World'), true);
  assert.equal(hasManualTextBlock('1.2::text::hello::'), false);
  // 前置字符集合:行首 / 空白 / 标点之后才认
  assert.equal(hasManualTextBlock('1girl,text: Hello'), true);
  assert.equal(hasManualTextBlock('pretext: hello'), false);
});

check('常量: 客户端插入字面量是大小写混写的 teXt:', () => {
  assert.equal(CLIENT_TEXT_BLOCK_PREFIX, 'teXt:');
});

// ---- 2. 引号扫描 ----

check('扫描: 英文双引号成对,内容取引号之间', () => {
  const spans = findQuoteSpans('1girl, holding a sign, "Hello World"');
  assert.equal(spans.length, 1);
  assert.equal(spans[0].content, 'Hello World');
  assert.equal(spans[0].unclosed, false);
});

check('扫描: 中文全角引号与直角引号都算', () => {
  assert.equal(findQuoteSpans('1girl, “你好”')[0].content, '你好');
  assert.equal(findQuoteSpans('1girl, 「你好」')[0].content, '你好');
  assert.equal(findQuoteSpans('1girl, ‘hi’')[0].content, 'hi');
});

check('扫描: 英文单引号成对可用,但不吞所有格', () => {
  assert.equal(findQuoteSpans(`sign, 'hi'`)[0].content, 'hi');
  // 所有格:前面是词字符,' 不是开引号
  const spans = findQuoteSpans(`1girl's dress, sign, "hi"`);
  assert.equal(spans.length, 1);
  assert.equal(spans[0].content, 'hi');
  assert.equal(spans[0].unclosed, false);
});

check('扫描: 未闭合引号如实上报', () => {
  const spans = findQuoteSpans('1girl, holding a sign, "Hello World');
  assert.equal(spans.length, 1);
  assert.equal(spans[0].unclosed, true);
  assert.equal(spans[0].content, 'Hello World');
});

check('扫描: 权重包住的引号照常识别(1.2::"text"::)', () => {
  const spans = findQuoteSpans('1.2::"Hello"::, sign');
  assert.equal(spans.length, 1);
  assert.equal(spans[0].content, 'Hello');
});

check('让路判定: 光标在闭合引号外不屏蔽,未闭合引号内屏蔽', () => {
  assert.equal(isInsideUnclosedQuote('sign, "Hello"'), false);
  assert.equal(isInsideUnclosedQuote('sign, "Hello'), true);
  assert.equal(isInsideUnclosedQuote('「你好'), true);
  assert.equal(isInsideUnclosedQuote(''), false);
  // 闭合之后继续输入 tag,不屏蔽
  assert.equal(isInsideUnclosedQuote('sign, "Hello", blue eyes'), false);
});

// ---- 3. 载体检查 ----

check('载体: sign / speech_bubble(下划线) / 中文「书页」都命中', () => {
  assert.equal(hasTextCarrier('1girl, holding a sign'), true);
  assert.equal(hasTextCarrier('1girl, speech_bubble'), true);
  assert.equal(hasTextCarrier('1girl, 桌上摊开的书页'), true);
  assert.equal(hasTextCarrier('1girl, 手机屏幕'), true);
});

check('载体: 词边界防止 sign 误命中 signature/design', () => {
  assert.equal(hasTextCarrier('1girl, signature, best quality'), false);
  assert.equal(hasTextCarrier('1girl, design, masterpiece'), false);
});

// ---- 4. detectTextRenderHints 组合行为 ----

check('体检: 有引号有载体,不告警', () => {
  assert.deepEqual(detectTextRenderHints('1girl, holding a sign, "Hello World"'), []);
  assert.deepEqual(detectTextRenderHints('1girl, speech bubble, “你好”'), []);
});

check('体检: 有引号无载体,报 no-carrier(英文/中文引号同则)', () => {
  const en = detectTextRenderHints('1girl, "Hello World"');
  assert.equal(en.length, 1);
  assert.equal(en[0].kind, 'no-carrier');
  assert.deepEqual(en[0].span, [7, 20]);

  const zh = detectTextRenderHints('1girl, “你好世界”');
  assert.equal(zh.some((h) => h.kind === 'no-carrier'), true);
});

check('体检: 引号未闭合报 unclosed-quote', () => {
  const hints = detectTextRenderHints('1girl, holding a sign, "Hello World');
  assert.equal(hints.length, 1);
  assert.equal(hints[0].kind, 'unclosed-quote');
});

check('体检: 权重包住的引号同样参与载体检查', () => {
  const ok = detectTextRenderHints('sign, 1.2::"Hello"::');
  assert.deepEqual(ok, []);
  const bad = detectTextRenderHints('1girl, 1.2::"Hello"::');
  assert.equal(bad.some((h) => h.kind === 'no-carrier'), true);
});

check('体检: 手写 text: 块会关闭自动生成,不再提示', () => {
  assert.deepEqual(detectTextRenderHints('1girl, text: Hello World'), []);
  assert.deepEqual(detectTextRenderHints('1girl, TEXT: Hello World'), []);
  // text:: 权重语法不算手写块,引号提示照常
  const hints = detectTextRenderHints('1.2::text::hello::, 1girl, "Hi"');
  assert.equal(hints.some((h) => h.kind === 'no-carrier'), true);
});

check('体检: 文字超预算报 text-block-over-budget', () => {
  const longText = '字'.repeat(TEXT_RENDER_TOKEN_BUDGET + 50);
  const hints = detectTextRenderHints(`sign, "${longText}"`);
  assert.equal(hints.some((h) => h.kind === 'text-block-over-budget'), true);
  const within = detectTextRenderHints('sign, "short"');
  assert.equal(within.some((h) => h.kind === 'text-block-over-budget'), false);
});

check('体检: 空内容与空串不告警;所有格不触发未闭合', () => {
  assert.deepEqual(detectTextRenderHints(''), []);
  assert.deepEqual(detectTextRenderHints('1girl, ""'), []);
  assert.deepEqual(detectTextRenderHints(`1girl's dress, sign, "hi"`), []);
});

// ---- 5. token 粗估 ----

check('粗估: CJK 一字一记,拉丁按词约每 4 字符一记', () => {
  assert.equal(estimateTextRenderTokens('你好世界'), 4);
  assert.ok(estimateTextRenderTokens('Hello World') >= 2);
  assert.ok(estimateTextRenderTokens('Hello World') <= 4);
});

console.log(`\n${checks} 项文字渲染辅助校验全部通过。`);
