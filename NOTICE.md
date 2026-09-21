# 第三方代码与资产的署名

本项目以 GPL-3.0 发布(见 [LICENSE](LICENSE))。其中若干部分来自他人的开源项目。
本文列出**我们真正搬用过的**来源,以及各自协议要求的声明。只读过、没有取用的项目不在此列。

按协议要求,MIT 部分必须随分发保留原始版权声明与许可全文,下方逐条照录。
Apache-2.0 部分保留出处并说明我们做了改动。GPL-3.0 部分与本项目同协议。

---

## 致谢

这个项目是站在几个人的工作上做出来的。许可义务写在下面各节,这一节不替代它们,
只是把人记下来。

- **mc5024** —— 本项目最初的代码基础来自他。后来绝大部分已经重写,但起点是他给的。
- **saltysalrua** —— Novelai-harness(§1)。桌面端助手那一整条实现线的来源,
  包括我们逐字沿用的工具契约。
- **Aaalice233** 与 **rabiarabbit** —— Aaalice_NAI_Launcher(§2)。分词器资产、
  质量档表与请求格式回退的参照。

---

## 1. Novelai-harness — MIT

- 上游:<https://github.com/saltysalrua/Novelai-harness>
- 本项目实际对照的是该仓库的 fork <https://github.com/Miint-Sunny/Novelai-harness>

**取用范围(最大的一处)**:桌面端 Agent「工作台助手」几乎整条实现线。包括但不限于——

| 我们的文件 | 对应上游 |
|---|---|
| `src/services/agentHarness/harness.ts` | `lib/core/harness/agent_harness.dart`(单循环、上下文压缩) |
| `src/services/agentHarness/openaiStream.ts` | `providers/openai_provider.dart`(流式解析、usage 口径) |
| `src/services/agentHarness/contextMemory.ts` | `context_memory.dart` |
| `src/services/agentHarness/replyMarker.ts` | `reply_marker.dart` |
| `src/services/agentHarness/thinkingFormat.ts` | 思考参数兼容矩阵 |
| `src/services/agentHarness/presetTransfer.ts` | `PresetTransferService` |
| `src/services/agentHarness/tools/*` | `tools/` —— **工具的 `name` / `description` / JSON schema 为逐字沿用**,因为上游的技能文本点名了这些工具名 |
| `src/services/agentHarness/skills.ts` 内置技能 | 上游两个内置技能正文 |
| 水印导出引擎(`src/components/watermark/`、`src/utils/watermark*`) | 上游水印管线 |

```
MIT License

Copyright (c) 2026 saltysalrua

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## 2. Aaalice_NAI_Launcher — MIT

- <https://github.com/Aaalice233/Aaalice_NAI_Launcher>

**取用范围**:

- `src/assets/tokenizer/qwen35_bpe.txt.gz` —— NovelAI V5 提示词计数用的 Qwen 3.5 BPE 资产。
  本仓库提交的这份**逐字节同源**于该项目已提交的 `assets/data/tokenizers/qwen35_bpe.txt.gz`
  (重建脚本与校验见 `scripts/build-qwen-tokenizer-asset.mjs`)。资产本身的原始内容来自
  NovelAI 官方分词器定义,我们经由该 MIT 项目取得。
- 质量档标签表(`scripts/check-preset-tiers.mjs` 钉住的表文)源自其 `modelQualityTags`。
- 旧版预设变体的取值参照其 `legacyPresetVariants`。
- `sidecar/nai/client.py` 的请求格式回退白名单照其实现,未放宽。

```
MIT License

Copyright (c) 2026 NAI Launcher Contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## 3. novelai-python — Apache-2.0

- <https://github.com/LlmKira/novelai-python>

**取用范围**:`src/services/costCalculator.ts` 的 Anlas 计价逻辑移植自其 `CostCalculator`。

**我们做的改动**(Apache-2.0 §4 要求声明):补了 V5 的 1.5× 系数与双重取整、Opus
体力条耗尽后的计费、模型能力位对参考图附加费的过滤,以及导演工具的 `3×base+5` 档。
这些改动的依据是我们自己的真链路实测,不来自上游。

## 4. Plana-App — GPL-3.0

- fork:<https://github.com/Miint-Sunny/Plana-App>(原作者 mc5024)

**取用范围**:竖屏形态的设计参照;`src/components/generation/genModules.ts` 与
`src/components/mobile/pager/studioModules.ts` 的分块机制移植自其 `gen_modules.dart`
(**思想对齐,未照抄代码**);`scripts/check-auto-text.mjs` 以其 `auto_text.dart` 为对齐基准。

该项目与本项目同为 GPL-3.0。

## 5. nai-autocomplete

- 离线词典联想的排序(`sidecar/api/v1/tags.py` 的 `dictionary` 来源)照该扩展的
  `searchTags` 实现。

---

## 未在此列的第三方内容

- **npm / PyPI 依赖**:各自协议见 `package.json`、`pyproject.toml` 与对应锁文件,
  不在本文逐条重复。
- **NovelAI 官方的请求格式、参数语义与提示词词表**:属于对公开接口行为的记录,
  不是代码取用。本项目与 NovelAI 官方无任何关联。
- **`src/assets/tokenizer/t5_tokenizer.json`**:V4 / V4.5 提示词计数用的 T5 分词器表,
  内容出自 NovelAI 官方分词器,与 §2 的 Qwen 资产同属「记录官方接口行为」而非代码取用。
  该表是否随官方改版而更新,本项目未做跟踪。
