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
  encodePreset, decodePresets, PresetImportError,
  stripReplyMarkers, ReplyMarkerStreamFilter, ContextMemory, createContextMemoryTool, estimateTextTokens,
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
  // Pi 口径:prompt_tokens 含缓存,input 只算未命中的 6;cached_tokens 报告了就算报告了。
  const usage = events.find((e) => e.type === 'usage').usage;
  assert.deepEqual(usage, { input: 6, output: 5, cacheRead: 4, cacheWrite: 0, cacheReadReported: true });
  assert.ok(!events.some((e) => e.type === 'content_delta'), '[DONE] 之后的内容不能再出来');
});

await check('流解析: usage 逐 chunk 覆盖(last-wins),整条流只发一次;choice.usage 只在顶层没给时用;中断也发', async () => {
  const events = await collect(parseOpenAiStream(linesFromText(sse(
    { id: 'c', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: 'a' }, finish_reason: null, usage: { prompt_tokens: 3, completion_tokens: 1 } }], usage: { prompt_tokens: 100, completion_tokens: 1 } },
    { id: 'c', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: 'b' }, finish_reason: null }], usage: { prompt_tokens: 100, completion_tokens: 2 } },
    { id: 'c', object: 'chat.completion.chunk', choices: [], usage: { prompt_tokens: 100, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 40 } } },
    'data: [DONE]',
  ))));
  const usages = events.filter((e) => e.type === 'usage');
  assert.equal(usages.length, 1, '一条流只记一次账');
  assert.deepEqual(usages[0].usage, { input: 60, output: 3, cacheRead: 40, cacheWrite: 0, cacheReadReported: true });
  assert.equal(events.findIndex((e) => e.type === 'usage') > events.findIndex((e) => e.type === 'content_delta'), true, 'usage 在内容之后、流尾发出');
  const moonshot = await collect(parseOpenAiStream(linesFromText(sse(
    { id: 'c', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: 'x' }, finish_reason: 'stop', usage: { prompt_tokens: 7, completion_tokens: 2 } }] },
    'data: [DONE]',
  ))));
  assert.deepEqual(moonshot.find((e) => e.type === 'usage').usage, { input: 7, output: 2, cacheRead: 0, cacheWrite: 0, cacheReadReported: false });
  const broken = await collect(parseOpenAiStream(linesFromText(sse(
    { id: 'c', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: 'x' }, finish_reason: null }], usage: { prompt_tokens: 9, completion_tokens: 1 } },
    `event: error\ndata: ${JSON.stringify({ message: 'upstream reset', retryable: true })}`,
  ))));
  assert.equal(broken.filter((e) => e.type === 'usage').length, 1, '中断前已花掉的 token 仍入账');
  assert.equal(broken.at(-1).type, 'error');
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
    { fetchImpl: async () => new Response(''), llmBaseUrl: 'https://api.openai.com/v1', reasoning: true, thinkingEffort: 'high' },
  );
  assert.ok(!('model' in body));
  assert.equal(body.tool_choice, 'auto');
  assert.equal(body.tools[0].function.name, 'get_studio_parameters');
  assert.equal(body.reasoning_effort, 'high');
  assert.equal(body.prompt_cache_key.length, 64);
  assert.equal(clampPromptCacheKey(undefined), undefined);
});

await check('请求体(DeepSeek 官方主机): 带工具时省略 tool_choice,历史 assistant 的思考以 reasoning_content 回传;空思考不补字段;网关转发的 deepseek 不算', () => {
  const history = [
    createMessage({ id: 'u', role: 'user', content: 'hi' }),
    createMessage({ id: 'a1', role: 'assistant', content: '', thoughts: '先看参数', toolCalls: [{ id: 'c1', name: 'get_studio_parameters', arguments: {} }] }),
    createMessage({ id: 't1', role: 'tool', content: 'steps: 28', toolCallId: 'c1', toolName: 'get_studio_parameters' }),
    createMessage({ id: 'a2', role: 'assistant', content: '好了', thoughts: '' }),
  ];
  const ds = buildAgentChatBody({ messages: history, tools: [sampleTool] }, { fetchImpl: async () => new Response(''), llmBaseUrl: 'https://api.deepseek.com/v1', reasoning: true, thinkingEffort: 'high' });
  assert.ok(!('tool_choice' in ds), 'DeepSeek 带工具时不发 tool_choice');
  assert.deepEqual(ds.extra_body, { thinking: { type: 'enabled' } });
  assert.equal(ds.messages[1].reasoning_content, '先看参数');
  assert.ok(!('reasoning_content' in ds.messages[3]), '空思考不臆造');
  assert.ok(!('reasoning_content' in ds.messages[0]));
  const noTools = buildAgentChatBody({ messages: history, tools: [] }, { fetchImpl: async () => new Response(''), llmBaseUrl: 'https://api.deepseek.com/v1' });
  assert.ok(!('reasoning_content' in noTools.messages[1]), '没有工具时保持标准形状');
  const gateway = buildAgentChatBody({ messages: history, tools: [sampleTool] }, { fetchImpl: async () => new Response(''), llmBaseUrl: 'https://my-newapi.example.com/deepseek.com/v1' });
  assert.equal(gateway.tool_choice, 'auto', '只认 api.deepseek.com 这个主机');
  assert.ok(!('reasoning_content' in gateway.messages[1]));
  assert.equal(resolveThinkingFormat('https://api.deepseek.com/v1'), 'deepseek');
  assert.equal(resolveThinkingFormat('https://gateway.example.com/deepseek.com/v1'), 'openai');
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

await check('provider: 云模式换到宿主同形路径并带 model;本地默认路径、无 model', async () => {
  const calls = [];
  const fetchImpl = async (path, init) => { calls.push({ path, body: JSON.parse(init.body) }); return new Response(sse(chunk({ content: 'x' }), 'data: [DONE]'), { status: 200 }); };
  const req = { messages: [createMessage({ id: 'u', role: 'user', content: 'hi' })], tools: [] };
  await collect(createSidecarLlmProvider({ fetchImpl, llmBaseUrl: '', chatPath: '/api/agent/llm/chat', model: 'deepseek' }).streamChat(req));
  assert.equal(calls[0].path, '/api/agent/llm/chat');
  assert.equal(calls[0].body.model, 'deepseek');
  await collect(createSidecarLlmProvider({ fetchImpl, llmBaseUrl: '' }).streamChat(req));
  assert.equal(calls[1].path, '/api/v1/agent/llm/chat');
  assert.equal('model' in calls[1].body, false);
  const e402 = await collect(createSidecarLlmProvider({ fetchImpl: async () => new Response('{"detail":"no quota"}', { status: 402 }), llmBaseUrl: '' }).streamChat(req));
  assert.equal(e402[0].error, 'http_402: no quota');
  assert.equal(e402[0].transient, false, '402 是额度问题,不重试');
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
  // 窗口 500 / 预留 50:压缩前 ~520 token 过硬阈值,压掉 u1..t1 后 ~300 落回窗口内。
  const h = harnessWith(p, { contextWindowTokens: 500, compactionReserveTokens: 50, compactionKeepRecentTokens: 1, backgroundCompactionEnabled: false });
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
  assert.deepEqual(sanitized.presets[1].enabledToolNames, ['x', 'context_memory'], '没记过目录的存档补上后来加的工具');
  assert.deepEqual(sanitized.presets[1].allowedModifiableParams, ['steps'], '未知参数键丢弃');
  assert.equal(sanitized.activeId, builtinId, '悬空 activeId 退回第一个');
  assert.equal(sanitized.userSkills.length, 1);
  assert.equal(L.sanitizePresetLibrary('garbage').presets.length, 1);
});

await check('工具目录: listWorkbenchTools 不需要真依赖,列出 20 个带标签与权限类的工具(含挂在 harness 上的 context_memory)', async () => {
  const { listWorkbenchTools } = await import('../src/services/agentHarness/tools/index.ts');
  const tools = listWorkbenchTools();
  assert.equal(tools.length, 20);
  assert.ok(tools.some((t) => t.name === 'context_memory'));
  assert.ok(tools.every((t) => t.label && ['R', 'W', 'D', 'P', 'A'].includes(t.permissionClass)));
});

// ---- 5. 中断(他 0.5.0 的 ba2845f) ----

await check('中断: 流式期间 abort → 不重试、已流出的内容留在历史、最后一个事件是 aborted、之后能再发', async () => {
  const provider = {
    calls: 0, modelId: 'fake',
    async *streamChat(opts) {
      this.calls += 1;
      yield { type: 'content_delta', delta: 'par' };
      // 卡在网络上,直到 signal 触发才以瞬态错误收场(真实 fetch 被 abort 就是这个形状;已中止的信号立刻抛)。
      if (!opts.signal.aborted) await new Promise((resolve) => opts.signal.addEventListener('abort', resolve, { once: true }));
      yield { type: 'error', error: 'aborted by client', transient: true };
    },
  };
  const h = harnessWith(provider);
  const events = [];
  const gen = h.send('hi');
  for await (const ev of gen) {
    events.push(ev);
    if (ev.type === 'content_delta') {
      assert.equal(h.isRunning, true);
      h.abort();
    }
  }
  assert.equal(events.at(-1).type, 'aborted');
  assert.ok(!events.some((e) => e.type === 'retry'), '中断不算瞬态错误,不能退避重试');
  assert.equal(h.messages.at(-1).role, 'assistant');
  assert.equal(h.messages.at(-1).content, 'par');
  assert.equal(h.isRunning, false);
  assert.equal(provider.calls, 1);
  const again = await collect(harnessWith(scriptedProvider([text('ok')])).send('again'));
  assert.equal(again.at(-1).type, 'turn_end');
});

await check('中断: 工具执行中 abort → 该调用以「用户已中断」收口、剩余调用不执行但都有占位结果、历史合法', async () => {
  const registry = new ToolRegistry();
  let started = 0;
  registry.register({ name: 'slow', label: '慢', description: 'd', parameters: { type: 'object', properties: {} }, permissionClass: 'R',
    execute: () => { started += 1; return new Promise(() => {}); } });
  registry.register({ name: 'fast', label: '快', description: 'd', parameters: { type: 'object', properties: {} }, permissionClass: 'R',
    execute: async (id) => { started += 1; return { toolCallId: id, content: 'fast done' }; } });
  const preset = { ...PRESET, enabledToolNames: ['slow', 'fast'] };
  const provider = scriptedProvider([[...callTool('slow', {}, 'c1'), ...callTool('fast', {}, 'c2')], text('never')]);
  const h = new AgentHarness({ tools: registry, provider, preset, sleep: fastSleep });
  const events = [];
  for await (const ev of h.send('go')) {
    events.push(ev);
    if (ev.type === 'tool_call' && ev.toolCall.id === 'c2') setTimeout(() => h.abort(), 5);
  }
  const results = events.filter((e) => e.type === 'tool_result').map((e) => e.result);
  assert.equal(results.length, 2, '两个调用都要有结果收口');
  assert.match(results[0].content, /用户已中断/);
  assert.equal(results[0].isError, true);
  assert.match(results[1].content, /用户已中断/);
  assert.equal(started, 1, '中断后剩下的调用不再执行');
  assert.equal(events.at(-1).type, 'aborted');
  assert.deepEqual(h.messages.slice(-2).map((m) => [m.role, m.toolCallId]), [['tool', 'c1'], ['tool', 'c2']]);
  assert.equal(provider.calls.length, 1, '中断后不再请求模型');
});

await check('中断: 运行中再 send 直接报错不排队;等确认卡片时 abort 按拒绝收口', async () => {
  const registry = new ToolRegistry();
  registry.register({ name: 'paid', label: '付费', description: 'd', parameters: { type: 'object', properties: {} }, permissionClass: 'P', countsAsGeneration: true,
    estimateCost: async () => ({ anlas: 5, free: false }), execute: async (id) => ({ toolCallId: id, content: 'paid done' }) });
  const preset = { ...PRESET, enabledToolNames: ['paid'] };
  const h = new AgentHarness({ tools: registry, provider: scriptedProvider([callTool('paid', {}, 'c1'), text('x')]), preset, sleep: fastSleep, permissionMode: () => 'manual' });
  const events = [];
  for await (const ev of h.send('go')) {
    events.push(ev);
    if (ev.type === 'permission_request') {
      const dup = await collect(h.send('second'));
      assert.match(dup[0].error, /已在运行/);
      h.abort();
    }
  }
  const decision = events.find((e) => e.type === 'permission_result').decision;
  assert.equal(decision.kind, 'deny');
  assert.match(decision.reason, /中断/);
  assert.equal(events.at(-1).type, 'aborted');
});

// ---- 6. 预设导入导出(他 fork 的 pr-preset-transfer) ----

await check('预设进出: encode/decode 往返;权限字段缺失、未知工具、未知参数键、坏 JSON 都拒收;id 撞了加后缀', () => {
  const json = encodePreset(PRESET);
  const parsed = JSON.parse(json);
  assert.equal(parsed.isBuiltin, false);
  assert.deepEqual(parsed.enabledToolNames, PRESET.enabledToolNames);
  const tools = ['get_studio_parameters', 'update_studio_parameters', 'novelai_generate', 'delete_prompt_library_entry', 'ask_user'];
  const [back] = decodePresets(json, { existingIds: [], availableToolNames: tools });
  assert.deepEqual(back, { id: 'p', name: 'p', systemPrompt: 'SYS', enabledSkillIds: [], enabledToolNames: PRESET.enabledToolNames, allowedModifiableParams: ['prompt'] });
  const [renamed] = decodePresets(json, { existingIds: ['p', 'p-2'], availableToolNames: tools });
  assert.equal(renamed.id, 'p-3');
  const many = decodePresets(`[${json}, ${json}]`, { existingIds: [], availableToolNames: tools });
  assert.deepEqual(many.map((p) => p.id), ['p', 'p-2']);
  const expectCode = (source, code, detail) => {
    try { decodePresets(source, { existingIds: [], availableToolNames: tools }); assert.fail(`应当拒收 ${code}`); }
    catch (error) { assert.ok(error instanceof PresetImportError, String(error)); assert.equal(error.code, code); if (detail) assert.equal(error.detail, detail); }
  };
  expectCode('{oops', 'invalid_json');
  expectCode('[]', 'invalid_json');
  const { enabledToolNames: _dropped, ...noTools } = parsed;
  expectCode(JSON.stringify(noTools), 'invalid_field', 'enabledToolNames');
  expectCode(JSON.stringify({ ...parsed, enabledToolNames: ['secret_tool'] }), 'unknown_tool', 'secret_tool');
  expectCode(JSON.stringify({ ...parsed, allowedModifiableParams: ['anlas'] }), 'unknown_parameter', 'anlas');
  expectCode(JSON.stringify({ ...parsed, name: '  ' }), 'invalid_field', 'name');
});

// ---- 7. 回复编号与上下文记忆(他 0.5.0 的 64b728e / a2ab68c / 015f09b) ----

await check('回复标记: 正文任意位置的变体都全量剥离(加粗 / 全角 / 缺括号 / 残渣),成对的 [3] 不受影响', () => {
  assert.equal(stripReplyMarkers('[回复 #7] 你好'), '你好');
  assert.equal(stripReplyMarkers('**[回复 #7]**\n正文'), '正文');
  assert.equal(stripReplyMarkers('前面 ［回复＃12］ 后面'), '前面后面');
  assert.equal(stripReplyMarkers('[回复 #7 缺右括号'), '缺右括号');
  assert.equal(stripReplyMarkers(']\n正文'), '正文');
  assert.equal(stripReplyMarkers('参考 [3] 与 [4] 都保留'), '参考 [3] 与 [4] 都保留');
  assert.equal(stripReplyMarkers('无标记'), '无标记');
});

await check('回复标记: 流式过滤任意分块都不漏标记、不留孤立括号,输出与全量剥离一致;半个标记扣住等下一块', () => {
  const samples = ['[回复 #12] 你好,世界', '正文 **[回复 #3]** 中间 [回复 #4] 结尾', '开头[回复 #7', '参考 [3] 保留'];
  for (const text of samples) {
    for (const size of [1, 2, 3, 5, 7, 64]) {
      const f = new ReplyMarkerStreamFilter();
      let out = '';
      for (let i = 0; i < text.length; i += size) out += f.add(text.slice(i, i + size));
      out += f.flush();
      // 他的口径:不漏标记、不留孤立括号;加粗标记被逐字切碎时残留的 `**` 是无害正文,允许。
      const norm = (t) => t.replace(/\*\*/g, '').replace(/\s+/g, '');
      assert.equal(norm(out), norm(stripReplyMarkers(text)), `${JSON.stringify(text)} 按 ${size} 分块`);
      assert.ok(!/回复\s*[#＃]/.test(out), '不能漏标记');
      const opens = (out.match(/[\[［]/g) || []).length; const closes = (out.match(/[\]］]/g) || []).length;
      assert.equal(opens, closes, '不能留孤立括号');
    }
  }
  const f = new ReplyMarkerStreamFilter();
  assert.equal(f.add('[回复'), '', '半个标记先扣住');
  assert.equal(f.add(' #2]好'), '好');
});

await check('回复编号: 每条 assistant 领稳定编号;请求侧只带一层 [回复 #N];模型回显的标记入库前剥掉;恢复旧会话补编号并洗正文', async () => {
  const p = scriptedProvider([text('[回复 #1] 第一条'), text('第二条 [回复 #2]')]);
  const h = harnessWith(p);
  await collect(h.send('a'));
  await collect(h.send('b'));
  const replies = h.messages.filter((m) => m.role === 'assistant');
  assert.deepEqual(replies.map((m) => [m.replyNumber, m.content]), [[1, '第一条'], [2, '第二条']]);
  const req = p.calls[1].messages;
  const sent = req.find((m) => m.role === 'assistant');
  assert.equal(sent.content, '[回复 #1]\n第一条');
  assert.equal((sent.content.match(/回复 #/g) || []).length, 1, '请求侧只叠一层');
  const restored = harnessWith(scriptedProvider([]));
  restored.restoreMessages([
    createMessage({ id: 'u', role: 'user', content: 'x' }),
    createMessage({ id: 'a', role: 'assistant', content: '[回复 #5] 旧正文 [回复 #5]' }),
    createMessage({ id: 'u2', role: 'user', content: 'y' }),
    createMessage({ id: 'b', role: 'assistant', content: '新的' }),
  ]);
  assert.deepEqual(restored.messages.filter((m) => m.role === 'assistant').map((m) => [m.replyNumber, m.content]), [[1, '旧正文'], [2, '新的']]);
});

await check('上下文记忆: 笔记以 context_notes 注入;释放的回复在请求里换成占位、其工具结果一起省略;当前轮不能释放;read_reply 读原文', async () => {
  const registry = new ToolRegistry();
  registry.register({ ...sampleTool, execute: async (id) => ({ toolCallId: id, content: 'params: steps=28' }) });
  const preset = { ...PRESET, enabledToolNames: ['get_studio_parameters', 'context_memory'] };
  const p = scriptedProvider([
    [...callTool('get_studio_parameters', {}, 'c1')], text('参数看过了'),   // 回复 #1(带工具)+ #2
    [...callTool('context_memory', { action: 'add_note', texts: ['用户偏好雨夜题材', '步数固定 22'] }, 'c2')], text('记好了'),
    [...callTool('context_memory', { action: 'forget_reply', ids: [1, 5] }, 'c3')], text('释放了'),
    [...callTool('context_memory', { action: 'read_reply', id: 1 }, 'c4')], text('读到了'),
  ]);
  const h = new AgentHarness({ tools: registry, provider: p, preset, sleep: fastSleep, backgroundCompactionEnabled: false });
  registry.register(createContextMemoryTool(() => h));
  await collect(h.send('看参数'));
  const noted = await collect(h.send('记笔记'));
  const noteResult = noted.find((e) => e.type === 'tool_result').result;
  assert.match(noteResult.content, /已保存笔记 #1、#2/);
  assert.equal(h.contextUsage.noteCount, 2);
  const withNotes = h.buildRequestMessages('S');
  const notes = withNotes.find((m) => m.id === 'context_notes');
  assert.ok(notes && notes.content.includes('[笔记 #1] 用户偏好雨夜题材'), '笔记进请求');
  const forgot = await collect(h.send('释放'));
  const forgetResult = forgot.find((e) => e.type === 'tool_result').result;
  assert.match(forgetResult.content, /已释放回复 #1 及其工具结果/);
  assert.match(forgetResult.content, /未释放 #5/);
  const req = h.buildRequestMessages('S');
  const placeholder = req.find((m) => m.role === 'assistant' && m.content.includes('已释放'));
  assert.ok(placeholder, '被释放的回复换成占位');
  assert.ok(!req.some((m) => m.role === 'tool' && m.toolCallId === 'c1'), '释放回复的工具结果不再发');
  assert.ok(!placeholder.toolCalls, '占位不带 tool_calls');
  // 当前轮的回复(最后一条 user 之后)不能释放
  assert.throws(() => h.forgetReplies([h.messages.at(-1).replyNumber]), /属于当前用户轮次/);
  const read = await collect(h.send('读原文'));
  const readResult = read.find((e) => e.type === 'tool_result').result;
  assert.match(readResult.content, /回复 #1 原文:/);
  assert.match(readResult.content, /params: steps=28/, '原文带工具结果');
  // 状态导出 / 恢复:消息 id 对得上才恢复
  const state = h.exportContextState();
  const h2 = new AgentHarness({ tools: registry, provider: p, preset, sleep: fastSleep });
  h2.restoreMessages(h.messages);
  assert.equal(h2.contextUsage.noteCount, 0);
  assert.equal(h2.restoreContextState(state), true);
  assert.equal(h2.contextUsage.noteCount, 2);
  assert.ok(h2.memory.forgottenReplies.has(1));
  const h3 = new AgentHarness({ tools: registry, provider: p, preset, sleep: fastSleep });
  h3.restoreMessages([createMessage({ id: 'other', role: 'user', content: 'x' })]);
  assert.equal(h3.restoreContextState(state), false, '消息序列对不上就不恢复');
});

await check('后台压缩: 过硬阈值七成时后台单飞压缩,主请求不等它;完成后上下文带摘要;到硬阈值压不下去则报错不发超窗请求', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const p = { calls: [], modelId: 'm', async *streamChat(opts) {
    this.calls.push(opts);
    if (opts.tools.length === 0) { await gate; yield { type: 'content_delta', delta: '## 目标\n摘要' }; return; }
    yield { type: 'content_delta', delta: 'ok' };
  } };
  const h = harnessWith(p, { contextWindowTokens: 600, compactionReserveTokens: 50, compactionKeepRecentTokens: 1 });
  h.setMessages([
    createMessage({ id: 'u1', role: 'user', content: 'x'.repeat(600) }),
    createMessage({ id: 'a1', role: 'assistant', content: 'y'.repeat(400) }),
  ]);
  const events = await collect(h.send('next'));
  assert.equal(events.at(-1).type, 'turn_end', '主请求不等后台压缩');
  assert.equal(h.contextUsage.compacting, true);
  const first = h.compactContext();
  assert.equal(h.compactContext(), first, '单飞:进行中的压缩直接复用');
  release();
  await first;
  assert.equal(h.isCompacted, true);
  assert.equal(h.contextUsage.compacting, false);
  assert.equal(h.buildRequestMessages('S')[1].id, 'compaction_summary');
  // 硬阈值:压缩释放不出空间就不发主请求
  const tiny = harnessWith({ modelId: 'm', async *streamChat() { yield { type: 'content_delta', delta: '摘要' }; } }, { contextWindowTokens: 40, compactionReserveTokens: 10 });
  tiny.setMessages([createMessage({ id: 'u1', role: 'user', content: 'x'.repeat(2000) })]);
  const blocked = await collect(tiny.send('next'));
  assert.equal(blocked.at(-1).type, 'error');
  assert.match(blocked.at(-1).error, /上下文超过安全窗口/);
});

await check('后台压缩: 回溯 / 换会话 / 记笔记会作废进行中的压缩,晚到的结果不提交;压缩失败留原文并记错误', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const slow = { modelId: 'm', async *streamChat() { await gate; yield { type: 'content_delta', delta: '## 目标\n摘要' }; } };
  const h = harnessWith(slow, { compactionKeepRecentTokens: 1 });
  h.setMessages([createMessage({ id: 'u1', role: 'user', content: 'a'.repeat(400) }), createMessage({ id: 'a1', role: 'assistant', content: 'b' }), createMessage({ id: 'u2', role: 'user', content: 'c' })]);
  const pending = h.compactContext(true);
  assert.equal(h.contextUsage.compacting, true);
  h.rewindToMessage('a1');
  release();
  assert.equal(await pending, null, '回溯后晚到的摘要不提交');
  assert.equal(h.isCompacted, false);
  assert.equal(h.contextUsage.compacting, false);
  const failing = { modelId: 'f', async *streamChat() { yield { type: 'error', error: 'boom', transient: false }; } };
  const h2 = harnessWith(failing, { compactionKeepRecentTokens: 1 });
  h2.setMessages([createMessage({ id: 'u1', role: 'user', content: 'a'.repeat(400) }), createMessage({ id: 'a1', role: 'assistant', content: 'b' }), createMessage({ id: 'u2', role: 'user', content: 'c' })]);
  assert.equal(await h2.compactContext(true), null);
  assert.match(h2.contextUsage.error, /压缩失败/);
  assert.equal(h2.messages.length, 3, '原文保留');
});

await check('上下文估算: 中文不按 chars/4 低估;有用量锚点时用 total 加其后估算,记忆变动后锚点作废', () => {
  assert.equal(estimateTextTokens('abcd'), 1);
  assert.equal(estimateTextTokens('中文四个字'), 5);
  const h = harnessWith(scriptedProvider([]), { backgroundCompactionEnabled: false });
  h.setMessages([
    createMessage({ id: 'u1', role: 'user', content: 'x'.repeat(4000) }),
    createMessage({ id: 'a1', role: 'assistant', content: 'ok', usage: { input: 900, output: 100, cacheRead: 0, cacheWrite: 0 } }),
    createMessage({ id: 'u2', role: 'user', content: 'y'.repeat(40) }),
  ]);
  // setMessages 把锚点设到末尾,历史用量不算数;先按整份请求估。
  const full = h.estimateContextTokens('S');
  assert.ok(full >= 1000, `整份估算 ${full}`);
  const mem = new ContextMemory();
  assert.equal(mem.addNote('a'), 1);
  assert.throws(() => mem.addNote(''), /1～2000/);
  mem.forgetReply(3);
  const back = new ContextMemory();
  back.restore(mem.toJson());
  assert.deepEqual([...back.notes.entries()], [[1, 'a']]);
  assert.ok(back.forgottenReplies.has(3));
});

await check('预设库读档: 新版本加的工具补进旧存档的每个预设;记过目录之后用户关掉的不再补回', () => {
  const { sanitizePresetLibrary, PHASE_ONE_TOOLS } = H;
  const old = { presets: [{ id: 'v5-architect-preset', name: 'x', systemPrompt: 's', enabledToolNames: ['get_studio_parameters'], allowedModifiableParams: ['prompt'], enabledSkillIds: [] }], activeId: 'v5-architect-preset', userSkills: [] };
  const lib = sanitizePresetLibrary(old);
  assert.deepEqual(lib.presets[0].enabledToolNames, ['get_studio_parameters', 'context_memory'], '没有 knownTools 的旧存档补上 context_memory');
  assert.deepEqual(lib.knownTools, [...PHASE_ONE_TOOLS]);
  const optedOut = sanitizePresetLibrary({ ...old, knownTools: [...PHASE_ONE_TOOLS] });
  assert.deepEqual(optedOut.presets[0].enabledToolNames, ['get_studio_parameters'], '目录记过了就是用户自己关的');
});

console.log(`\n${checks} 项 agent harness 校验全部通过。`);
