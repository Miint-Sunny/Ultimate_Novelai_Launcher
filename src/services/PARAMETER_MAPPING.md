# NovelAI API 参数映射文档

> 载荷分两族：**V4 系**（V4 / V4.5）与 **V5**。两族共用大部分字段，但有一组参数
> 我们按官方形状二选一。先读下面的「按模型族分叉的参数」，再看通用表。
> 事实来源：`src/services/novelai.ts` 的载荷构造与 `sidecar/nai/client.py`，
> 对等校验见 `scripts/check-v5-parity.mjs`。

## 按模型族分叉的参数 ⚠️

| API 参数 | V4 系 | V5 | 备注 |
|---------|-------|-----|------|
| `parameters.params_version` | `3` | `4` | V5 传 3 **照样出图**，但角色的自由定位坐标会被静默丢弃 |
| `parameters.ucPreset` | 数字 `0/1/4` | 不发 | 我们只发官方形状，见下方「关于预设口径」 |
| `parameters.qualityToggle` | 布尔 | 不发 | 同上 |
| `parameters.ucPresetId` | 不发 | 字符串 | `heavy` / `light` / `furryFocus` / `humanFocus` / `none` |
| `parameters.qualityPresetId` | 不发 | 字符串 | `standard` / `light` / `none`（现有 UI 只有布尔，映到 standard/none） |
| `parameters.noise_schedule` | 透传用户选择 | 恒 `karras` | V5 隐藏了选择器并强制写死，官方客户端的 sanitizer 就这么做 |
| `parameters.skip_cfg_above_sigma` | Variety+ 开启时 `58`，否则 `null` | 恒 `null` | V5 没有 Variety+ |
| `parameters.straight_alpha` | 不发 | 恒 `true` | 32 通道 VAE 真正吐出 alpha 通道靠它，与用户是否要透明背景无关 |
| `parameters.tag_hint_transparent_background` | 不发 | 勾选透明背景时 `true` | 见 `transparentBackground` |
| `parameters.tag_hint_qt` | 不发 | 质量档的官方编号 | `none`0 `standard`1 `light`3；映射不到就省掉键 |
| `parameters.tag_hint_uc_preset` | 不发 | 负面档的官方编号 | `none`0 `heavy`2 `light`3 `humanFocus`4 `furryFocus`5 |
| `parameters.sm` | 不发 | 不发 | V5 发 `sm: true` 会 **HTTP 500** |

### 关于预设口径：我们发官方形状，但服务端不止收这一种

抓包显示官方客户端在 V5 下发字符串 `ucPresetId` / `qualityPresetId`（外加数字
`tag_hint_qt` / `tag_hint_uc_preset`），所以我们照着发。

> 那两个 tag_hint 曾经**只写在这份文档里、代码从没发过**——服务端照收，本地毫无
> 反馈，是靠把三份实现的字段表对了一遍才发现的。现在补上了，并由
> `check-v5-parity.mjs` 第 31 项钉住。顺带记一条:这张档位提示表和线上那个数字
> `ucPreset` **不是**一张表（前者是官方枚举顺序，后者是可见档位数组的下标），
> 两张都有 heavy/light，很容易看串。

但**「混发会出错」是我们从没验证过的推测，且现有证据是反的**：两个已上线的第三方
客户端（同一作者的 web 端与 Plana-App v1.0.7 移动端，`lib/features/generate/nai_request.dart:198`）
在 V5 上发的都是**数字 `ucPreset` + 布尔 `qualityToggle` + tag_hint**，生产环境跑得好好的。
也就是说服务端今天**两套口径都收**。

我们仍然只发官方形状，理由不是「另一种会报错」，而是**不赌服务端的宽容**——它今天收，
不保证明天还收。`check-v5-parity.mjs` 的第 22 项锁的是「我们发的形状」，不是「服务端的约束」。

`v4_prompt` / `v4_negative_prompt` 的**字段名在 V5 下不变，且仍然必填**——名字里的
"v4" 有误导性，缺了会 HTTP 500。

## 按模型族分叉的能力位

集中定义在 `src/components/generation/modelResolutionOptions.ts` 的
`modelCapabilities()`，UI 一律问它，不要再写死常量。

| 能力 | V4 系 | V5 Full | V5 Curated |
|------|-------|---------|-----------|
| 同框角色上限 | 6 | 32 | 32 |
| 角色位置 | 5×5 网格（A1–E5） | 自由浮点 | 自由浮点 |
| 提示词 token 上限（软阈值） | 512 | 1471 | 703 |
| 噪声调度可选 | 是 | 否 | 否 |
| Variety+ | 是 | 否 | 否 |
| 透明背景 | 否 | 是 | 是 |
| Vibe Transfer / 精确参考 | 是 | **暂缺**（官方仍在训练） | **暂缺** |
| 消耗 Opus 体力条 | 否（Opus 无限） | 是 | 是 |

V5 的 token 计数是**近似值**：V5 换成了 Qwen 分词器，本地计数器仍是 T5/CLIP 口径。

## 计费

V5 单张 = 同规格 V4 价 **× 1.5**，双 ceil，下限 2，上限 140。
实测锚点：832×1216 / 28 步，V4.5 为 20 Anlas，V5 恰为 30。

**Opus 体力条耗尽是静默的**：NovelAI 不报错、不返回 402，照常出图然后开始扣
Anlas。`subscription.usage` 的读数是用户唯一的越界提示，因此 UI 必须显示它。

## 已映射参数 ✅

| API 参数 | 前端组件/状态 | 说明 |
|---------|-------------|------|
| `input` | `positivePrompt` | 正向提示词 |
| `model` | `selectedModel.id` | 模型选择，见下方 MODEL_MAP |
| `parameters.width` | `customWidth` / `resolution.width` | 图像宽度 |
| `parameters.height` | `customHeight` / `resolution.height` | 图像高度 |
| `parameters.scale` | `scale` | Prompt Guidance (引导强度) |
| `parameters.sampler` | `sampler` | 采样器 |
| `parameters.steps` | `steps` | 生成步数 |
| `parameters.seed` | `seed` | 随机种子 (空则随机生成) |
| `parameters.cfg_rescale` | `scaleRescale` | Prompt Guidance Rescale |
| `parameters.negative_prompt` | `negativePrompt` | 负向提示词 |
| `parameters.v4_prompt.caption.base_caption` | `positivePrompt` | 正向提示词（V5 下同名同必填） |
| `parameters.v4_negative_prompt.caption.base_caption` | `negativePrompt` | 负向提示词（同上） |
| `parameters.characterPrompts` | `characterPrompts[]` | 角色提示词数组 |
| `parameters.v4_prompt.caption.char_captions` | `characterPrompts[].positive` | 角色正向提示词 |
| `parameters.v4_negative_prompt.caption.char_captions` | `characterPrompts[].negative` | 角色负向提示词 |
| `parameters.characterPrompts[].center` | `characterPrompts[].center` | 角色位置。连续坐标（0–1），由 `services/characterPosition` 的 `resolveCharacterCenters` 解析：显式 `center` → 旧的 `position`（A1–E5）→ 按人数的默认布局 |

## 部分映射参数 ⚠️

| API 参数 | 前端组件/状态 | 说明 | 缺失部分 |
|---------|-------------|------|---------|
| Vibe Transfer | `activeVibes[]` | 氛围转移 | 需要图像 base64 编码；V5 暂不支持 |
| Image2Image | `img2imgImage`, `img2imgStrength`, `img2imgNoise` | 图生图 | 需要图像 base64 编码 |
| Character Reference | `activeCR` | 角色参考 | 需要图像 base64 编码；V5 暂不支持 |

## 未映射参数 ❌ (使用默认值)

| API 参数 | 默认值 | 说明 | 建议 |
|---------|-------|------|------|
| `parameters.n_samples` | `1` | 生成数量 | 可添加批量生成功能 |
| `parameters.autoSmea` | `false` | 自动 SMEA | 可添加高级设置 |
| `parameters.dynamic_thresholding` | `false` | 动态阈值 | 可添加高级设置 |
| `parameters.controlnet_strength` | `1` | ControlNet 强度 | 需要 ControlNet 功能 |
| `parameters.legacy` | `false` | 旧版模式 | 固定值 |
| `parameters.add_original_image` | `true` | 添加原图 | 固定值 |
| `parameters.legacy_v3_extend` | `false` | V3 扩展 | 固定值 |
| `parameters.use_coords` | `shouldUseCoords(activeCharacters)` | 使用坐标 | 有任一角色被**手动摆过**才为 true；全员「自动」时为 false，把构图交回模型 |
| `parameters.normalize_reference_strength_multiple` | `true` | 归一化参考强度 | 固定值 |
| `parameters.inpaintImg2ImgStrength` | `1` | 修复强度 | 需要 Inpaint 功能 |
| `parameters.v4_prompt.use_coords` | `shouldUseCoords(activeCharacters)` | 使用坐标 | 同上，与顶层保持一致 |
| `parameters.v4_prompt.use_order` | `true` | 使用顺序 | 固定值 |
| `parameters.v4_negative_prompt.legacy_uc` | `false` | 旧版 UC | 固定值 |
| `parameters.legacy_uc` | `false` | 旧版 UC | 固定值 |
| `parameters.deliberate_euler_ancestral_bug` | `false` | Euler Bug | 固定值 |
| `parameters.prefer_brownian` | `true` | 布朗运动 | 固定值 |
| `parameters.image_format` | `'png'` | 图像格式 | V5 透明背景依赖 PNG，勿改成 JPEG |
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
2. **质量预设三档选择器** - 直接传 `qualityPresetId`，取代现有布尔
3. **Anime⇄Furry 数据集开关** - V5 用它取代独立的 furry 模型
4. **高级设置面板**:
   - `autoSmea` - 自动 SMEA
   - `dynamic_thresholding` - 动态阈值
   - `skip_cfg_above_sigma` - CFG 跳过阈值（仅 V4 系）
5. **Vibe Transfer / Image2Image / Character Reference 完整实现** - 需要图像上传和 base64 编码
6. **ControlNet 支持** - 需要额外的 API 参数

其余 V5 待办（多段传输、Qwen 分词器、文字渲染辅助等）见
`docs_and_plan/v5-upgrade-plan.md` 的 P7 backlog。

## 模型映射

```typescript
const MODEL_MAP = {
  'v5-full': 'nai-diffusion-5-full',
  'v5-curated': 'nai-diffusion-5-curated',
  'v4.5-full': 'nai-diffusion-4-5-full',
  'v4.5-curated': 'nai-diffusion-4-5-curated',
  'v4-full': 'nai-diffusion-4-full',
  'v4-curated-preview': 'nai-diffusion-4-curated-preview',
  'v3': 'nai-diffusion-3',
};
```

判定是否 V5 用 `isV5Model()`，不要自己比字符串：它同时接受 UI id 与后端模型名，
兼容 `-inpainting` 变体，并把公测期的暂存 id `custom` 也认成 V5。

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

V4 系用数字枚举：

```typescript
const UC_PRESET_MAP = {
  'heavy': 0,  // 重度质量标签
  'light': 1,  // 轻度
  'none': 4,   // 无
};
```

V5 改用字符串 id，预设正文见 `src/services/naiV5Presets.ts`（逐字抄自官方，
不要凭印象重写）：

```typescript
toV5UcPresetId(preset)        // -> 'heavy' | 'light' | 'furryFocus' | 'humanFocus' | 'none'
toV5QualityPresetId(toggle)   // -> 'standard' | 'light' | 'none'
```
