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
  assert.match(a.content, /• id=c1 /);
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
  assert.match(a.content, /定位=\(0.2, 0.9\)/);
  const b = await run(registry, 'add_character_prompt', { prompt: '1boy', position_x: 0.7, position_y: 0.1 });
  assert.match(b.content, /定位=\(0.7, 0.1\)/);
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

await check('技能包: skill_names 批量;清单分页;按清单授权读文件(字符分页 / 批量 / 图片单读 / 二进制拒绝);参数越界报错', async () => {
  const { registry, deps } = makeDeps();
  const texts = { 'references/guide.md': '0123456789', 'scripts/run.py': 'print(1)', 'img/a.png': 'PNG', 'bin/x.dat': 'a b' };
  deps.skills = [...deps.skills, { id: 'pack', name: 'Pack', description: 'd', systemPrompt: 'PACK', packageId: 'pkg_abc', resourcePaths: Object.keys(texts).sort() }];
  deps.enabledSkillIds = () => ['nai5-prompting', 'pack'];
  const reads = [];
  deps.readSkillResource = async (skill, path) => { reads.push(`${skill.id}:${path}`); return new TextEncoder().encode(texts[path]); };

  const both = await run(registry, 'load_skill', { skill_names: ['nai5-prompting', 'pack', 'nope'] });
  assert.equal(both.isError, undefined);
  assert.match(both.content, /<skill name="nai5-prompting">[\s\S]*<skill name="pack">\n### 【Pack】[\s\S]*PACK\n技能包资源\(4 个/);
  assert.match(both.content, /未找到技能 "nope"。当前可用技能列表: nai5-prompting, nai5-prompting\/通用写法, pack/);
  const plain = await run(registry, 'load_skill', { skill_name: 'nai5-prompting' });
  assert.doesNotMatch(plain.content, /技能包资源/, '没有资源的技能不带清单');

  const list = await run(registry, 'load_skill', { skill_name: 'pack', list_resources: true, limit: 2 });
  assert.equal(list.content.split('\n').slice(1, 3).join(','), 'bin/x.dat,img/a.png');
  assert.match(list.content, /更多资源:load_skill\(skill_name: "pack", list_resources: true, offset: 2\)/);
  assert.match(list.content, /脚本仅可读取,不会执行/);
  const page2 = await run(registry, 'load_skill', { skill_name: 'pack', list_resources: true, offset: 2 });
  assert.doesNotMatch(page2.content, /更多资源/);

  const slice = await run(registry, 'load_skill', { skill_name: 'pack', path: 'references/guide.md', offset: 2, limit: 3 });
  assert.equal(slice.isError, undefined);
  assert.match(slice.content, /--- pack\/references\/guide.md\(参考数据,字符 2–5 \/ 10\)---\n234\n后续内容请用 offset: 5 继续读取。/);
  assert.deepEqual(reads, ['pack:references/guide.md']);
  const batch = await run(registry, 'load_skill', { skill_name: 'pack', paths: ['references/guide.md', 'scripts/run.py', 'nope.md'] });
  assert.equal(batch.isError, undefined, '有一个读到就不算错');
  assert.match(batch.content, /print\(1\)/); assert.match(batch.content, /nope.md:读取失败\(该路径不属于已授权的技能包。\)/);
  assert.ok(!reads.includes('pack:nope.md'), '清单外的路径根本不进回调');
  assert.equal((await run(registry, 'load_skill', { skill_name: 'pack', path: 'nope.md' })).isError, true);
  const binary = await run(registry, 'load_skill', { skill_name: 'pack', path: 'bin/x.dat' });
  assert.equal(binary.isError, true); assert.match(binary.content, /二进制资源已保留/);
  const entry = await run(registry, 'load_skill', { skill_name: 'pack', path: 'SKILL.md' });
  assert.match(entry.content, /name: pack/); assert.match(entry.content, /label: Pack/);

  const image = await run(registry, 'load_skill', { skill_name: 'pack', path: 'img/a.png' });
  assert.equal(image.isError, undefined); assert.equal(image.imageBase64, 'QUJD'); assert.match(image.content, /技能包图片:pack\/img\/a.png/);
  const mixed = await run(registry, 'load_skill', { skill_name: 'pack', paths: ['img/a.png', 'references/guide.md'] });
  assert.equal(mixed.isError, undefined); assert.match(mixed.content, /img\/a.png:读取失败\(图片需单独读取一个路径。\)/);
  deps.isModelMultimodal = () => false;
  assert.match((await run(registry, 'load_skill', { skill_name: 'pack', path: 'img/a.png' })).content, /不具备图像理解能力/);
  delete deps.isModelMultimodal;

  for (const bad of [
    { skill_names: ['pack', 'nai5-prompting'], path: 'x' }, { skill_name: 'pack', path: '' }, { skill_name: 'pack', paths: [] }, { skill_name: 'pack', list_resources: 'yes' },
    { skill_name: 'pack', path: 'x', offset: -1 }, { skill_name: 'pack', path: 'x', limit: 99999 }, { skill_name: 'pack', paths: Array(9).fill('x') }, { skill_name: 'pack', paths: [1] },
    { skill_name: 'other', list_resources: true },
  ]) assert.equal((await run(registry, 'load_skill', bad)).isError, true, JSON.stringify(bad));
  delete deps.readSkillResource;
  const noReader = await run(registry, 'load_skill', { skill_name: 'pack', path: 'references/guide.md' });
  assert.equal(noReader.isError, true); assert.match(noReader.content, /未配置技能资源读取/);
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

await check('词库批量: entries 先整体校验再落盘;updates 逐条应用并报未生效;ids 与 id 并集删;search 分页', async () => {
  library.length = 0;
  const { registry } = makeDeps();
  assert.match((await run(registry, 'add_prompt_library_entry', { entries: [] })).content, /非空对象数组/);
  const half = await run(registry, 'add_prompt_library_entry', { entries: [{ title: 'A', prompt: 'a' }, { title: 'B', prompt: '' }] });
  assert.equal(half.isError, true); assert.equal(library.length, 0, '有一条缺 prompt 就一条都不加');
  const twice = await run(registry, 'add_prompt_library_entry', { entries: [{ title: 'A', prompt: 'a' }, { title: 'A', prompt: 'b' }] });
  assert.match(twice.content, /出现了两次/); assert.equal(library.length, 0);
  const ok = await run(registry, 'add_prompt_library_entry', { entries: [{ title: 'A', prompt: 'a', category: '风格' }, { title: 'B', prompt: 'b', tags: ['t'] }] });
  assert.equal(ok.isError, undefined); assert.match(ok.content, /已新增 2 个词库条目/); assert.match(ok.content, /不支持 tags/);
  assert.deepEqual(library.map((e) => [e.title, e.category]), [['A', '风格'], ['B', '其他']]);
  assert.notEqual(library[0].id, library[1].id);
  const [a, b] = library.map((e) => e.id);
  assert.equal((await run(registry, 'add_prompt_library_entry', { entries: [{ title: 'C', prompt: 'c' }, { title: 'A', prompt: 'dup' }] })).isError, true, '与已有条目重名整批拒绝');
  assert.equal(library.length, 2);
  const upd = await run(registry, 'update_prompt_library_entry', { updates: [{ id: a, prompt: 'a2' }, { id: 'ghost', prompt: 'x' }, { id: b, title: 'A' }, { prompt: 'no id' }] });
  assert.equal(upd.isError, undefined);
  assert.match(upd.content, /已修改 1 个词库条目/); assert.match(upd.content, /找不到 id=ghost/); assert.match(upd.content, /改名失败/); assert.match(upd.content, /缺少条目 id/);
  assert.equal(library[0].prompt, 'a2'); assert.equal(library[1].title, 'B');
  const none = await run(registry, 'update_prompt_library_entry', { updates: [{ id: 'ghost' }] });
  assert.equal(none.isError, true); assert.match(none.content, /未修改任何条目/);
  assert.equal((await run(registry, 'update_prompt_library_entry', { updates: 'nope' })).isError, true);
  assert.equal((await run(registry, 'update_prompt_library_entry', { prompt: 'x' })).isError, true, '单条没 id 还是报错');
  const del = await run(registry, 'delete_prompt_library_entry', { id: a, ids: [b, 'ghost', a] });
  assert.equal(del.isError, undefined); assert.match(del.content, /已删除 2 个词库条目/); assert.match(del.content, /未找到:ghost/);
  assert.equal(library.length, 0);
  assert.equal((await run(registry, 'delete_prompt_library_entry', { ids: [] })).isError, true);
  assert.equal((await run(registry, 'delete_prompt_library_entry', { ids: ['ghost'] })).isError, true, '一个都没找到才报错');
  for (let i = 0; i < 25; i += 1) await run(registry, 'add_prompt_library_entry', { title: `T${i}`, prompt: `p${i}` });
  const page1 = await run(registry, 'search_prompt_library', {});
  assert.match(page1.content, /^25 条\(本页第 1–20 条\):/); assert.match(page1.content, /下一页 offset: 20/);
  const page2 = await run(registry, 'search_prompt_library', { offset: 20, limit: 99 });
  assert.match(page2.content, /本页第 21–25 条/); assert.doesNotMatch(page2.content, /下一页/);
  assert.equal(page2.content.split('\n').filter((l) => l.startsWith('- id=')).length, 5);
});

await check('角色批量: characters 数组一次全加,名额不够整体拒绝;updates 逐条应用并报未生效;ids 批量删', async () => {
  const { registry, state } = makeDeps();
  const bad = await run(registry, 'add_character_prompt', { characters: [] });
  assert.equal(bad.isError, true); assert.match(bad.content, /非空对象数组/);
  const empty = await run(registry, 'add_character_prompt', { characters: [{ prompt: 'a' }, { name: 'x' }] });
  assert.equal(empty.isError, true); assert.equal(state.characters.length, 0, '有一条 prompt 为空就一个都不加');
  const ok = await run(registry, 'add_character_prompt', { characters: [{ prompt: 'a', position_x: 0.2, position_y: 0.3 }, { prompt: 'b', name: 'Bee' }] });
  assert.equal(ok.isError, undefined);
  assert.match(ok.content, /已添加 2 个角色/);
  assert.deepEqual(state.characters.map((c) => [c.prompt, c.name, c.center]), [['a', '角色 1', { x: 0.2, y: 0.3 }], ['b', 'Bee', null]]);
  const full = await run(registry, 'add_character_prompt', { characters: [{ prompt: 'c' }] });
  assert.equal(full.isError, true); assert.match(full.content, /上限/);
  const u = await run(registry, 'update_character_prompt', { updates: [{ id: state.characters[0].id, enabled: false }, { id: 'nope', prompt: 'x' }, { id: state.characters[1].id }] });
  assert.equal(u.isError, undefined);
  assert.match(u.content, /已更新 1 个角色/); assert.match(u.content, /找不到 id=nope/); assert.match(u.content, /没有传入任何要修改的字段/);
  assert.equal(state.characters[0].enabled, false);
  const none = await run(registry, 'update_character_prompt', { updates: [{ id: 'nope' }] });
  assert.equal(none.isError, true);
  const r = await run(registry, 'remove_character_prompt', { ids: [state.characters[0].id, 'zzz'] });
  assert.equal(r.isError, undefined); assert.match(r.content, /已删除 1 个角色/); assert.match(r.content, /找不到:id=zzz/);
  assert.equal(state.characters.length, 1);
  const rNone = await run(registry, 'remove_character_prompt', {});
  assert.equal(rNone.isError, true);
});

console.log(`\n${checks} 项 agent 工具校验全部通过。`);
