#!/usr/bin/env node
// 生成参数合法值层的校验:采样器 id / 显示名两套口径的互转,以及导入校验对两者都认。
//
// 运行: node --experimental-strip-types scripts/check-generation-options.mjs
//
// 2026-09-20 真链路巡检抓到的错法:历史坞「使用元数据」把桌面 state 的显示名(Euler Ancestral)
// 当 id 塞进 ImageMetadata,弹窗把自己刚出的图判成「不支持: sampler」,导入时采样器被丢掉。

import assert from 'node:assert/strict';
await import('./lib/load-frontend-module.mjs');

const G = await import('../src/utils/generationOptions.ts');
const { coerceSamplerId, normalizeSamplerToId, samplerIdToLabel, getUnsupportedImportSettings, formatUnsupportedSettings, SAMPLER_OPTIONS } = G;

let checks = 0;
const check = (name, fn) => {
  checks += 1;
  try { fn(); console.log(`ok ${checks} - ${name}`); }
  catch (error) { console.error(`not ok ${checks} - ${name}`); throw error; }
};

check('coerceSamplerId: 显示名 → id,id 原样,认不出的原样保留,空值给 undefined', () => {
  for (const { id, label } of SAMPLER_OPTIONS) {
    assert.equal(coerceSamplerId(label), id);
    assert.equal(coerceSamplerId(id), id);
  }
  assert.equal(coerceSamplerId('ddim_v3'), 'ddim_v3', '未知值不能被吞成默认,导入校验要能如实报');
  assert.equal(coerceSamplerId(''), undefined);
  assert.equal(coerceSamplerId(undefined), undefined);
  assert.equal(normalizeSamplerToId('ddim_v3'), 'k_euler_ancestral', '发送层的 normalize 才退默认');
});

check('导入校验: 只认 id(显示名照旧报不支持,竖屏端的消费方按 id 写 state);生产端先收敛就过', () => {
  const meta = (extra) => ({ source: 'NovelAI', sourceType: 'novelai', prompt: '', negativePrompt: '', width: 832, height: 1216, seed: '1', ...extra });
  assert.deepEqual(getUnsupportedImportSettings(meta({ sampler: 'Euler Ancestral' })), [{ field: 'sampler', value: 'Euler Ancestral' }]);
  assert.deepEqual(getUnsupportedImportSettings(meta({ sampler: coerceSamplerId('Euler Ancestral') })), [], '历史坞拼元数据时先 coerce,就是这条路');
  assert.deepEqual(getUnsupportedImportSettings(meta({ sampler: 'k_dpmpp_2m' })), []);
  assert.deepEqual(getUnsupportedImportSettings(meta({ sampler: 'ddim_v3' })), [{ field: 'sampler', value: 'ddim_v3' }]);
  assert.deepEqual(getUnsupportedImportSettings(meta({ noiseSchedule: 'native', sampler: 'k_euler' })), [{ field: 'noise schedule', value: 'native' }]);
  assert.equal(formatUnsupportedSettings(getUnsupportedImportSettings(meta({ noiseSchedule: 'native', sampler: 'ddim_v3' }))), 'noise schedule: native、sampler: ddim_v3');
});

check('桌面导入映射: 显示名先收敛再查显示名,结果回到 state 用的显示名', () => {
  assert.equal(samplerIdToLabel(coerceSamplerId('Euler Ancestral')), 'Euler Ancestral');
  assert.equal(samplerIdToLabel(coerceSamplerId('k_dpmpp_sde')), 'DPM++ SDE');
  assert.equal(samplerIdToLabel(coerceSamplerId('ddim_v3')), undefined, '不认识的不设,别把垃圾写进受控 select');
});

const M = await import('../src/utils/maskCrop.ts');
const { focusSendSize, alignSendRect, FOCUS_PIXEL_BUDGET } = M;

check('焦点重绘发送尺寸: 放大到不超过 1MP 且各轴 64 对齐;只放大不缩小;贴回比例按各轴算', () => {
  assert.equal(FOCUS_PIXEL_BUDGET, 1048576);
  const a = focusSendSize({ width: 512, height: 768 });
  assert.deepEqual([a.width, a.height], [832, 1216], '512×768 → 832×1216(与 NAI 常规竖图同尺寸,免费档内)');
  assert.ok(a.width * a.height <= FOCUS_PIXEL_BUDGET);
  assert.ok(a.width % 64 === 0 && a.height % 64 === 0);
  assert.equal(a.scaleX, 832 / 512); assert.equal(a.scaleY, 1216 / 768);
  const b = focusSendSize({ width: 256, height: 256 });
  assert.deepEqual([b.width, b.height], [1024, 1024]);
  const c = focusSendSize({ width: 1280, height: 1280 });
  assert.deepEqual([c.width, c.height, c.scaleX, c.scaleY], [1280, 1280, 1, 1], '已经超预算的框原样发,不偷偷缩');
  const d = focusSendSize({ width: 1024, height: 1024 });
  assert.deepEqual([d.width, d.height], [1024, 1024]);
  for (const [w, h] of [[64, 64], [320, 1024], [1024, 320], [960, 704]]) {
    const r = focusSendSize({ width: w, height: h });
    assert.ok(r.width * r.height <= FOCUS_PIXEL_BUDGET, `${w}x${h} 超预算`);
    assert.ok(r.width >= w && r.height >= h, `${w}x${h} 缩小了`);
    assert.ok(r.width % 64 === 0 && r.height % 64 === 0, `${w}x${h} 未对齐`);
  }
  // 先 64 对齐再放大,和发送路径一致
  const aligned = alignSendRect({ x: 100, y: 100, width: 300, height: 500 }, 2000, 3000);
  assert.deepEqual([aligned.width, aligned.height], [320, 512]);
  const sent = focusSendSize(aligned);
  assert.deepEqual([sent.width, sent.height], [768, 1280], '各轴向下对齐 64,乘积 983040 在预算内');
  assert.ok(sent.width * sent.height <= FOCUS_PIXEL_BUDGET);
});

console.log(`\n${checks} 项生成参数合法值校验全部通过。`);
