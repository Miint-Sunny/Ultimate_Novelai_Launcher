#!/usr/bin/env node
// 导演工具的算价与入参校验(src/services/directorTools.ts)。
//
// 运行: node --experimental-strip-types scripts/check-director-tools.mjs
//
// 为什么值得单独一份:官方**没有公布**任何价目,docs.novelai.net 的 Director Tools 页
// 零 Anlas 字样、pricing 页 404。我们的数字来自逆向实现 + 自己花钱买的三个点,
// 所以这份脚本钉的是**那三个实测点**——公式将来被谁改动,这里立刻变红。
//
// 三次真链路实测(2026-09-21,真 key,共 82 Anlas):
//   bg-removal 832×1216 → 65;bg-removal 256×256 → 11;lineart 256×256(Opus)→ 0。
//
// 还钉了一条**被判掉的错误变体**:有两份公开实现会先把尺寸归一到 [1MP, 3MP] 再算价。
// 那个变体在 832×1216 上同样给 65,只有小图那个点能判掉它(它给 65 而不是 11)。
// 谁要是照着那两份实现「修正」我们的公式,这里会挡住。

import assert from 'node:assert/strict';

await import('./lib/load-frontend-module.mjs');

const {
  DIRECTOR_TOOLS,
  DIRECTOR_MAX_PIXELS,
  clampDefry,
  describeDirectorCost,
  directorCost,
  directorInputProblem,
  directorTool,
} = await import('../src/services/directorTools.ts');
const { directorBaseCost } = await import('../src/services/costCalculator.ts');

let checks = 0;
const failures = [];
function check(name, fn) {
  try {
    fn();
    checks += 1;
    console.log(`ok ${checks} - ${name}`);
  } catch (error) {
    failures.push(name);
    console.log(`not ok - ${name}\n${error && error.stack ? error.stack : error}`);
  }
}

check('实测锚点: 去背 832×1216 = 65 Anlas(2026-09-21 真链路)', () => {
  assert.equal(directorBaseCost(832, 1216), 20);
  const cost = directorCost('bg-removal', 832, 1216, true);
  assert.equal(cost.anlas, 65);
  assert.equal(cost.free, false, 'Opus 也要收:官方对去背特判');
  assert.equal(cost.confirm, true);
});

check('实测锚点: 去背 256×256 = 11 Anlas(同时判掉「先归一到 1MP」的错变体)', () => {
  assert.equal(directorBaseCost(256, 256), 2);
  assert.equal(directorCost('bg-removal', 256, 256, true).anlas, 11);
  // 错变体会把 256×256 放大到 1024×1024 再算,得 65。真扣的是 11。
  assert.notEqual(directorCost('bg-removal', 256, 256, true).anlas, 65);
});

check('实测锚点: 线稿 256×256 在 Opus 下不花 Anlas', () => {
  const cost = directorCost('lineart', 256, 256, true);
  assert.equal(cost.anlas, 0);
  assert.equal(cost.free, true);
  assert.equal(cost.confirm, false, '免费的不该拦一道确认');
  assert.equal(describeDirectorCost(cost), '不花 Anlas', '只敢说不花钱,不敢说不消耗额度');
});

check('免费档只到 1 MP,超了回落到 base;非 Opus 一律收', () => {
  assert.equal(directorCost('lineart', 1024, 1024, true).anlas, 0, '正好 1 MP 仍免费');
  const over = directorCost('lineart', 1216, 1216, true);
  assert.equal(over.free, false);
  assert.equal(over.anlas, directorBaseCost(1216, 1216));
  assert.equal(over.confirm, true);
  const noOpus = directorCost('lineart', 256, 256, false);
  assert.equal(noOpus.anlas, 2, '非 Opus 按 base,最低 2');
  assert.equal(noOpus.free, false);
});

check('五个工具同价,只有去背特判', () => {
  for (const tool of ['lineart', 'sketch', 'colorize', 'emotion', 'declutter']) {
    assert.equal(directorCost(tool, 832, 1216, false).anlas, 20, tool);
  }
  assert.equal(directorCost('bg-removal', 832, 1216, false).anlas, 65);
});

check('工具表: 六个官方 req_type,只有上色与改表情收提示词', () => {
  assert.deepEqual(
    DIRECTOR_TOOLS.map((t) => t.id).sort(),
    ['bg-removal', 'colorize', 'declutter', 'emotion', 'lineart', 'sketch'],
  );
  for (const tool of DIRECTOR_TOOLS) {
    const wantsPrompt = tool.id === 'colorize' || tool.id === 'emotion';
    assert.equal(tool.needsPrompt, wantsPrompt, tool.id);
    assert.equal(tool.needsDefry, wantsPrompt, `${tool.id}: defry 与提示词同进退`);
  }
  assert.equal(directorTool('nope'), null);
});

check('入参: 没图 / 超官方上限 / 该写提示词没写,都不发', () => {
  assert.equal(directorInputProblem('lineart', null, ''), 'no-image');
  assert.equal(directorInputProblem('lineart', { width: 1536, height: 2048 }, ''), null, '正好上限放行');
  assert.equal(directorInputProblem('lineart', { width: 1600, height: 2048 }, ''), 'too-large');
  assert.equal(DIRECTOR_MAX_PIXELS, 1536 * 2048);
  assert.equal(directorInputProblem('colorize', { width: 512, height: 512 }, '   '), 'missing-prompt');
  assert.equal(directorInputProblem('colorize', { width: 512, height: 512 }, '蓝色头发'), null);
  assert.equal(directorInputProblem('emotion', { width: 512, height: 512 }, ''), 'missing-prompt');
});

check('defry: 夹到 0–5,坏值当 0', () => {
  assert.equal(clampDefry(3), 3);
  assert.equal(clampDefry(-2), 0);
  assert.equal(clampDefry(9), 5);
  assert.equal(clampDefry(2.6), 3);
  assert.equal(clampDefry('x'), 0);
  assert.equal(clampDefry(undefined), 0);
});

if (failures.length > 0) {
  console.error(`\n${failures.length} 项导演工具校验失败: ${failures.join('; ')}`);
  process.exit(1);
}
console.log(`\n${checks} 项导演工具校验全部通过。`);
