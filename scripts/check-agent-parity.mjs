#!/usr/bin/env node
// 助手(Agent)编排对等校验(P2 范围A):直接加载纯装配层 agentOrchestration.ts,
// 用 mock setter 与注入 stub 断言桌面语义基线(切换调用方前后必须一致)。
//
// 运行: node --experimental-strip-types scripts/check-agent-parity.mjs

import assert from 'node:assert/strict';

const {
  mapCurrentCharactersToContext,
  buildAgentContext,
  buildActiveVibesFromAgentResult,
  buildActiveVibesFromIds,
  buildAgentCharacterPrompts,
  applyAgentResultToUI,
  restorePromptSnapshotToUI,
  restoreGeneratedSnapshotToUI,
  runAgent,
} = await import('../src/components/agent/agentOrchestration.ts');

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

const publicVibe = { id: 'pv1', name: 'PubVibe', fileName: 'pub.vibe', defaultStrength: 0.7 };
const localVibe = { id: 'lv1', name: 'LocalVibe', image: 'img', encodings: { v4full: 'enc' }, defaultInfoExtracted: 0.9 };
const sources = {
  vibeFiles: [publicVibe, localVibe],
  artistFiles: [{ id: 'a1', name: 'Artist', prompt: 'by artist' }],
  ocFiles: [{ id: 'o1', name: 'OC', positive: 'oc tag', negative: undefined }],
  roleTags: { r1: { role_en: 'role', role_zh: ['角色'], origin_en: 'origin', origin_zh: ['出处'] } },
  currentPositive: 'pos',
  currentNegative: 'neg',
  currentCharacters: [
    { id: 'c1', positive: 'char tag', negative: '', activeTab: 'prompt', enabled: true, name: '角色A' },
    { id: 'c2', positive: '  ', negative: '', activeTab: 'prompt', enabled: true },
    { id: 'c3', positive: 'disabled', negative: '', activeTab: 'prompt', enabled: false },
  ],
  selectedVibeIds: ['lv1'],
};

// ---- 1. mapCurrentCharactersToContext ----
check('mapCurrentCharactersToContext:enabled+非空过滤、未命名兜底、negative 空串→undefined', () => {
  assert.deepEqual(mapCurrentCharactersToContext(sources.currentCharacters), [
    { name: '角色A', positive: 'char tag', negative: undefined },
  ]);
  assert.deepEqual(
    mapCurrentCharactersToContext([{ id: 'x', positive: 'p', negative: 'n', activeTab: 'prompt', enabled: true }]),
    [{ name: '未命名角色', positive: 'p', negative: 'n' }],
  );
});

// ---- 2. buildAgentContext:全量库 + preState 优先级 ----
{
  const ctx = buildAgentContext(sources);
  check('buildAgentContext:vibes 发全量库(公共+本地)、currentVibes 取当前选中', () => {
    assert.deepEqual(ctx.vibes, [
      { id: 'pv1', name: 'PubVibe', supportedModels: [] },
      { id: 'lv1', name: 'LocalVibe', supportedModels: [] },
    ]);
    assert.deepEqual(ctx.currentVibes, ['lv1']);
    assert.equal(ctx.currentPositive, 'pos');
    assert.equal(ctx.currentNegative, 'neg');
    assert.deepEqual(ctx.currentCharacters, [{ name: '角色A', positive: 'char tag', negative: undefined }]);
    assert.deepEqual(ctx.ocs, [{ id: 'o1', name: 'OC', zhName: 'OC', positive: 'oc tag', negative: '' }]);
  });

  const preCtx = buildAgentContext(sources, {
    positive: 'pre pos',
    negative: 'pre neg',
    characters: [{ name: 'pre角色', positive: 'pre tag' }],
    vibes: ['pv1'],
  });
  check('buildAgentContext:preState 覆盖 current*(含 currentVibes)', () => {
    assert.equal(preCtx.currentPositive, 'pre pos');
    assert.equal(preCtx.currentNegative, 'pre neg');
    assert.deepEqual(preCtx.currentCharacters, [{ name: 'pre角色', positive: 'pre tag' }]);
    assert.deepEqual(preCtx.currentVibes, ['pv1']);
  });

  const preNoVibes = buildAgentContext(sources, {
    positive: 'pre pos',
    negative: 'pre neg',
    characters: [],
  });
  check('buildAgentContext:preState 无 vibes 字段时回落到当前选中', () => {
    assert.deepEqual(preNoVibes.currentVibes, ['lv1']);
  });
}

// ---- 3. buildActiveVibesFromAgentResult ----
{
  const { activeVibes, vibesToLoad, allFiles } = buildActiveVibesFromAgentResult(
    ['pv1', 'lv1', 'missing'],
    [publicVibe],
    [localVibe],
  );
  check('buildActiveVibesFromAgentResult:id 精确匹配、默认 ie/strength、vibesToLoad 判定', () => {
    assert.equal(allFiles.length, 2);
    assert.deepEqual(activeVibes, [
      {
        id: 'pv1', name: 'PubVibe', preview: undefined, image: undefined, encodings: undefined,
        referenceStrength: 0.7, informationExtracted: 0.5, supportedModels: undefined, enabled: true,
      },
      {
        id: 'lv1', name: 'LocalVibe', preview: undefined, image: 'img', encodings: { v4full: 'enc' },
        referenceStrength: 0.5, informationExtracted: 0.9, supportedModels: undefined, enabled: true,
      },
    ]);
    // pv1:公共、fileName 存在、缺 image/encodings → 需回源;lv1 是本地文件不回源
    assert.deepEqual(vibesToLoad, ['pv1']);
  });
}

// ---- 4. buildActiveVibesFromIds / buildAgentCharacterPrompts ----
check('buildActiveVibesFromIds:快照恢复(默认 ie 0.5,非 1)', () => {
  const vibes = buildActiveVibesFromIds(['lv1'], [], [localVibe]);
  assert.equal(vibes[0].informationExtracted, 0.9); // defaultInfoExtracted 优先
  assert.equal(vibes[0].referenceStrength, 0.5);
  const noDefault = buildActiveVibesFromIds(['pv1'], [{ id: 'pv1', name: 'P' }], []);
  assert.equal(noDefault[0].informationExtracted, 0.5);
});

check('buildAgentCharacterPrompts:position 空串、name 兜底 角色N、activeTab prompt', () => {
  const result = buildAgentCharacterPrompts([
    { name: 'A', positive: 'p1', negative: 'n1' },
    { positive: 'p2' },
  ]);
  assert.equal(result[0].position, '');
  assert.equal(result[0].name, 'A');
  assert.equal(result[0].activeTab, 'prompt');
  assert.equal(result[0].enabled, true);
  assert.equal(result[1].name, '角色2');
  assert.equal(result[1].negative, '');
});

// ---- 5. applyAgentResultToUI ----
{
  const calls = [];
  const deps = {
    publicVibeFiles: [publicVibe],
    localVibeFiles: [localVibe],
    setPositivePrompt: (v) => calls.push(['setPositivePrompt', v]),
    setNegativePrompt: (v) => calls.push(['setNegativePrompt', v]),
    setCharacterPrompts: (v) => calls.push(['setCharacterPrompts', v]),
    setActiveVibes: (v) => calls.push(['setActiveVibes', v]),
    clearPreciseReference: () => calls.push(['clearPreciseReference']),
    setSelectedVibes: (v) => calls.push(['setSelectedVibes', v]),
    openCharacterSection: () => calls.push(['openCharacterSection']),
    getPublicVibeFile: async () => null,
  };
  applyAgentResultToUI({
    thinking: '',
    positive: 'new pos',
    negative: 'new neg',
    characters: [{ name: 'A', positive: 'p' }],
    vibes: ['lv1'],
  }, deps);
  check('applyAgentResultToUI:正/负词、vibes(选中+激活+清 CR)、角色 slice+展开 全分支', () => {
    assert.deepEqual(calls[0], ['setPositivePrompt', 'new pos']);
    assert.deepEqual(calls[1], ['setNegativePrompt', 'new neg']);
    assert.deepEqual(calls[2], ['setSelectedVibes', ['lv1']]);
    assert.equal(calls[3][0], 'setActiveVibes');
    assert.deepEqual(calls[4], ['clearPreciseReference']);
    assert.equal(calls[5][0], 'setCharacterPrompts');
    assert.equal(calls[5][1].length, 1);
    assert.deepEqual(calls[6], ['openCharacterSection']);
  });

  const emptyCalls = [];
  applyAgentResultToUI(
    { thinking: '', positive: '', negative: '', characters: [] },
    { ...deps, setPositivePrompt: (v) => emptyCalls.push(v), setNegativePrompt: (v) => emptyCalls.push(v) },
  );
  check('applyAgentResultToUI:空串结果不覆盖提示词(桌面 truthy 语义)', () => {
    assert.deepEqual(emptyCalls, []);
  });
}

// ---- 6. restore*ToUI ----
{
  const calls = [];
  const deps = {
    publicVibeFiles: [],
    localVibeFiles: [localVibe],
    setPositivePrompt: (v) => calls.push(['setPositivePrompt', v]),
    setNegativePrompt: (v) => calls.push(['setNegativePrompt', v]),
    setCharacterPrompts: (v) => calls.push(['setCharacterPrompts', v.length]),
    setActiveVibes: (v) => calls.push(['setActiveVibes', Array.isArray(v) ? v.map((x) => x.id) : v]),
    setSelectedVibes: (v) => calls.push(['setSelectedVibes', v]),
    openCharacterSection: () => calls.push(['openCharacterSection']),
  };
  restoreGeneratedSnapshotToUI({
    positive: 's pos',
    negative: 's neg',
    characters: Array.from({ length: 8 }, (_, i) => ({ name: `C${i}`, positive: `p${i}` })),
    vibes: ['lv1'],
  }, deps, { openCharacterSection: true });
  check('restoreGeneratedSnapshotToUI:角色 slice(0,6)、vibes 恢复、展开区块', () => {
    assert.deepEqual(calls[0], ['setPositivePrompt', 's pos']);
    assert.deepEqual(calls[1], ['setNegativePrompt', 's neg']);
    assert.deepEqual(calls[2], ['setCharacterPrompts', 6]);
    assert.deepEqual(calls[3], ['openCharacterSection']);
    assert.deepEqual(calls[4], ['setSelectedVibes', ['lv1']]);
    assert.deepEqual(calls[5], ['setActiveVibes', ['lv1']]);
  });

  const emptyCalls = [];
  restoreGeneratedSnapshotToUI(
    { positive: 'p', negative: 'n', characters: [], vibes: [] },
    { ...deps, setCharacterPrompts: (v) => emptyCalls.push(['chars', v]), setActiveVibes: (v) => emptyCalls.push(['vibes', v]), setSelectedVibes: (v) => emptyCalls.push(['selected', v]) },
  );
  check('restoreGeneratedSnapshotToUI:空角色/空 vibes → 全部清空', () => {
    assert.deepEqual(emptyCalls, [['chars', []], ['selected', []], ['vibes', []]]);
  });

  const promptCalls = [];
  restorePromptSnapshotToUI(
    { positive: 'p', negative: 'n', characters: [{ name: 'A', positive: 'x' }] },
    { ...deps, openCharacterSection: () => promptCalls.push('open'), setCharacterPrompts: () => promptCalls.push('chars') },
  );
  check('restorePromptSnapshotToUI:默认不开角色区块', () => {
    assert.deepEqual(promptCalls, ['chars']);
  });
}

// ---- 7. runAgent ----
{
  const makeDeps = (log, executeResult = { thinking: '', positive: 'p', negative: '', characters: [] }) => ({
    contextSources: sources,
    setIsGeneratingPrompt: (v) => log.push(['setIsGeneratingPrompt', v]),
    setAgentContext: (ctx) => log.push(['setAgentContext', ctx.currentPositive]),
    executeAgent: async (input, model, skipUserLog, imageBase64) => {
      log.push(['executeAgent', input, model, skipUserLog, imageBase64]);
      return executeResult;
    },
    applyResult: (result) => log.push(['applyResult', result.positive]),
    onError: (error) => log.push(['onError', String(error)]),
  });

  const log1 = [];
  await runAgent(makeDeps(log1), { input: '画一只猫', aiModel: 'deepseek', skipUserLog: false, allowImageOnly: true });
  check('runAgent:正常执行顺序(set→context→execute→apply→finally)', () => {
    assert.deepEqual(log1.map(([name]) => name), [
      'setIsGeneratingPrompt', 'setAgentContext', 'executeAgent', 'applyResult', 'setIsGeneratingPrompt',
    ]);
    assert.deepEqual(log1[0], ['setIsGeneratingPrompt', true]);
    assert.deepEqual(log1[4], ['setIsGeneratingPrompt', false]);
    assert.deepEqual(log1[2], ['executeAgent', '画一只猫', 'deepseek', false, undefined]);
  });

  const log2 = [];
  await runAgent(makeDeps(log2), { input: '  ', aiModel: 'm', skipUserLog: false, allowImageOnly: false });
  check('runAgent:空输入且不允许纯图片 → 直接返回(不置 preparing)', () => {
    assert.deepEqual(log2, []);
  });

  const log3 = [];
  await runAgent(makeDeps(log3), { input: '', aiModel: 'm', skipUserLog: false, allowImageOnly: true, imageBase64: 'img64' });
  check('runAgent:空输入+图片+allowImageOnly → 放行', () => {
    assert.deepEqual(log3.map(([name]) => name), [
      'setIsGeneratingPrompt', 'setAgentContext', 'executeAgent', 'applyResult', 'setIsGeneratingPrompt',
    ]);
    assert.deepEqual(log3[2], ['executeAgent', '', 'm', false, 'img64']);
  });

  const log4 = [];
  await runAgent(makeDeps(log4, null), { input: 'x', aiModel: 'm', skipUserLog: true, allowImageOnly: false });
  check('runAgent:result 为 null → 不 apply', () => {
    assert.deepEqual(log4.map(([name]) => name), ['setIsGeneratingPrompt', 'setAgentContext', 'executeAgent', 'setIsGeneratingPrompt']);
  });

  const log5 = [];
  const deps5 = makeDeps(log5);
  deps5.executeAgent = async () => { throw new Error('boom'); };
  await runAgent(deps5, { input: 'x', aiModel: 'm', skipUserLog: false, allowImageOnly: false });
  check('runAgent:异常 → onError 且 finally 复位', () => {
    assert.deepEqual(log5.map(([name]) => name), ['setIsGeneratingPrompt', 'setAgentContext', 'onError', 'setIsGeneratingPrompt']);
    assert.deepEqual(log5[3], ['setIsGeneratingPrompt', false]);
  });
}

console.log(`\n${checks} 项助手编排对等校验全部通过。`);
