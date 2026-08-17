#!/usr/bin/env node
// 创作室模块注册表对等校验(P6):直接加载纯逻辑层 studioModules.ts(无 React/DOM,
// node --experimental-strip-types 可直接加载),断言三张操作卡的能力谓词矩阵与
// 可见序列;并对 MobileStudioPage 做结构断言。
//
// 运行: node --experimental-strip-types scripts/check-studio-parity.mjs
// (node >= 23.6 默认启用 type stripping,显式 flag 亦兼容)
//
// 校验内容:
//   1. 三张卡 def 齐全(key/标题/副标题/图标 token/谓词函数),key 序 = 声明序
//   2. inpaint/upscale:对 NAI 各家族(按 modelFamilyOf 实际家族枚举)可见,
//      对非 NAI(SD 模型 id / 未知型号)不可见;serverMode/登录态不参与 gating
//   3. img2video:backendCapabilities.img2video=false 时不可见(当前占位常量即 false),
//      true 时可见且与模型家族无关(未来保障测试)
//   4. visibleStudioModuleKeys 只返回可见项,顺序 = 注册表声明序
//   5. 结构断言(文本扫描):MobileStudioPage 消费注册表与后端能力常量、
//      'studio-open-tool' 事件契约仍在;studioModules.ts 不 import react(纯模块)

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const {
  STUDIO_MODULE_DEFS,
  STUDIO_BACKEND_CAPABILITIES,
  studioModuleDef,
  isStudioModuleVisible,
  visibleStudioModuleKeys,
} = await import('../src/components/mobile/pager/studioModules.ts');
const { modelFamilyOf } = await import('../src/components/generation/genModules.ts');
const { SD_MODELS } = await import('../src/components/generation/modelResolutionOptions.ts');

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

// 谓词输入构造:默认公共模式 + 已登录 + 当前常量后端能力,video 开关按需覆盖
const ctxOf = (model, over = {}) => ({
  model,
  serverMode: 'public',
  isAuthenticated: true,
  backendCapabilities: { ...STUDIO_BACKEND_CAPABILITIES },
  ...over,
});
const withVideo = { backendCapabilities: { img2video: true } };

// ---- 1. 注册表结构 ----
check('三张卡 def 齐全:key 序 = 声明序(inpaint/upscale/img2video),字段齐备', () => {
  assert.deepEqual(
    STUDIO_MODULE_DEFS.map((def) => def.key),
    ['inpaint', 'upscale', 'img2video'],
  );
  for (const def of STUDIO_MODULE_DEFS) {
    assert.equal(typeof def.title, 'string');
    assert.ok(def.title.length > 0, `${def.key} 缺标题`);
    assert.equal(typeof def.subtitle, 'string');
    assert.ok(def.subtitle.length > 0, `${def.key} 缺副标题`);
    assert.equal(typeof def.icon, 'string');
    assert.ok(def.icon.length > 0, `${def.key} 缺图标 token`);
    assert.equal(typeof def.supports, 'function', `${def.key} 缺能力谓词`);
  }
  // studioModuleDef 查表与未知 key 报错
  assert.equal(studioModuleDef('inpaint').key, 'inpaint');
  assert.throws(() => studioModuleDef('bogus'));
});

// ---- 2. inpaint / upscale:模型家族矩阵 ----
// NAI 各家族代表(UI id 与后端模型名均可,modelFamilyOf 归一化,兼容 -inpainting 变体)
const NAI_REPRESENTATIVES = [
  ['v4.5-full', 'nai-4.5'],
  ['v4.5-curated', 'nai-4.5'],
  ['v4-full', 'nai-4'],
  ['v4-curated-preview', 'nai-4'],
  ['v3', 'nai-3'],
  ['nai-diffusion-2', 'nai-legacy'],
  ['nai-diffusion-4-5-full-inpainting', 'nai-4.5'],
];

check('inpaint/upscale:对 NAI 各家族模型可见(家族枚举以 modelFamilyOf 实际返回值为准)', () => {
  for (const [model, expectedFamily] of NAI_REPRESENTATIVES) {
    assert.equal(modelFamilyOf(model), expectedFamily, `${model} 家族判定漂移`);
    for (const key of ['inpaint', 'upscale']) {
      assert.equal(isStudioModuleVisible(key, ctxOf(model)), true, `${key} 对 ${model} 应可见`);
    }
  }
});

check('inpaint/upscale:对非 NAI(SD_MODELS 真值 + 未知型号)不可见', () => {
  assert.ok(SD_MODELS.length > 0, 'SD_MODELS 为空,测试失效');
  const nonNaiModels = [...SD_MODELS.map((item) => item.id), 'some-unknown-model'];
  for (const model of nonNaiModels) {
    assert.equal(modelFamilyOf(model), 'other', `${model} 应归 other 家族`);
    for (const key of ['inpaint', 'upscale']) {
      assert.equal(isStudioModuleVisible(key, ctxOf(model)), false, `${key} 对 ${model} 应不可见`);
    }
  }
});

check('inpaint/upscale:serverMode / isAuthenticated 不参与 gating(运行时门保持卡片现状)', () => {
  const ctx = ctxOf('v4.5-full', { serverMode: 'custom', isAuthenticated: false });
  assert.equal(isStudioModuleVisible('inpaint', ctx), true);
  assert.equal(isStudioModuleVisible('upscale', ctx), true);
});

// ---- 3. img2video:后端能力维度 ----
check('img2video:当前占位常量 STUDIO_BACKEND_CAPABILITIES.img2video === false', () => {
  assert.equal(STUDIO_BACKEND_CAPABILITIES.img2video, false);
});

check('img2video:能力 false 时对任意模型不可见(整卡不渲染)', () => {
  assert.equal(isStudioModuleVisible('img2video', ctxOf('v4.5-full')), false);
  assert.equal(isStudioModuleVisible('img2video', ctxOf(SD_MODELS[0].id)), false);
});

check('img2video:能力 true 时可见,与模型家族无关(非 NAI 能力,未来保障)', () => {
  assert.equal(isStudioModuleVisible('img2video', ctxOf('v4.5-full', withVideo)), true);
  assert.equal(isStudioModuleVisible('img2video', ctxOf(SD_MODELS[0].id, withVideo)), true);
});

// ---- 4. 可见序列 ----
check('visibleStudioModuleKeys:只含可见项,顺序 = 注册表声明序', () => {
  assert.deepEqual(visibleStudioModuleKeys(ctxOf('v4.5-full')), ['inpaint', 'upscale']);
  assert.deepEqual(visibleStudioModuleKeys(ctxOf('v4.5-full', withVideo)), [
    'inpaint',
    'upscale',
    'img2video',
  ]);
  assert.deepEqual(visibleStudioModuleKeys(ctxOf(SD_MODELS[0].id)), []);
  assert.deepEqual(visibleStudioModuleKeys(ctxOf(SD_MODELS[0].id, withVideo)), ['img2video']);
});

// ---- 5. 结构断言(文本扫描) ----
const readSrc = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');

check('结构: MobileStudioPage 经注册表渲染,消费可见性谓词与后端能力常量', () => {
  const src = readSrc('../src/components/mobile/pager/MobileStudioPage.tsx');
  assert.ok(
    src.includes('visibleStudioModuleKeys') || src.includes('isStudioModuleVisible'),
    '页面未消费注册表可见性谓词',
  );
  assert.ok(src.includes('STUDIO_BACKEND_CAPABILITIES'), '页面未消费后端能力常量');
});

check("结构: MobileStudioPage 保留 'studio-open-tool' 事件契约", () => {
  const src = readSrc('../src/components/mobile/pager/MobileStudioPage.tsx');
  assert.ok(src.includes('studio-open-tool'));
});

check('结构: studioModules.ts 不 import react(纯模块,node 可直接加载)', () => {
  const src = readSrc('../src/components/mobile/pager/studioModules.ts');
  assert.equal(src.includes("from 'react'"), false);
  assert.equal(src.includes('from "react"'), false);
});

console.log(`\n${checks} 项创作室模块注册表对等校验全部通过。`);
