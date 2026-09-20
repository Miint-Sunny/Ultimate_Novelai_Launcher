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

console.log(`\n${checks} 项生成参数合法值校验全部通过。`);
