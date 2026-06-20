# NovelAI API 参数映射文档

## 已映射参数 ✅

| API 参数 | 前端组件/状态 | 说明 |
|---------|-------------|------|
| `input` | `positivePrompt` | 正向提示词 |
| `model` | `selectedModel.id` | 模型选择 (v4.5-full, v4.5-curated, v3) |
| `parameters.width` | `customWidth` / `resolution.width` | 图像宽度 |
| `parameters.height` | `customHeight` / `resolution.height` | 图像高度 |
| `parameters.scale` | `scale` | Prompt Guidance (引导强度) |
| `parameters.sampler` | `sampler` | 采样器 |
| `parameters.steps` | `steps` | 生成步数 |
| `parameters.seed` | `seed` | 随机种子 (空则随机生成) |
| `parameters.cfg_rescale` | `scaleRescale` | Prompt Guidance Rescale |
| `parameters.noise_schedule` | `noiseSchedule` | 噪声调度 (karras, exponential, polyexponential) |
| `parameters.ucPreset` | `activePresetId` | UC 预设 (heavy=0, light=1, none=4) |
| `parameters.qualityToggle` | 预设相关 | 质量开关 |
| `parameters.negative_prompt` | `negativePrompt` | 负向提示词 |
| `parameters.v4_prompt.caption.base_caption` | `positivePrompt` | V4 正向提示词 |
| `parameters.v4_negative_prompt.caption.base_caption` | `negativePrompt` | V4 负向提示词 |
| `parameters.characterPrompts` | `characterPrompts[]` | 角色提示词数组 |
| `parameters.v4_prompt.caption.char_captions` | `characterPrompts[].positive` | 角色正向提示词 |
| `parameters.v4_negative_prompt.caption.char_captions` | `characterPrompts[].negative` | 角色负向提示词 |

## 部分映射参数 ⚠️

| API 参数 | 前端组件/状态 | 说明 | 缺失部分 |
|---------|-------------|------|---------|
| `parameters.characterPrompts[].center` | `characterPrompts[].position` | 角色位置 | 需要将 A1-E5 转换为坐标 |
| Vibe Transfer | `activeVibes[]` | 氛围转移 | 需要图像 base64 编码 |
| Image2Image | `img2imgImage`, `img2imgStrength`, `img2imgNoise` | 图生图 | 需要图像 base64 编码 |
| Character Reference | `activeCR` | 角色参考 | 需要图像 base64 编码 |

## 未映射参数 ❌ (使用默认值)

| API 参数 | 默认值 | 说明 | 建议 |
|---------|-------|------|------|
| `parameters.params_version` | `3` | 参数版本 | 固定值 |
| `parameters.n_samples` | `1` | 生成数量 | 可添加批量生成功能 |
| `parameters.autoSmea` | `false` | 自动 SMEA | 可添加高级设置 |
| `parameters.dynamic_thresholding` | `false` | 动态阈值 | 可添加高级设置 |
| `parameters.controlnet_strength` | `1` | ControlNet 强度 | 需要 ControlNet 功能 |
| `parameters.legacy` | `false` | 旧版模式 | 固定值 |
| `parameters.add_original_image` | `true` | 添加原图 | 固定值 |
| `parameters.legacy_v3_extend` | `false` | V3 扩展 | 固定值 |
| `parameters.skip_cfg_above_sigma` | `58` | 跳过 CFG 阈值 | 可添加高级设置 |
| `parameters.use_coords` | `charCaptions.length > 0` | 使用坐标 | 有角色提示词时为 true，否则 false |
| `parameters.normalize_reference_strength_multiple` | `true` | 归一化参考强度 | 固定值 |
| `parameters.inpaintImg2ImgStrength` | `1` | 修复强度 | 需要 Inpaint 功能 |
| `parameters.v4_prompt.use_coords` | `charCaptions.length > 0` | V4 使用坐标 | 有角色提示词时为 true，否则 false |
| `parameters.v4_prompt.use_order` | `true` | V4 使用顺序 | 固定值 |
| `parameters.v4_negative_prompt.legacy_uc` | `false` | 旧版 UC | 固定值 |
| `parameters.legacy_uc` | `false` | 旧版 UC | 固定值 |
| `parameters.deliberate_euler_ancestral_bug` | `false` | Euler Bug | 固定值 |
| `parameters.prefer_brownian` | `true` | 布朗运动 | 固定值 |
| `parameters.image_format` | `'png'` | 图像格式 | 可添加格式选择 |
| `parameters.stream` | `'msgpack'` | 流格式 | 固定值 |
| `use_new_shared_trial` | `true` | 新试用 | 固定值 |

## 请求头参数

| Header | 说明 | 来源 |
|--------|------|------|
| `authorization` | Bearer Token | Python sidecar credential store |
| `x-correlation-id` | 关联 ID | 随机生成 6 位字符 |
| `x-initiated-at` | 请求时间 | `new Date().toISOString()` |

## 建议添加的前端功能

1. **批量生成** - 添加 `n_samples` 参数控制
2. **图像格式选择** - PNG/JPEG/WebP
3. **高级设置面板**:
   - `autoSmea` - 自动 SMEA
   - `dynamic_thresholding` - 动态阈值
   - `skip_cfg_above_sigma` - CFG 跳过阈值
4. **Vibe Transfer 完整实现** - 需要图像上传和 base64 编码
5. **Image2Image 完整实现** - 需要图像上传和 base64 编码
6. **Character Reference 完整实现** - 需要图像上传和 base64 编码
7. **ControlNet 支持** - 需要额外的 API 参数

## 模型映射

```typescript
const MODEL_MAP = {
  'v4.5-full': 'nai-diffusion-4-5-full',
  'v4.5-curated': 'nai-diffusion-4-5-curated',
  'v3': 'nai-diffusion-3',
};
```

## Sampler 映射

```typescript
const SAMPLER_MAP = {
  'Euler Ancestral': 'k_euler_ancestral',
  'Euler': 'k_euler',
  'DPM++ 2S Ancestral': 'k_dpmpp_2s_ancestral',
  'DPM++ 2M SDE': 'k_dpmpp_2m_sde',
  'DPM++ 2M': 'k_dpmpp_2m',
  'DPM++ SDE': 'k_dpmpp_sde',
};
```

## UC Preset 映射

```typescript
const UC_PRESET_MAP = {
  'heavy': 0,  // 重度质量标签
  'light': 1,  // 轻度
  'none': 4,   // 无
};
```
