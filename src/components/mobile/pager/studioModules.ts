// 创作室操作卡注册表(纯模块:无 React、无 Tauri、无服务门面导入)
// 与生图页 genModules.ts 同一机制(方案 §5.1/§5.4,思想移植自 Plana gen_modules.dart):
//   - 注册表定死可管理的操作卡,每张卡声明 key/标题/副标题/图标/能力谓词;
//   - 唯一可见性谓词 isStudioModuleVisible 收口卡片渲染:不满足 = 整卡不渲染,
//     无置灰占位(「无可用当前图」是卡按钮上的运行时置灰,与谓词 gating 两层,不进注册表);
//   - 图标以字符串 token 声明(lucide 组件名小写),纯文件不 import React,
//     以便 node --experimental-strip-types 直接加载做 parity 校验(同 P1/P4 装配层约定);
//     页面按 token 映射实际 lucide 组件(同 tag-manager/registry.ts 的 ICON_MAP 范式)。

import { modelFamilyOf, type GenModuleContext } from '../../generation/genModules.ts';

export type StudioModuleKey = 'inpaint' | 'upscale' | 'img2video';

/** 后端能力声明:非 NAI 能力挂这个维度,与当前模型家族无关(方案 §5.1)。 */
export interface StudioBackendCapabilities {
  img2video: boolean;
}

/** 谓词输入 = 生图页同型上下文(模型 × 后端模式 × 登录态)+ 后端能力声明。 */
export interface StudioModuleContext extends GenModuleContext {
  backendCapabilities: StudioBackendCapabilities;
}

// ⚠️ 后端能力常量占位,锚定《后端评审清单》#2:
//   图生视频是「非 NAI 能力」的样例 —— 挂在「后端能力」维度而非模型家族;
//   后端就绪时把这里换成真实能力声明来源(服务/设置读取),调用点只消费本常量,
//   勿散改各使用处。
export const STUDIO_BACKEND_CAPABILITIES: StudioBackendCapabilities = {
  img2video: false,
} as const;

export interface StudioModuleDef {
  key: StudioModuleKey;
  title: string;
  /** 卡内副标题(能力说明小字)。 */
  subtitle: string;
  /** lucide 图标名 token(纯声明,页面映射实际组件,见文件头注释)。 */
  icon: string;
  /** 能力谓词;唯一可见性判定,卡片渲染只消费它。 */
  supports: (ctx: StudioModuleContext) => boolean;
}

// 能力矩阵(与 genModules 静态表同范式,【待后端评审 #1/#2 确认权威矩阵】):
//   - inpaint / upscale:全部 NAI 模型家族可用(经 genModules 的 modelFamilyOf 判定,
//     不自建模型判断);serverMode / isAuthenticated 不参与 gating —— 未登录等运行时
//     门保持卡片现状语义,不进注册表;
//   - img2video:非 NAI 能力,只看后端能力声明;当前常量 false → 整卡不渲染(预注册
//     slot),后端就绪后参数面板随能力声明上线(方案 §5.4)。
const isNaiModel = (model: string): boolean => modelFamilyOf(model).startsWith('nai-');

export const STUDIO_MODULE_DEFS: readonly StudioModuleDef[] = [
  {
    key: 'inpaint',
    title: '重绘',
    subtitle: '局部重绘 / 裁切 / 扩图',
    icon: 'paintbrush',
    supports: (ctx) => isNaiModel(ctx.model),
  },
  {
    key: 'upscale',
    title: '放大',
    subtitle: '超分辨率 2x / 4x',
    icon: 'maximize-2',
    supports: (ctx) => isNaiModel(ctx.model),
  },
  {
    key: 'img2video',
    title: '图生视频',
    subtitle: '当前图生成短视频',
    icon: 'video',
    supports: (ctx) => ctx.backendCapabilities.img2video,
  },
];

export function studioModuleDef(key: StudioModuleKey): StudioModuleDef {
  const def = STUDIO_MODULE_DEFS.find((item) => item.key === key);
  if (!def) throw new Error(`未知创作室模块: ${key}`);
  return def;
}

/** 唯一可见性谓词。卡片渲染只允许走这里。 */
export function isStudioModuleVisible(key: StudioModuleKey, ctx: StudioModuleContext): boolean {
  return studioModuleDef(key).supports(ctx);
}

/** 当前上下文里的可见卡序列:按注册表声明序过滤(顺序稳定)。 */
export function visibleStudioModuleKeys(ctx: StudioModuleContext): StudioModuleKey[] {
  return STUDIO_MODULE_DEFS.filter((def) => def.supports(ctx)).map((def) => def.key);
}
