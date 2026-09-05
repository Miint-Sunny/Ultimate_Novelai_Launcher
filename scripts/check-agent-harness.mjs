#!/usr/bin/env node
// Agent harness 核心的校验:钉住从 Novelai-harness 逐条搬来的语义,以及契约 §5 的权限闸。
//
// 运行: node --experimental-strip-types scripts/check-agent-harness.mjs
//
// 这层的错法全是「不报错但行为变了」:思考标签被拆到两个 chunk 时漏字、工具参数拼错、
// 退避次数不对、旧图每轮都灌给模型、压缩切在工具结果上把协议切坏、该问的没问。

import assert from 'node:assert/strict';

// 同 check-v5-parity:先装 vite 风格的无扩展名解析钩子,再 import 前端模块。
await import('./lib/load-frontend-module.mjs');

const H = await import('../src/services/agentHarness/index.ts');
const {
  parseOpenAiStream, linesFromText, resolveThinkingFormat, thinkingParams,
  buildAgentChatBody, createSidecarLlmProvider, clampPromptCacheKey,
  ToolRegistry, AgentHarness, DEFAULT_PERMISSION_LIMITS, denialToolText, lockedFieldsToolText,
  messageToOpenAi, createMessage, withVisionImagesCollapsed,
} = H;

let checks = 0;
const check = async (name, fn) => {
  checks += 1;
  try { await fn(); console.log(`ok ${checks} - ${name}`); }
  catch (error) { console.error(`not ok ${checks} - ${name}`); throw error; }
};
const collect = async (gen) => { const out = []; for await (const e of gen) out.push(e); return out; };
const sse = (...objs) => objs.map((o) => (typeof o === 'string' ? o : `data: ${JSON.stringify(o)}`)).join('\n\n') + '\n\n';
const chunk = (delta, extra = {}) => ({ id: 'c', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: null }], ...extra });

// ---- 1. 流解析 ----

await check('流解析: 思考字段按 reasoning_content → reasoning → reasoning_text 短路取第一个', async () => {
  const events = await collect(parseOpenAiStream(linesFromText(sse(
    chunk({ reasoning_content: 'A', reasoning: 'B' }),
    chunk({ reasoning: 'C' }),
    'data: [DONE]',
  ))));
  assert.deepEqual(events.map((e) => e.delta), ['A', 'C']);
  assert.ok(events.every((e) => e.type === 'thought_delta'));
});

await check('流解析: <think> 标签被拆到多个 chunk 时不漏字、不错归类', async () => {
  const events = await collect(parseOpenAiStream(linesFromText(sse(
    chunk({ content: 'pre<thi' }),
    chunk({ content: 'nk>hidden</th' }),
    chunk({ content: 'ink>visible<th' }),
    'data: [DONE]',
  ))));
  const thoughts = events.filter((e) => e.type === 'thought_delta').map((e) => e.delta).join('');
  const content = events.filter((e) => e.type === 'content_delta').map((e) => e.delta).join('');
  assert.equal(thoughts, 'hidden');
  assert.equal(content, 'previsible<th');
});

await check('流解析: tool_calls 按 index 跨 chunk 累积,流结束后按 index 顺序发出,参数解析成对象', async () => {
  const events = await collect(parseOpenAiStream(linesFromText(sse(
    chunk({ tool_calls: [{ index: 1, id: 'call_b', function: { name: 'novelai_', arguments: '{"a":' } }] }),
    chunk({ tool_calls: [{ index: 0, id: 'call_a', function: { name: 'get_studio_parameters', arguments: '{}' } }] }),
    chunk({ tool_calls: [{ index: 1, function: { name: 'generate', arguments: '1}' } }] }),
    { id: 'c', object: 'chat.completion.chunk', choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 4 } } },
    'data: [DONE]',
    chunk({ content: 'after done, ignored' }),
  ))));
  const calls = events.filter((e) => e.type === 'tool_call').map((e) => e.toolCall);
  assert.deepEqual(calls, [
    { id: 'call_a', name: 'get_studio_parameters', arguments: {} },
    { id: 'call_b', name: 'novelai_generate', arguments: { a: 1 } },
  ]);
  const usage = events.find((e) => e.type === 'usage').usage;
  assert.deepEqual(usage, { input: 10, output: 5, cacheRead: 4, cacheWrite: 0 });
  assert.ok(!events.some((e) => e.type === 'content_delta'), '[DONE] 之后的内容不能再出来');
});

await check('流解析: 参数不是合法 JSON 时给空对象,让工具自己报参数错', async () => {
  const events = await collect(parseOpenAiStream(linesFromText(sse(
    chunk({ tool_calls: [{ index: 0, id: 'x', function: { name: 'ask_user', arguments: '{oops' } }] }),
    'data: [DONE]',
  ))));
  assert.deepEqual(events[0].toolCall.arguments, {});
});

await check('流解析: sidecar 的 error 事件按 retryable 分瞬态,并终止流;degraded 事件透传', async () => {
  const transient = await collect(parseOpenAiStream(linesFromText(
    'event: degraded\ndata: {"reason":"llm_backup","slot":"backup"}\n\n'
    + sse(chunk({ content: 'hi' }))
    + 'event: error\ndata: {"code":"llm_stream_interrupted","message":"boom","retryable":true}\n\n'
    + sse(chunk({ content: 'never' })),
  )));
  assert.deepEqual(transient.map((e) => e.type), ['degraded', 'content_delta', 'error']);
  assert.equal(transient[0].slot, 'backup');
  assert.equal(transient[2].transient, true);
  const fatal = await collect(parseOpenAiStream(linesFromText('event: error\ndata: {"message":"bad","retryable":false}\n\n')));
  assert.equal(fatal[0].transient, false);
});

// ---- 2. 思考参数矩阵 ----

await check('思考矩阵: 域名识别与各格式字段照抄', () => {
  assert.equal(resolveThinkingFormat('https://api.deepseek.com/v1'), 'deepseek');
  assert.equal(resolveThinkingFormat('https://dashscope.aliyuncs.com/compatible-mode/v1'), 'qwen');
  assert.equal(resolveThinkingFormat('https://open.bigmodel.cn/api/paas/v4'), 'zai');
  assert.equal(resolveThinkingFormat('https://openrouter.ai/api/v1'), 'openrouter');
  assert.equal(resolveThinkingFormat('https://api.together.ai/v1'), 'together');
  assert.equal(resolveThinkingFormat('https://api.openai.com/v1'), 'openai');
  assert.equal(resolveThinkingFormat('https://api.openai.com/v1', 'zai'), 'zai');
  assert.deepEqual(thinkingParams('deepseek', true, 'high'), { extraBody: { thinking: { type: 'enabled' } }, reasoningEffort: 'high' });
  assert.deepEqual(thinkingParams('deepseek', false, 'high'), { extraBody: { thinking: { type: 'disabled' } } });
  assert.deepEqual(thinkingParams('qwen', false, 'low'), { extraBody: { enable_thinking: false } });
  assert.deepEqual(thinkingParams('zai', true, 'medium'), { extraBody: { thinking: { type: 'enabled', clear_thinking: false } }, reasoningEffort: 'medium' });
  assert.deepEqual(thinkingParams('openrouter', false, 'high'), { extraBody: { reasoning: { effort: 'none' } } });
  assert.deepEqual(thinkingParams('together', true, 'low'), { extraBody: { reasoning: { enabled: true } }, reasoningEffort: 'low' });
  assert.deepEqual(thinkingParams('openai', true, 'high'), { extraBody: {}, reasoningEffort: 'high' });
  assert.deepEqual(thinkingParams('openai', true, ''), { extraBody: {} }, '没有 effort = 模型不会思考,什么都不发');
});

// ---- 3. provider / 请求体 ----

const sampleTool = { name: 'get_studio_parameters', label: '读参数', description: 'd', parameters: { type: 'object', properties: {} }, permissionClass: 'R', execute: async () => ({ toolCallId: '', content: '' }) };

await check('请求体: 没有 model 字段;工具带 tool_choice;思考开关进 extra_body;缓存键截到 64', () => {
  const body = buildAgentChatBody(
    { messages: [createMessage({ id: 'u', role: 'user', content: 'hi' })], tools: [sampleTool], promptCacheKey: 'k'.repeat(80) },
    { fetchImpl: async () => new Response(''), llmBaseUrl: 'https://api.deepseek.com/v1', reasoning: true, thinkingEffort: 'high' },
  );
  assert.ok(!('model' in body));
  assert.equal(body.tool_choice, 'auto');
  assert.equal(body.tools[0].function.name, 'get_studio_parameters');
  assert.deepEqual(body.extra_body, { thinking: { type: 'enabled' } });
  assert.equal(body.reasoning_effort, 'high');
  assert.equal(body.prompt_cache_key.length, 64);
  assert.equal(clampPromptCacheKey(undefined), undefined);
});

await check('消息编码: 工具结果带图升级成多模态块;用户图片同理;折叠替身去图加占位', () => {
  const tool = messageToOpenAi(createMessage({ id: 't', role: 'tool', content: 'ok', toolCallId: 'c1', imageBase64: 'AAAA', imageMimeType: 'image/png' }));
  assert.equal(tool.tool_call_id, 'c1');
  assert.equal(tool.content[1].image_url.url, 'data:image/png;base64,AAAA');
  const user = createMessage({ id: 'u', role: 'user', content: 'look', images: [{ base64: 'BBBB', mimeType: 'image/jpeg' }] });
  assert.equal(messageToOpenAi(user).content[1].image_url.url, 'data:image/jpeg;base64,BBBB');
  const collapsed = withVisionImagesCollapsed(user, '[X]');
  assert.deepEqual(collapsed.images, []);
  assert.equal(messageToOpenAi(collapsed).content, 'look\n\n[X]');
});

await check('provider: 流前 Problem Details 按 retryable 分瞬态;401/422 永不重试;200 流正常解析并记下模型名', async () => {
  const mk = (status, body, headers = {}) => async () => new Response(body, { status, headers });
  const opts = (fetchImpl) => ({ fetchImpl, llmBaseUrl: 'https://api.openai.com/v1' });
  const req = { messages: [createMessage({ id: 'u', role: 'user', content: 'hi' })], tools: [] };
  const e503 = await collect(createSidecarLlmProvider(opts(mk(503, JSON.stringify({ code: 'llm_upstream_failed', message: 'x', retryable: true })))).streamChat(req));
  assert.equal(e503[0].type, 'error'); assert.equal(e503[0].transient, true);
  const e422 = await collect(createSidecarLlmProvider(opts(mk(422, JSON.stringify({ code: 'validation_failed', message: 'x', retryable: true })))).streamChat(req));
  assert.equal(e422[0].transient, false);
  const e401 = await collect(createSidecarLlmProvider(opts(mk(401, '{"code":"authentication_required"}'))).streamChat(req));
  assert.equal(e401[0].transient, false);
  const provider = createSidecarLlmProvider(opts(mk(200, sse(chunk({ content: 'hey' }), 'data: [DONE]'), { 'X-Llm-Model': 'gpt-x' })));
  const ok = await collect(provider.streamChat(req));
  assert.deepEqual(ok, [{ type: 'content_delta', delta: 'hey' }]);
  assert.equal(provider.modelId, 'gpt-x');
  const netErr = await collect(createSidecarLlmProvider(opts(async () => { throw new Error('ECONNRESET'); })).streamChat(req));
  assert.equal(netErr[0].transient, true);
});

// ---- 4. harness 循环 ----

function scriptedProvider(scripts) {
  const calls = [];
  return {
    calls,
    modelId: 'fake-model',
    async *streamChat(opts) {
      calls.push({ messages: opts.messages, tools: opts.tools });
      const script = scripts.shift() ?? [];
      for (const ev of script) yield ev;
    },
  };
}
const text = (s) => [{ type: 'content_delta', delta: s }];
const callTool = (name, args = {}, id = `call_${name}`) => [{ type: 'tool_call', toolCall: { id, name, arguments: args } }];
const sleeps = [];
const fastSleep = async (ms) => { sleeps.push(ms); };
const PRESET = { id: 'p', name: 'p', systemPrompt: 'SYS', enabledToolNames: ['get_studio_parameters', 'update_studio_parameters', 'novelai_generate', 'delete_prompt_library_entry', 'ask_user'], allowedModifiableParams: ['prompt'], enabledSkillIds: [] };
function makeTools(extra = {}) {
  const registry = new ToolRegistry();
  registry.register({ ...sampleTool, execute: async (id) => ({ toolCallId: id, content: 'params: {}' }) });
  registry.register({
    name: 'update_studio_parameters', label: '修改参数', description: 'd', parameters: { type: 'object', properties: {} }, permissionClass: 'W',
    writesFields: (args) => Object.keys(args), describeChange: async (args) => `改 ${Object.keys(args).join(',')}`,
    execute: async (id, args) => ({ toolCallId: id, content: `updated ${JSON.stringify(args)}` }),
  });
  registry.register({
    name: 'novelai_generate', label: '生成', description: 'd', parameters: { type: 'object', properties: {} }, permissionClass: 'P', countsAsGeneration: true,
    estimateCost: async () => extra.cost ?? { anlas: 0, free: true },
    execute: async (id) => ({ toolCallId: id, content: 'generated' }),
  });
  registry.register({ name: 'delete_prompt_library_entry', label: '删条目', description: 'd', parameters: { type: 'object', properties: {} }, permissionClass: 'D', execute: async (id) => ({ toolCallId: id, content: 'deleted' }) });
  registry.register({ name: 'secret_tool', label: '不在白名单', description: 'd', parameters: { type: 'object', properties: {} }, permissionClass: 'R', execute: async (id) => ({ toolCallId: id, content: 'leak' }) });
  return registry;
}
const harnessWith = (provider, opts = {}) => new AgentHarness({ tools: makeTools(opts), provider, preset: PRESET, sleep: fastSleep, retryBaseDelayMs: 1000, ...opts });

await check('循环: 瞬态错误按 1s/2s 退避重试,第三次成功;retry 事件计到 attempt 2、3', async () => {
  sleeps.length = 0;
  const p = scriptedProvider([[{ type: 'error', error: 'net', transient: true }], [{ type: 'error', error: 'net', transient: true }], text('done')]);
  const events = await collect(harnessWith(p).send('hi'));
  const retries = events.filter((e) => e.type === 'retry');
  assert.deepEqual(retries.map((r) => [r.attempt, r.delayMs]), [[2, 1000], [3, 2000]]);
  assert.deepEqual(sleeps, [1000, 2000]);
  assert.equal(events.at(-1).type, 'turn_end');
  assert.equal(events.at(-1).finalMessage.content, 'done');
});

await check('循环: 非瞬态错误直接终止,不重试;半截内容不落盘', async () => {
  const p = scriptedProvider([[{ type: 'content_delta', delta: 'half' }, { type: 'error', error: 'validation_failed', transient: false }]]);
  const h = harnessWith(p);
  const events = await collect(h.send('hi'));
  assert.equal(p.calls.length, 1);
  assert.equal(events.at(-1).type, 'error');
  assert.equal(h.messages.length, 1, '只有用户消息落盘');
});

await check('循环: 连续 3 次空响应报错终止', async () => {
  const p = scriptedProvider([[], [], []]);
  const events = await collect(harnessWith(p).send('hi'));
  assert.equal(events.filter((e) => e.type === 'retry').length, 2);
  assert.match(events.at(-1).error, /空响应/);
});

await check('循环: 工具调用 → 执行 → 结果进上下文 → 再问模型 → 收尾;未知工具与白名单外工具报错而不执行', async () => {
  const p = scriptedProvider([callTool('get_studio_parameters'), callTool('nope'), callTool('secret_tool'), text('final')]);
  const h = harnessWith(p);
  const events = await collect(h.send('hi'));
  const results = events.filter((e) => e.type === 'tool_result').map((e) => e.result);
  assert.equal(results[0].content, 'params: {}');
  assert.match(results[1].content, /未知工具/);
  assert.match(results[2].content, /未开放/);
  assert.equal(h.messages.map((m) => m.role).join(','), 'user,assistant,tool,assistant,tool,assistant,tool,assistant');
  assert.ok(!p.calls[0].tools.some((t) => t.name === 'secret_tool'), '白名单外的工具不出现在 tools 里');
  assert.equal(events.at(-1).finalMessage.content, 'final');
});

await check('循环: 到 maxTurns 注入收尾提示,下一轮不带工具,模型再要工具也直接结束', async () => {
  const p = scriptedProvider([callTool('get_studio_parameters'), [...callTool('get_studio_parameters'), ...text('wrap')]]);
  const h = harnessWith(p, { maxTurns: 1 });
  const events = await collect(h.send('hi'));
  assert.equal(p.calls[1].tools.length, 0);
  assert.match(h.messages.find((m) => m.id.startsWith('limit_')).content, /上限 \(1 轮\)/);
  assert.equal(events.at(-1).type, 'turn_end');
  assert.equal(events.filter((e) => e.type === 'tool_result').length, 1, '收尾轮里的工具调用不执行');
});

await check('图片: 只有本轮的图片发给模型,更早轮次的折叠成占位符;恢复的历史消息 epoch 为 0', async () => {
  const p = scriptedProvider([text('a'), text('b')]);
  const h = harnessWith(p);
  await collect(h.send('one', { images: [{ base64: 'IMG1', mimeType: 'image/png' }] }));
  const first = p.calls[0].messages.find((m) => m.role === 'user');
  assert.equal(first.images.length, 1);
  await collect(h.send('two'));
  const collapsed = p.calls[1].messages.filter((m) => m.role === 'user');
  assert.equal(collapsed[0].images.length, 0);
  assert.match(collapsed[0].content, /view_canvas_image/);
  h.restoreMessages([createMessage({ id: 'old', role: 'user', content: 'x', images: [{ base64: 'Z', mimeType: 'image/png' }], imageEpoch: 99 })]);
  assert.equal(h.messages.at(-1).imageEpoch, 0);
});

// ---- 5. 权限闸 ----

const runWithDecision = async (h, script, decide) => {
  const events = [];
  const gen = h.send('do');
  let step = await gen.next();
  while (!step.done) {
    const e = step.value; events.push(e);
    if (e.type === 'permission_request' && decide) decide(e.request);
    step = await gen.next();
  }
  return events;
};

await check('权限: manual 下 W 类要问;允许则执行,拒绝则以固定文案回给模型', async () => {
  const p1 = scriptedProvider([callTool('update_studio_parameters', { prompt: 'x' }), text('ok')]);
  const e1 = await runWithDecision(harnessWith(p1, { permissionMode: () => 'manual' }), null, (req) => { assert.equal(req.summary, '改 prompt'); req.respond({ kind: 'allow' }); });
  assert.equal(e1.find((e) => e.type === 'tool_result').result.content, 'updated {"prompt":"x"}');
  const p2 = scriptedProvider([callTool('update_studio_parameters', { prompt: 'x' }), text('ok')]);
  const e2 = await runWithDecision(harnessWith(p2, { permissionMode: () => 'manual' }), null, (req) => req.respond({ kind: 'deny', reason: '别动' }));
  assert.equal(e2.find((e) => e.type === 'tool_result').result.content, denialToolText('update_studio_parameters', '别动'));
  assert.ok(e2.some((e) => e.type === 'permission_result' && e.decision.kind === 'deny'));
});

await check('权限: auto 下 W 自动、D 要问;「本轮同类都允许」后同类不再问', async () => {
  const p = scriptedProvider([
    [...callTool('update_studio_parameters', { prompt: 'x' }, 'c1'), ...callTool('delete_prompt_library_entry', { id: '1' }, 'c2'), ...callTool('delete_prompt_library_entry', { id: '2' }, 'c3')],
    text('ok'),
  ]);
  let asks = 0;
  const events = await runWithDecision(harnessWith(p), null, (req) => { asks += 1; assert.equal(req.permissionClass, 'D'); req.respond({ kind: 'allow-class' }); });
  assert.equal(asks, 1);
  assert.equal(events.filter((e) => e.type === 'tool_result').length, 3);
});

await check('权限: P 类——免费在 auto 下也要问;yolo 免费放行;yolo 超预算要问;体力条耗尽一律问', async () => {
  const run = async (mode, cost, exhausted = false) => {
    let asked = false;
    const p = scriptedProvider([callTool('novelai_generate'), text('ok')]);
    await runWithDecision(harnessWith(p, { permissionMode: () => mode, cost, opusExhausted: () => exhausted }), null, (req) => { asked = true; req.respond({ kind: 'allow' }); });
    return asked;
  };
  assert.equal(await run('auto', { anlas: 0, free: true }), true);
  assert.equal(await run('yolo', { anlas: 0, free: true }), false);
  assert.equal(await run('yolo', { anlas: 30, free: false }), true);
  assert.equal(await run('yolo', { anlas: 0, free: true }, true), true);
});

await check('权限: 生成次数到上限直接拒绝(yolo 也算);参数锁在任何模式都拒绝且不问', async () => {
  const gens = Array.from({ length: 4 }, (_, i) => callTool('novelai_generate', {}, `g${i}`)).flat();
  const p = scriptedProvider([gens, text('ok')]);
  let asks = 0;
  const events = await runWithDecision(harnessWith(p, { permissionMode: () => 'yolo' }), null, () => { asks += 1; });
  const results = events.filter((e) => e.type === 'tool_result').map((e) => e.result);
  assert.equal(results.filter((r) => r.content === 'generated').length, DEFAULT_PERMISSION_LIMITS.maxGenerationsPerMessage);
  assert.match(results[3].content, /生成次数已达上限/);
  assert.equal(asks, 0);
  const p2 = scriptedProvider([callTool('update_studio_parameters', { prompt: 'x', steps: 5 }), text('ok')]);
  const e2 = await runWithDecision(harnessWith(p2, { permissionMode: () => 'yolo', lockedFields: () => new Set(['steps']) }), null, () => { throw new Error('不该问'); });
  assert.equal(e2.find((e) => e.type === 'tool_result').result.content, lockedFieldsToolText(['steps']));
});

await check('权限: 确认超时按拒绝', async () => {
  const p = scriptedProvider([callTool('delete_prompt_library_entry', { id: '1' }), text('ok')]);
  const events = await runWithDecision(harnessWith(p, { permissionTimeoutMs: 1 }), null, () => { /* 不回答 */ });
  assert.match(events.find((e) => e.type === 'tool_result').result.content, /确认超时/);
});

// ---- 6. 压缩 ----

await check('压缩: 超窗时用当前模型生成摘要,之后的请求带摘要且从切点开始;切点绝不落在工具结果上', async () => {
  const p = scriptedProvider([]);
  const h = harnessWith(p, { contextWindowTokens: 1, compactionReserveTokens: 0, compactionKeepRecentTokens: 1 });
  h.setMessages([
    createMessage({ id: 'u1', role: 'user', content: 'x'.repeat(400) }),
    createMessage({ id: 'a1', role: 'assistant', content: 'call', toolCalls: [{ id: 'c', name: 'get_studio_parameters', arguments: {} }] }),
    createMessage({ id: 't1', role: 'tool', content: 'y'.repeat(400), toolCallId: 'c', toolName: 'get_studio_parameters' }),
    createMessage({ id: 'a2', role: 'assistant', content: 'z'.repeat(400) }),
  ]);
  p.calls.length = 0;
  // 摘要请求 + 本轮回答
  const scripts = [text('## 目标\n摘要'), text('answer')];
  p.streamChat = async function* (opts) { p.calls.push(opts); const s = scripts.shift() ?? []; for (const e of s) yield e; };
  const events = await collect(h.send('next'));
  const compaction = events.find((e) => e.type === 'compaction');
  assert.ok(compaction, '应触发压缩');
  assert.equal(compaction.summary, '## 目标\n摘要');
  assert.equal(p.calls[0].tools.length, 0, '摘要请求不带工具');
  const req = p.calls[1].messages;
  assert.equal(req[1].id, 'compaction_summary');
  assert.ok(!req.some((m) => m.id === 'u1'), '切点之前的消息不再发');
  assert.notEqual(req[2].role, 'tool', '切点不能落在工具结果上');
  // 4 条既有 + 本轮 user + 本轮 assistant;压缩只改请求窗口,不删消息。
  assert.equal(h.messages.length, 6, '原始消息仍全部保留');
});

await check('压缩: 摘要失败不改上下文;强制压缩保留最后一个 user 轮次;回退到窗口之外重置压缩', async () => {
  const failing = { modelId: 'f', async *streamChat() { yield { type: 'error', error: 'x', transient: false }; } };
  const h = harnessWith(failing, { compactionKeepRecentTokens: 1 });
  h.setMessages([createMessage({ id: 'u1', role: 'user', content: 'a'.repeat(400) }), createMessage({ id: 'a1', role: 'assistant', content: 'b' }), createMessage({ id: 'u2', role: 'user', content: 'c' })]);
  assert.equal(await h.compactContext(true), null);
  assert.equal(h.isCompacted, false);
  const ok = { modelId: 'o', async *streamChat() { yield { type: 'content_delta', delta: 'S' }; } };
  const h2 = harnessWith(ok);
  h2.setMessages([createMessage({ id: 'u1', role: 'user', content: 'a' }), createMessage({ id: 'a1', role: 'assistant', content: 'b' }), createMessage({ id: 'u2', role: 'user', content: 'c' })]);
  const evt = await h2.compactContext(true);
  assert.equal(evt.summary, 'S');
  assert.equal(h2.buildRequestMessages('S')[2].id, 'u2', '强制压缩后从最后一个 user 轮次开始');
  assert.equal(h2.rewindToMessage('u1'), true);
  assert.equal(h2.isCompacted, false);
  assert.equal(h2.messages.length, 1);
});

await check('回溯: send 可指定用户消息 id;rewindBeforeMessage 连同该消息一起截掉,回到压缩窗口之前则重置压缩', async () => {
  const p = scriptedProvider([text('one'), text('two')]);
  const h = harnessWith(p);
  for await (const _ of h.send('first', { id: 'u_custom_1' })) { /* drain */ }
  for await (const _ of h.send('second', { id: 'u_custom_2' })) { /* drain */ }
  assert.deepEqual(h.messages.map((m) => m.id).filter((id) => id.startsWith('u_')), ['u_custom_1', 'u_custom_2']);
  assert.equal(h.messages.length, 4);
  assert.equal(h.rewindBeforeMessage('nope'), false);
  assert.equal(h.rewindBeforeMessage('u_custom_2'), true);
  assert.deepEqual(h.messages.map((m) => m.content), ['first', 'one'], '目标消息本身也不留');
  assert.equal(h.rewindBeforeMessage('u_custom_1'), true);
  assert.equal(h.messages.length, 0);
});

await check('预设库: 内置永远在;新建/复制/删除/切换;内置不可删可 reset;技能启停含父子继承;SKILL.md 进出对称', async () => {
  const L = await import('../src/services/agentHarness/presetLibrary.ts');
  const base = L.defaultPresetLibrary();
  assert.equal(base.presets.length, 1);
  assert.equal(L.resolveActivePreset(base).id, base.activeId);
  const created = L.createPreset(base, '试验');
  assert.equal(created.presets.length, 2);
  assert.equal(L.resolveActivePreset(created).name, '试验');
  const again = L.createPreset(created, '试验');
  assert.equal(L.resolveActivePreset(again).name, '试验 2', '重名自动编号');
  const dup = L.duplicatePreset(again, again.activeId);
  assert.equal(L.resolveActivePreset(dup).name, '试验 2 副本');
  const builtinId = base.presets[0].id;
  assert.equal(L.removePreset(dup, builtinId), dup, '内置不能删');
  const edited = L.upsertPreset(dup, { ...L.resolveActivePreset(L.setActivePreset(dup, builtinId)), systemPrompt: 'changed', enabledToolNames: [] });
  assert.equal(edited.presets.find((p) => p.id === builtinId).systemPrompt, 'changed');
  const reset = L.resetBuiltinPreset(edited, builtinId);
  assert.notEqual(reset.presets.find((p) => p.id === builtinId).systemPrompt, 'changed');
  assert.ok(reset.presets.find((p) => p.id === builtinId).enabledToolNames.length > 10, 'reset 回出厂工具表');
  const removed = L.removePreset(dup, dup.activeId);
  assert.equal(removed.presets.length, dup.presets.length - 1);
  assert.equal(removed.activeId, removed.presets[0].id, '删掉当前预设后切到第一个');
  assert.deepEqual(L.toggleId(['a'], 'b', true), ['a', 'b']);
  assert.deepEqual(L.toggleId(['a', 'b'], 'a', false), ['b']);
  assert.equal(L.isSkillEnabled('nai5-prompting/通用写法', ['nai5-prompting']), true);
  assert.equal(L.inheritsFromParent('nai5-prompting/通用写法', ['nai5-prompting']), true);
  assert.equal(L.inheritsFromParent('nai5-prompting', ['nai5-prompting']), false);
  const md = '---\nname: "我的技能"\ndescription: 什么时候用\n---\n\n# 正文\n内容';
  const skill = L.parseSkillMarkdown(md, 'fallback.md');
  assert.deepEqual(skill, { id: '我的技能', name: '我的技能', description: '什么时候用', systemPrompt: '# 正文\n内容' });
  const round = L.parseSkillMarkdown(L.skillToMarkdown(skill), 'x.md');
  assert.deepEqual(round, skill, '导出再导入不变');
  const plain = L.parseSkillMarkdown('no frontmatter body', 'My Skill.md');
  assert.equal(plain.id, 'my-skill'); assert.equal(plain.name, 'My Skill'); assert.equal(plain.systemPrompt, 'no frontmatter body');
  const withSkill = L.upsertUserSkill(L.upsertPreset(base, { ...base.presets[0], enabledSkillIds: ['nai5-prompting', 'my-skill'] }), plain);
  assert.equal(withSkill.userSkills.length, 1);
  const without = L.removeUserSkill(withSkill, 'my-skill');
  assert.deepEqual(without.presets[0].enabledSkillIds, ['nai5-prompting'], '删技能时从预设名单摘掉');
  const sanitized = L.sanitizePresetLibrary({ presets: [{ id: 'u1', name: 'u', enabledToolNames: ['x', 3], allowedModifiableParams: ['steps', 'nope'] }], activeId: 'ghost', userSkills: [{ id: 's', systemPrompt: 'p' }, { bad: true }] });
  assert.equal(sanitized.presets[0].id, builtinId, '内置预设补回最前');
  assert.deepEqual(sanitized.presets[1].enabledToolNames, ['x']);
  assert.deepEqual(sanitized.presets[1].allowedModifiableParams, ['steps'], '未知参数键丢弃');
  assert.equal(sanitized.activeId, builtinId, '悬空 activeId 退回第一个');
  assert.equal(sanitized.userSkills.length, 1);
  assert.equal(L.sanitizePresetLibrary('garbage').presets.length, 1);
});

await check('工具目录: listWorkbenchTools 不需要真依赖,列出 19 个带标签与权限类的工具', async () => {
  const { listWorkbenchTools } = await import('../src/services/agentHarness/tools/index.ts');
  const tools = listWorkbenchTools();
  assert.equal(tools.length, 19);
  assert.ok(tools.every((t) => t.label && ['R', 'W', 'D', 'P', 'A'].includes(t.permissionClass)));
});

console.log(`\n${checks} 项 agent harness 校验全部通过。`);
