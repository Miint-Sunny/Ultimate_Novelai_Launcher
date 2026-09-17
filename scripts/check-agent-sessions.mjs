#!/usr/bin/env node
// Harness 会话归档与用量账本的校验:钉住从 Novelai-harness 搬来的账本语义(按响应记、key 去重、
// 本地日期周期、按合计降序、1.2K 格式)和归档摘要(标题 / 预览 / 轮数 / 工具 / token / 出错)。
//
// 运行: node --experimental-strip-types scripts/check-agent-sessions.mjs
//
// 这层的错法全是「不报错但数字不对」:近 7 天少算一天、重复记账、空对话进了历史、
// 归档把图片字节也塞进 localStorage。

import assert from 'node:assert/strict';

await import('./lib/load-frontend-module.mjs');

const L = await import('../src/services/agentHarness/usageLedger.ts');
const { recordUsage, aggregateLedger, periodStartDay, localDay, formatTokens, cacheHitRate, sanitizeUsageLedger, EMPTY_LEDGER, MAX_LEDGER_ENTRIES } = L;
const A = await import('../src/components/desktop/AIAssistant/harness/sessionArchive.ts');
const { summarizeTranscript, buildHarnessSession, sessionItems, prependSession, sanitizeHarnessSessions, sessionUsageByModel, MAX_HARNESS_SESSIONS } = A;

let checks = 0;
const check = async (name, fn) => {
  checks += 1;
  try { await fn(); console.log(`ok ${checks} - ${name}`); }
  catch (error) { console.error(`not ok ${checks} - ${name}`); throw error; }
};

// Pi 口径:input 是未命中缓存的输入;cacheReadReported 缺省按「有缓存读数就算报告了」。
const usage = (input, output, cacheRead = 0, cacheWrite = 0) => ({ input, output, cacheRead, cacheWrite, cacheReadReported: cacheRead > 0 });
// 固定「现在」:2026-09-07 10:00 本地时间。
const NOW = new Date(2026, 8, 7, 10, 0, 0).getTime();
const day = (y, m, d) => new Date(y, m - 1, d, 12, 0, 0).getTime();

// ---- 1. 账本 ----

await check('账本: 用量为 0 不记,key 重复不记,都原样返回同一对象', () => {
  const a = recordUsage(EMPTY_LEDGER, { key: 'k1', provider: 'openai', model: 'gpt', usage: usage(0, 0), at: NOW });
  assert.equal(a, EMPTY_LEDGER);
  const b = recordUsage(EMPTY_LEDGER, { key: 'k1', provider: 'openai', model: 'gpt', usage: usage(10, 5), at: NOW });
  assert.equal(b.entries.length, 1);
  const c = recordUsage(b, { key: 'k1', provider: 'openai', model: 'gpt', usage: usage(99, 99), at: NOW });
  assert.equal(c, b);
  assert.equal(b.entries[0].day, localDay(NOW));
});

await check('账本: 周期起点 —— 今天 / 近 7 天是今天往前 6 天 / 近 30 天往前 29 天 / 全部无起点', () => {
  assert.equal(periodStartDay('today', NOW), '2026-09-07');
  assert.equal(periodStartDay('last7d', NOW), '2026-09-01');
  assert.equal(periodStartDay('last30d', NOW), '2026-08-09');
  assert.equal(periodStartDay('all', NOW), null);
  // 跨月边界:9 月 3 日往前 6 天是 8 月 28 日。
  assert.equal(periodStartDay('last7d', new Date(2026, 8, 3).getTime()), '2026-08-28');
});

await check('账本: 聚合按周期过滤、按 provider/model 合并、按合计降序、命中率 = 缓存 / 输入', () => {
  let ledger = EMPTY_LEDGER;
  const add = (key, model, u, at, provider = 'openai') => { ledger = recordUsage(ledger, { key, provider, model, usage: u, at }); };
  add('a', 'gpt', usage(100, 50, 40), NOW);                    // 今天
  add('b', 'gpt', usage(10, 5), day(2026, 9, 1));             // 近 7 天边界(含)
  add('c', 'claude', usage(1000, 100), day(2026, 8, 31), 'anthropic'); // 7 天外,30 天内
  add('d', 'gpt', usage(1, 1), day(2026, 8, 9));               // 30 天边界(含)
  add('e', 'gpt', usage(7, 7), day(2026, 8, 8));               // 30 天外
  const today = aggregateLedger(ledger, 'today', NOW);
  assert.equal(today.requests, 1);
  assert.deepEqual(today.usage, usage(100, 50, 40));
  assert.equal(today.models[0].name, 'openai/gpt');
  const week = aggregateLedger(ledger, 'last7d', NOW);
  assert.equal(week.requests, 2);
  // b 没报告缓存读数 → 合计的 cacheReadReported 为 false(混合统计不冒充命中率)。
  assert.deepEqual(week.usage, { ...usage(110, 55, 40), cacheReadReported: false });
  assert.equal(cacheHitRate(week.usage), null);
  const month = aggregateLedger(ledger, 'last30d', NOW);
  assert.equal(month.requests, 4);
  assert.deepEqual(month.models.map((m) => m.name), ['anthropic/claude', 'openai/gpt']);
  assert.equal(month.models[1].requests, 3);
  const all = aggregateLedger(ledger, 'all', NOW);
  assert.equal(all.requests, 5);
  // 命中率 = 缓存读 / 总输入(未命中 100 + 缓存 40)。
  assert.equal(cacheHitRate(today.usage), 40 / 140);
  assert.equal(cacheHitRate(usage(0, 5)), null);
  assert.equal(cacheHitRate({ input: 10, output: 1, cacheRead: 0, cacheWrite: 0, cacheReadReported: false }), null, '没报告缓存的请求不冒充 0%');
  assert.equal(cacheHitRate({ input: 10, output: 1, cacheRead: 0, cacheWrite: 0, cacheReadReported: true }), 0, '报告了 0 命中就是 0%');
});

await check('账本: formatTokens 与他的一致 —— 999 / 1.0K / 12.3K / 1.2M / 1.5B', () => {
  assert.equal(formatTokens(999), '999');
  assert.equal(formatTokens(1000), '1.0K');
  assert.equal(formatTokens(12345), '12.3K');
  assert.equal(formatTokens(1_234_567), '1.2M');
  assert.equal(formatTokens(1_500_000_000), '1.5B');
  assert.equal(formatTokens(0), '0');
});

await check('账本: 超过上限丢最早的;sanitize 扔掉坏条目与重复 key,补 day', () => {
  let ledger = EMPTY_LEDGER;
  for (let i = 0; i < MAX_LEDGER_ENTRIES + 3; i += 1) ledger = recordUsage(ledger, { key: `k${i}`, provider: 'p', model: 'm', usage: usage(1, 1), at: NOW + i });
  assert.equal(ledger.entries.length, MAX_LEDGER_ENTRIES);
  assert.equal(ledger.entries[0].key, 'k3');
  const clean = sanitizeUsageLedger({ entries: [
    { key: 'x', at: NOW, provider: 'p', model: 'm', usage: usage(1, 2, 3, 4) },
    { key: 'x', at: NOW, provider: 'p', model: 'm', usage: usage(9, 9) },      // 重复 key
    { key: 'y', at: 'nope', provider: 'p', model: 'm', usage: usage(1, 1) },    // at 坏
    { key: 'z', at: NOW, provider: 'p', model: 'm', usage: { input: 1 } },      // usage 缺字段
    { key: 'w', at: NOW, usage: usage(1, 1) },                                  // 缺 provider / model → unknown
    'garbage', null,
  ] });
  assert.deepEqual(clean.entries.map((e) => e.key), ['x', 'w']);
  assert.equal(clean.entries[0].day, localDay(NOW));
  assert.equal(clean.entries[1].provider, 'unknown');
  assert.equal(clean.entries[1].model, 'unknown');
  assert.deepEqual(sanitizeUsageLedger('nope'), EMPTY_LEDGER);
  // 旧账本(version 1)的 input 含缓存:读回来减掉;新账本(version 2)原样。
  const migrated = sanitizeUsageLedger({ version: 1, entries: [{ key: 'old', at: NOW, provider: 'p', model: 'm', usage: { input: 100, output: 5, cacheRead: 40, cacheWrite: 0 } }] });
  assert.deepEqual(migrated.entries[0].usage, { input: 60, output: 5, cacheRead: 40, cacheWrite: 0, cacheReadReported: true });
  const kept = sanitizeUsageLedger({ version: 2, entries: [{ key: 'new', at: NOW, provider: 'p', model: 'm', usage: { input: 60, output: 5, cacheRead: 40, cacheWrite: 0, cacheReadReported: true } }] });
  assert.equal(kept.entries[0].usage.input, 60);
  assert.equal(migrated.version, 2);
});

// ---- 2. 归档 ----

const transcript = [
  { kind: 'user', id: 'u1', text: '  帮我画一张\n雨夜街头的双人构图,要有霓虹灯,湿漉漉的地面反光,还要有伞  ', imageDataUrl: 'data:image/png;base64,AAAA', at: NOW, harnessId: 'user_1' },
  { kind: 'assistant', id: 'a1', content: '先看看当前参数。', thoughts: '', streaming: false, model: 'gpt-4.1', usage: usage(100, 20, 30), at: NOW + 1 },
  { kind: 'tool_call', id: 'tc1', call: { id: 'call_0', name: 'get_studio_parameters', arguments: {} }, result: { toolCallId: 'call_0', content: '{}', isError: false, imageBase64: 'BBBB', imageMimeType: 'image/png' }, at: NOW + 2 },
  { kind: 'notice', id: 'n1', level: 'error', text: '循环异常:boom', at: NOW + 3 },
  { kind: 'user', id: 'u2', text: '再来', at: NOW + 4 },
  { kind: 'assistant', id: 'a2', content: '改好了,已经出图。', thoughts: '', streaming: false, model: 'claude', usage: usage(200, 40), at: NOW + 5 },
  { kind: 'permission', id: 'p1', request: { id: 'p1', toolCallId: 'c', toolName: 'novelai_generate', toolLabel: '生成', permissionClass: 'P', args: {}, summary: 's', respond: () => {} }, decision: { kind: 'allow' }, at: NOW + 6 },
];

await check('归档: 没有用户消息的对话不入库', () => {
  assert.equal(summarizeTranscript([]), null);
  assert.equal(buildHarnessSession([{ kind: 'assistant', id: 'a', content: 'hi', thoughts: '', streaming: false, at: NOW }]), null);
});

await check('归档: 摘要 —— 标题取首条用户消息 30 字压成一行、预览取最后一条有字的回复、轮数 / 工具 / token / 模型 / 出错', () => {
  const s = summarizeTranscript(transcript);
  assert.equal(s.title, '帮我画一张 雨夜街头的双人构图,要有霓虹灯,湿漉漉的地面反光…');
  assert.equal(s.title.length, 31);
  assert.equal(s.preview, '改好了,已经出图。');
  assert.equal(s.startedAt, NOW);
  assert.equal(s.turns, 2);
  assert.equal(s.toolCalls, 1);
  // 第二条回复没报告缓存读数,合计不冒充命中率。
  assert.deepEqual(s.usage, { ...usage(300, 60, 30), cacheReadReported: false });
  assert.equal(s.model, 'claude');
  assert.equal(s.err, true);
  assert.equal(summarizeTranscript([{ kind: 'user', id: 'u', text: '', imageDataUrl: 'data:', at: NOW }]).title, '(图片)');
});

await check('归档: 条目落盘剥掉图片字节与 respond 函数,读回后能重建成面板条目', () => {
  const session = buildHarnessSession(transcript, NOW + 100, 'hs_test');
  assert.equal(session.id, 'hs_test');
  assert.equal(session.at, NOW + 100);
  const json = JSON.stringify(session);
  assert.ok(!json.includes('AAAA'), '用户图片字节不该落盘');
  assert.ok(!json.includes('BBBB'), '工具结果图片字节不该落盘');
  const back = sessionItems(JSON.parse(json));
  assert.equal(back.length, transcript.length);
  assert.equal(back[0].imageDataUrl, undefined);
  assert.equal(typeof back[6].request.respond, 'function');
  assert.deepEqual(back[6].decision, { kind: 'allow' });
  assert.equal(back[5].streaming, false);
});

await check('归档: 新的在前、同 id 去重、封顶 30 条;sanitize 丢坏条目、摘要坏了从条目重算', () => {
  let list = [];
  for (let i = 0; i < MAX_HARNESS_SESSIONS + 2; i += 1) list = prependSession(list, buildHarnessSession(transcript, NOW + i, `hs_${i}`));
  assert.equal(list.length, MAX_HARNESS_SESSIONS);
  assert.equal(list[0].id, `hs_${MAX_HARNESS_SESSIONS + 1}`);
  const dup = prependSession(list, { ...list[3], title: 'renamed' });
  assert.equal(dup.length, MAX_HARNESS_SESSIONS);
  assert.equal(dup[0].title, 'renamed');
  assert.equal(dup.filter((s) => s.id === list[3].id).length, 1);

  const good = buildHarnessSession(transcript, NOW, 'ok');
  const clean = sanitizeHarnessSessions([
    good,
    { ...good, id: 'ok' },                              // 重复 id
    { ...good, id: 'broken-title', title: 42, usage: null }, // 摘要字段坏 → 重算
    { ...good, id: 'no-items', items: 'nope' },
    { ...good, id: 'empty', items: [] },                // 没有用户消息 → 丢
    { ...good, id: 'bad-at', at: 'x' },
    null, 'garbage',
  ]);
  assert.deepEqual(clean.map((s) => s.id), ['ok', 'broken-title']);
  assert.equal(clean[1].title, good.title);
  assert.deepEqual(clean[1].usage, good.usage);
  assert.deepEqual(sanitizeHarnessSessions('nope'), []);
});

await check('归档: 本会话按模型聚合用量,按合计降序,没有 usage 的回复不算', () => {
  const rows = sessionUsageByModel([...transcript, { kind: 'assistant', id: 'a3', content: 'x', thoughts: '', streaming: false, model: 'gpt-4.1', at: NOW }]);
  assert.deepEqual(rows.map((r) => [r.model, r.requests]), [['claude', 1], ['gpt-4.1', 1]]);
  assert.deepEqual(rows[1].usage, usage(100, 20, 30));
});

console.log(`\n${checks} 项 agent 会话 / 账本校验全部通过。`);
