#!/usr/bin/env node
// Agent 工具层的校验:工具的参数校验、对齐、白名单、结果文案,用假适配器钉住。
//
// 运行: node --experimental-strip-types scripts/check-agent-tools.mjs

import assert from 'node:assert/strict';
await import('./lib/load-frontend-module.mjs');

const T = await import('../src/services/agentHarness/tools/index.ts');
const { createWorkbenchToolRegistry, normalizeStudioUpdate, describeStudioDiff, parseQuestions, RESOLUTION_PRESETS, buildOverlaySpec, anchorDisplayFor, freePositioningForModel } = T;
const { findSkill, formatSkillsForSystemPrompt } = await import('../src/services/agentHarness/skillCatalog.ts');

let checks = 0;
const check = async (name, fn) => {
  checks += 1;
  try { await fn(); console.log(`ok ${checks} - ${name}`); }
  catch (error) { console.error(`not ok ${checks} - ${name}`); throw error; }
};

function fakeAdapter() {
  const state = {
    params: { prompt: '1girl', negative_prompt: '', model: 'nai-diffusion-5-full', width: 832, height: 1216, steps: 28, scale: 5, cfg_rescale: 0, sampler: 'k_euler_ancestral', noise_schedule: 'karras', quality_preset: 'Standard', seed: '', character_ai_position: true },
    characters: [],
    images: [
      { id: 'img1', width: 832, height: 1216, seed: 42, blob: async () => new Blob(['x']) },
      { id: 'img2', width: 1024, height: 1024, seed: 7, createdAt: 0, model: 'nai-diffusion-4-5-full', blob: async () => new Blob(['y']),
        characters: [{ id: 'a', name: '', enabled: true, prompt: '1girl, red hair', negative_prompt: '', center: { x: 0.3, y: 0.6 } }, { id: 'b', name: 'Bob', enabled: false, prompt: '1boy', negative_prompt: '', center: null }] },
    ],
    upscaled: [],
    asked: null,
    generateCalls: 0,
    suggested: null,
    overlays: [],
  };
  let nextId = 1;
  const adapter = {
    getParams: () => ({ ...state.params }),
    applyParams: (patch) => Object.assign(state.params, patch),
    availableModels: () => [], availableQualityPresets: () => [],
    listCharacters: () => state.characters.map((c) => ({ ...c })),
    addCharacter: (e) => { const c = { id: `c${nextId++}`, name: e.name ?? `角色 ${nextId - 1}`, enabled: true, prompt: e.prompt, negative_prompt: e.negative_prompt ?? '', center: e.center ?? null }; state.characters.push(c); return { ...c }; },
    updateCharacter: (id, patch) => { const c = state.characters.find((x) => x.id === id); if (!c) return null; Object.assign(c, patch); return { ...c }; },
    removeCharacter: (id) => { const i = state.characters.findIndex((x) => x.id === id); if (i < 0) return false; state.characters.splice(i, 1); return true; },
    replaceCharacters: (chars) => { state.characters = chars.map((c) => ({ ...c })); },
    maxCharacters: () => 2,
    generate: async () => { state.generateCalls += 1; return { ok: true, message: 'ok', seed: 7, width: 832, height: 1216 }; },
    images: () => state.images,
    addUpscaledImage: (blob, w, h, seed) => state.upscaled.push({ w, h, seed }),
    anlas: async () => ({ fixedTrainingStepsLeft: 10, purchasedTrainingSteps: 5, isOpus: true, opusUsage: { percent: 0, isNegative: false, timeUntilNextPercent: 0 } }),
    isOpus: () => true, opusExhausted: () => true,
    askUser: async (qs) => { state.asked = qs; return qs.map(() => 'A'); },
  };
  return { adapter, state };
}
const library = [];
const makeDeps = (allowed = ['prompt', 'negative_prompt', 'model', 'resolution', 'width', 'height', 'steps', 'scale', 'cfg_rescale', 'sampler', 'noise_schedule', 'quality_preset', 'character_ai_position']) => {
  const { adapter, state } = fakeAdapter();
  const deps = {
    adapter,
    allowedParams: () => new Set(allowed),
    estimateGenerationCost: () => ({ anlas: 0, free: true }),
    upscaleQuote: (w, h) => (w * h > 3145728 ? { cost: null, target: { width: 0, height: 0 } } : { cost: 1, target: { width: 1664, height: 2432 } }),
    upscaleV5: async () => ({ image: btoa('png'), width: 1664, height: 2432 }),
    downscaleImage: async () => ({ base64: 'QUJD', mimeType: 'image/png', width: 700, height: 1024 }),
    postJson: async (path, body) => ({ results: [{ name: `${path}:${body.query ?? body.tags?.join('+')}`, count: 5, zh: '译' }] }),
    suggestTags: async (query, opts) => { state.suggested = { query, ...opts }; return { items: query === 'none' ? [] : [{ tag: `${query}_tag`, count: 3, confidence: 0.5, translation: '译' }, { tag: `${query}_2`, count: null, confidence: null, category: '1' }, { tag: `${query}_3`, category: 'meta' }] }; },
    renderOverlay: async (blob, spec, maxEdge) => { state.overlays.push({ spec, maxEdge }); return { base64: 'T1ZM', mimeType: 'image/jpeg', width: 1024, height: 1024 }; },
    promptLibrary: { list: async () => library.map((e) => ({ ...e })), save: async (e) => { const i = library.findIndex((x) => x.id === e.id); if (i >= 0) library[i] = e; else library.push(e); }, remove: async (id) => { const i = library.findIndex((x) => x.id === id); if (i >= 0) library.splice(i, 1); } },
    skills: [{ id: 'nai5-prompting', name: 'NAI V5 提示词方法层', description: 'd', systemPrompt: 'BODY' }, { id: 'nai5-prompting/通用写法', name: 'V5 通用写法(参考)', description: 'd2', systemPrompt: 'REF' }, { id: 'other', name: 'x', description: 'x', systemPrompt: 'x' }],
    enabledSkillIds: () => ['nai5-prompting'],
  };
  return { deps, state, registry: createWorkbenchToolRegistry(deps) };
};
const run = (registry, name, args = {}) => registry.get(name).execute('call', args, { sendEpoch: 1, lockedFields: new Set() });

await check('工具表: 一期 19 个工具都注册了,名字与他的一致', () => {
  const { registry } = makeDeps();
  assert.deepEqual(registry.names.sort(), [
    'add_character_prompt', 'add_prompt_library_entry', 'ask_user', 'danbooru_related_tags', 'danbooru_search_tags', 'delete_prompt_library_entry',
    'get_studio_parameters', 'list_character_prompts', 'load_skill', 'novelai_account_info', 'novelai_generate', 'novelai_suggest_tags', 'novelai_upscale',
    'remove_character_prompt', 'search_prompt_library', 'update_character_prompt', 'update_prompt_library_entry', 'update_studio_parameters', 'view_canvas_image',
  ]);
  for (const tool of registry.getAll()) assert.ok(['R', 'W', 'D', 'P', 'A'].includes(tool.permissionClass), tool.name);
});

await check('参数校验: 宽高 64 对齐并夹在 64..2048;步数 1..50;CFG 1..20;rescale 0..1', () => {
  const cur = makeDeps().state.params;
  const allowed = new Set(['width', 'height', 'steps', 'scale', 'cfg_rescale']);
  const out = normalizeStudioUpdate({ width: 1000, height: 5000, steps: 99, scale: 0.5, cfg_rescale: 2 }, cur, allowed);
  assert.deepEqual(out.patch, { width: 960, height: 2048, steps: 50, scale: 1, cfg_rescale: 1 });
  assert.equal(out.rejected.length, 0);
});

await check('参数校验: 模型枚举、分辨率预设、质量档;不在预设白名单里的键被拒且不写', () => {
  const cur = makeDeps().state.params;
  const ok = normalizeStudioUpdate({ model: 'nai-diffusion-4-5-full', resolution_preset: 'landscape', quality_preset: 'Light', seed: 123 }, cur, new Set(['model', 'resolution', 'quality_preset']));
  assert.deepEqual(ok.patch, { model: 'nai-diffusion-4-5-full', width: 1216, height: 832, quality_preset: 'Light', seed: '123' });
  // 无效模型在动任何字段之前就整体失败(他 fork 的 pr-studio-state):合法字段也不部分写入。
  const badModel = normalizeStudioUpdate({ model: 'sdxl', steps: 20 }, cur, new Set(['model', 'steps']));
  assert.deepEqual(badModel.patch, {});
  assert.equal(badModel.rejected.length, 1);
  assert.match(badModel.rejected[0], /未知模型 ID sdxl.*未应用任何字段/);
  const bad = normalizeStudioUpdate({ resolution_preset: 'huge', quality_preset: 'Ultra', prompt: 'x' }, cur, new Set(['model', 'resolution', 'quality_preset']));
  assert.deepEqual(bad.patch, {});
  assert.equal(bad.rejected.length, 3);
  assert.match(bad.rejected.find((r) => r.startsWith('prompt')), /不允许修改/);
  // None 与 Off 同义。
  assert.deepEqual(normalizeStudioUpdate({ quality_preset: 'None' }, cur, new Set(['quality_preset'])).patch, { quality_preset: 'Off' });
  assert.deepEqual(Object.keys(RESOLUTION_PRESETS), ['portrait', 'landscape', 'square', 'wallpaper', 'portrait_large', 'landscape_large']);
});

await check('参数 diff 文案与 update 执行: 写进适配器并回显;全被拒时标错', async () => {
  const { registry, state } = makeDeps();
  assert.equal(describeStudioDiff({ steps: 20 }, state.params), 'steps: 28 → 20');
  const r = await run(registry, 'update_studio_parameters', { steps: 20, prompt: 'cat' });
  assert.equal(state.params.steps, 20); assert.equal(state.params.prompt, 'cat');
  assert.match(r.content, /已成功同步修改工作台 UI 生图参数/);
  const none = await run(registry, 'update_studio_parameters', {});
  assert.equal(none.isError, true);
  const get = await run(registry, 'get_studio_parameters', { keys: ['steps', 'opus_free_status'] });
  assert.match(get.content, /steps: 20/); assert.match(get.content, /opus_free_status: 当前参数在 Opus 免费区间内/);
  const badKey = await run(registry, 'get_studio_parameters', { keys: ['nope'] });
  assert.equal(badKey.isError, true);
});

await check('角色: 增改删走适配器;上限拒绝;坐标夹到 0..1;use_auto_position 清坐标', async () => {
  const { registry, state } = makeDeps();
  const a = await run(registry, 'add_character_prompt', { prompt: 'girl, red eyes', position_x: 1.7, position_y: -1 });
  assert.match(a.content, /已添加角色 id=c1/);
  assert.deepEqual(state.characters[0].center, { x: 1, y: 0 });
  await run(registry, 'add_character_prompt', { prompt: 'boy' });
  const full = await run(registry, 'add_character_prompt', { prompt: 'third' });
  assert.equal(full.isError, true);
  const u = await run(registry, 'update_character_prompt', { id: 'c1', enabled: false, use_auto_position: true });
  assert.equal(u.isError, undefined); assert.equal(state.characters[0].enabled, false); assert.equal(state.characters[0].center, null);
  const list = await run(registry, 'list_character_prompts');
  assert.match(list.content, /id=c1 .*停用 定位=自动/);
  assert.equal((await run(registry, 'remove_character_prompt', { id: 'c2' })).isError, undefined);
  assert.equal((await run(registry, 'remove_character_prompt', { id: 'zzz' })).isError, true);
});

await check('生成/放大/账号: generate 走适配器;放大按索引取图、超上限拒绝、结果回历史坞;账号文案带体力条', async () => {
  const { registry, state } = makeDeps();
  const g = await run(registry, 'novelai_generate');
  assert.equal(state.generateCalls, 1); assert.match(g.content, /种子 7/);
  const up = await run(registry, 'novelai_upscale', { index: 0 });
  assert.match(up.content, /1664x2432/); assert.deepEqual(state.upscaled, [{ w: 1664, h: 2432, seed: 42 }]);
  state.images.unshift({ id: 'big', width: 2048, height: 2048, seed: 1, blob: async () => new Blob([]) });
  assert.equal((await run(registry, 'novelai_upscale')).isError, true);
  const cost = await registry.get('novelai_upscale').estimateCost({ index: 1 }, { sendEpoch: 1, lockedFields: new Set() });
  assert.deepEqual(cost, { anlas: 1, free: false, note: '832x1216 → 1664x2432' });
  const acct = await run(registry, 'novelai_account_info');
  assert.match(acct.content, /Anlas 余额:15/); assert.match(acct.content, /已耗尽/);
});

await check('view_canvas_image: 无角色的图退回原图并说明;越界报错', async () => {
  const { registry, state } = makeDeps();
  const r = await run(registry, 'view_canvas_image');
  assert.equal(r.imageBase64, 'QUJD');
  assert.match(r.content, /没有启用的角色提示词,已返回原图/);
  assert.match(r.content, /已压缩到 700x1024/);
  assert.equal(state.overlays.length, 0);
  assert.equal((await run(registry, 'view_canvas_image', { index: 9 })).isError, true);
});

await check('角色坐标: position_x/position_y 是契约,center:{x,y} 也认;update 只传一个轴时另一轴沿用', async () => {
  const { registry, state } = makeDeps();
  const a = await run(registry, 'add_character_prompt', { prompt: '1girl', center: { x: 0.2, y: 0.9 } });
  assert.match(a.content, /定位 \(0.2, 0.9\)/);
  const b = await run(registry, 'add_character_prompt', { prompt: '1boy', position_x: 0.7, position_y: 0.1 });
  assert.match(b.content, /定位 \(0.7, 0.1\)/);
  const id = state.characters[0].id;
  await run(registry, 'update_character_prompt', { id, position_y: 0.4 });
  assert.deepEqual(state.characters[0].center, { x: 0.2, y: 0.4 });
  await run(registry, 'update_character_prompt', { id, center: { x: 0.55, y: 0.45 } });
  assert.deepEqual(state.characters[0].center, { x: 0.55, y: 0.45 });
  await run(registry, 'update_character_prompt', { id, use_auto_position: true });
  assert.equal(state.characters[0].center, null);
});

await check('覆盖层: 只取启用角色;V4 吸附格心叠网格,V5 连续坐标叠十字;粉/蓝/紫配色与标签回退', () => {
  const chars = [
    { id: 'a', name: '', enabled: true, prompt: '1girl, red hair', negative_prompt: '', center: { x: 0.3, y: 0.55 } },
    { id: 'b', name: '角色 2', enabled: true, prompt: '1boy, glasses', negative_prompt: '', center: null },
    { id: 'c', name: 'Cat', enabled: false, prompt: 'cat', negative_prompt: '', center: null },
    { id: 'd', name: 'Robo', enabled: true, prompt: 'robot', negative_prompt: '', center: { x: 0.95, y: 0.1 } },
  ];
  const v4 = buildOverlaySpec(chars, false);
  assert.equal(v4.guide, 'grid5');
  assert.equal(v4.anchors.length, 3, '禁用的角色不画');
  assert.deepEqual(v4.anchors.map((a) => a.index), [1, 2, 3]);
  assert.deepEqual(v4.anchors[0], { index: 1, x: 0.3, y: 0.5, color: '#EC4899', label: '1girl' }, 'V4 吸附到 5x5 格心,粉色,名字空回退到首个标签');
  assert.equal(v4.anchors[1].color, '#3B82F6'); assert.equal(v4.anchors[1].label, '1boy', '占位名「角色 N」也回退');
  assert.equal(v4.anchors[2].color, '#8B5CF6'); assert.equal(v4.anchors[2].label, 'Robo');
  assert.deepEqual([v4.anchors[2].x, v4.anchors[2].y], [0.9, 0.1]);
  const v5 = buildOverlaySpec(chars, true);
  assert.equal(v5.guide, 'crosshair');
  assert.deepEqual([v5.anchors[0].x, v5.anchors[0].y], [0.3, 0.55], 'V5 保留连续坐标');
  assert.equal(buildOverlaySpec([chars[2]], true), null, '没有启用角色返回 null');
  assert.deepEqual(anchorDisplayFor({ name: ' Alice ', prompt: 'female, x' }), { color: '#EC4899', label: 'Alice' });
  assert.equal(freePositioningForModel('nai-diffusion-5-curated'), true);
  assert.equal(freePositioningForModel('nai-diffusion-4-5-full'), false);
  assert.equal(freePositioningForModel(undefined), false);
});

await check('view_canvas_image: 有角色默认叠覆盖层并压到 1024;full_resolution 不缩;with_overlay=false 走原图', async () => {
  const { registry, state } = makeDeps();
  const r = await run(registry, 'view_canvas_image', { index: 1 });
  assert.equal(r.imageBase64, 'T1ZM');
  assert.equal(state.overlays.length, 1);
  assert.equal(state.overlays[0].maxEdge, 1024);
  assert.equal(state.overlays[0].spec.guide, 'grid5');
  assert.equal(state.overlays[0].spec.anchors.length, 1, '禁用角色不画');
  assert.match(r.content, /已叠加角色位置覆盖层/);
  assert.match(r.content, /自定义定位/);
  assert.match(r.content, /绘图模型: nai-diffusion-4-5-full/);
  assert.match(r.content, /网格模式/);
  await run(registry, 'view_canvas_image', { index: 1, full_resolution: true });
  assert.equal(state.overlays[1].maxEdge, null);
  const raw = await run(registry, 'view_canvas_image', { index: 1, with_overlay: false });
  assert.equal(raw.imageBase64, 'QUJD');
  assert.equal(state.overlays.length, 2);
  assert.doesNotMatch(raw.content, /覆盖层/);
});

await check('tag 联想: query 必填;默认 official 且带当前模型;limit 夹在 1..50;逐行列用量/匹配度/翻译;空结果如实说', async () => {
  const { registry, state } = makeDeps();
  assert.equal((await run(registry, 'novelai_suggest_tags', {})).isError, true);
  const r = await run(registry, 'novelai_suggest_tags', { query: 'silver', limit: 500 });
  assert.deepEqual(state.suggested, { query: 'silver', source: 'official', limit: 50, model: 'nai-diffusion-5-full' });
  assert.match(r.content, /来源 official/);
  assert.match(r.content, /- silver_tag \(用量: 3\) \(匹配度: 50.0%\) — 译/);
  assert.match(r.content, /- silver_2 \[画师\]/, '数字类别翻成中文');
  assert.match(r.content, /- silver_3 \[meta\]/, '非数字类别原样显示');
  await run(registry, 'novelai_suggest_tags', { query: 'x', source: 'dictionary' });
  assert.equal(state.suggested.source, 'dictionary');
  assert.equal(state.suggested.model, undefined, '非官方来源不传模型');
  assert.equal(state.suggested.limit, 10);
  assert.match((await run(registry, 'novelai_suggest_tags', { query: 'none' })).content, /未找到/);
});

await check('ask_user: 参数规则照他的(1–4 题、2–4 项、label 必填);回答按题拼回', async () => {
  assert.equal(parseQuestions({ questions: [] }), null);
  assert.equal(parseQuestions({ questions: [{ question: 'q?', options: [{ label: 'a' }] }] }), null);
  assert.equal(parseQuestions({ questions: [{ question: 'q?', options: [{ label: 'a' }, { label: '' }] }] }), null);
  assert.deepEqual(parseQuestions({ questions: [{ question: 'q?', options: ['a', ' b '] }] })?.[0].options.map((o) => o.label), ['a', 'b']);
  const parsed = parseQuestions({ questions: [{ question: ' q? ', header: 'H', multiSelect: true, options: [{ label: ' a ' }, { label: 'b', description: 'd' }] }] });
  assert.deepEqual(parsed, [{ question: 'q?', header: 'H', multiSelect: true, allowCustomInput: true, options: [{ label: 'a', description: undefined }, { label: 'b', description: 'd' }] }]);
  const { registry, state } = makeDeps();
  const r = await run(registry, 'ask_user', { questions: [{ question: 'q?', options: [{ label: 'a' }, { label: 'b' }] }] });
  assert.equal(state.asked.length, 1); assert.equal(r.content, '问题: q?\n回答: A');
});

await check('技能: 只认预设开放的技能(含其子节);目录格式照他的;未知名字列出可用清单', async () => {
  const { registry, deps } = makeDeps();
  const main = await run(registry, 'load_skill', { skill_name: 'nai5-prompting' });
  assert.match(main.content, /^<skill name="nai5-prompting">/); assert.match(main.content, /BODY/);
  const sub = await run(registry, 'load_skill', { skill_name: '通用写法' });
  assert.match(sub.content, /REF/);
  const other = await run(registry, 'load_skill', { skill_name: 'other' });
  assert.equal(other.isError, true); assert.match(other.content, /nai5-prompting, nai5-prompting\/通用写法/);
  assert.equal(findSkill('OTHER', deps.skills).id, 'other');
  assert.match(formatSkillsForSystemPrompt(deps.skills.slice(0, 1)), /<available_skills>\n  <skill>\n    <name>nai5-prompting<\/name>/);
});

await check('Danbooru: 两个工具打我们自己的路由并格式化结果', async () => {
  const { registry } = makeDeps();
  const s = await run(registry, 'danbooru_search_tags', { query: 'maid', limit: 500 });
  assert.match(s.content, /\/api\/tags\/search:maid 5 \(译\)/);
  const r = await run(registry, 'danbooru_related_tags', { tags: ['maid', 'twintails'], category: 'General' });
  assert.match(r.content, /\/api\/tags\/related:maid\+twintails/);
  assert.equal((await run(registry, 'danbooru_related_tags', { tags: [] })).isError, true);
});

await check('词库: 映射到片段库;标题带 ! 拒绝;同名拒绝;不支持的字段如实说明;删除后查不到', async () => {
  library.length = 0;
  const { registry } = makeDeps();
  const add = await run(registry, 'add_prompt_library_entry', { title: 'Face', prompt: 'red eyes,', category: '角色', tags: ['x'] });
  assert.match(add.content, /@Face/); assert.match(add.content, /不支持 tags/);
  assert.equal((await run(registry, 'add_prompt_library_entry', { title: 'Face', prompt: 'dup' })).isError, true);
  assert.equal((await run(registry, 'add_prompt_library_entry', { title: 'a!b', prompt: 'x' })).isError, true);
  const id = library[0].id;
  const found = await run(registry, 'search_prompt_library', { query: 'red' });
  assert.match(found.content, new RegExp(`id=${id} 「Face」\\[角色\\]`));
  await run(registry, 'update_prompt_library_entry', { id, prompt: 'blue eyes,' });
  assert.equal(library[0].prompt, 'blue eyes,');
  const del = await run(registry, 'delete_prompt_library_entry', { id });
  assert.equal(del.isError, undefined); assert.equal(library.length, 0);
});

console.log(`\n${checks} 项 agent 工具校验全部通过。`);
