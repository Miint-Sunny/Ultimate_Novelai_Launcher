# 本地把 app 真跑起来测

写这份是因为「跑不起来」曾经让验证一路退到隔离台和纯逻辑脚本 —— 那两样都证明不了
真实界面和真实载荷。下面这条路子不需要 Tauri 壳,浏览器里就能跑完整 app。

## 为什么浏览器能跑

sidecar 的私有端点要 Bearer 凭据,平时由桌面壳握手拿到。浏览器这条路走**配对码**:
`POST /api/v1/auth/pair` 用进程凭据签一个 6 位码,浏览器拿码换 `access_token`
存进 `sessionStorage`。开发模式下 sidecar **启动时会直接把码打进日志**,不用手动签。

## 两套 sidecar:mock 与真链路

| | mock | 真链路 |
|---|---|---|
| 环境变量 | `ULTIMATE_NOVELAI_LAUNCHER_MOCK_GENERATION=1` | 不设 |
| 出图 | 本地按请求尺寸生成一张渐变 PNG | 真打 NovelAI |
| 花钱 | 不花 | 走账号额度 |
| 能测什么 | 管线、载荷、界面、尺寸相关的计算 | **画面本身**(例如文字渲染有没有真写上去) |

**mock 只能跑流程,证不了出图。** 想验「引号内容有没有真被画进图里」这种,必须走真链路。

真链路的花费:V5 常规分辨率、≤28 步的生成走 **Opus 免费额度**(体力条),不扣 Anlas ——
界面上的估价会显示 `0`。图生图重绘/放大是另一回事,对话框里会显示真实 Anlas 估价,
动手前看一眼。

> mock 图从 2026-08-31 起按**请求尺寸**出。此前是一张 1×1,导致放大档位、裁切、
> 局部重绘全都退到各自的最小值兜底(放大对话框会显示 64×64),看着像界面 bug,
> 其实是夹具太小。

## 启动

三个进程,端口固定:sidecar `38999`、前端 `5173`、临时黑板 `4319`。

```bash
ULTIMATE_NOVELAI_LAUNCHER_SIDECAR_PORT=38999 \
ULTIMATE_NOVELAI_LAUNCHER_SIDECAR_AUTH=dev-local-token \
ULTIMATE_NOVELAI_LAUNCHER_MOCK_GENERATION=1 \
ULTIMATE_NOVELAI_LAUNCHER_ALLOW_DEV_ORIGINS=1 \
ULTIMATE_NOVELAI_LAUNCHER_WEB_ORIGINS=http://localhost:5173 \
ULTIMATE_NOVELAI_LAUNCHER_DATA_DIR=/tmp/nai-dev-sidecar-data \
npm run sidecar
```

想走真链路就去掉 `MOCK_GENERATION` 那行,并换一个 `DATA_DIR`,免得两边的历史混在一起。

### 真链路的 key 放哪

不要写进 `.env`、shell 历史或任何文件。sidecar 只认两处:进程环境变量 `NAI_TOKEN` /
`LLM_API_KEY`(优先,不落盘,适合一次性命令),以及系统钥匙串。钥匙串条目按服务名共享,
**不分数据目录**,所以测试实例直接存会覆盖正式 app 的那把;给它一个命名空间就分开了:

```bash
ULTIMATE_NOVELAI_LAUNCHER_CREDENTIAL_NAMESPACE=test \
uv run --frozen python -m sidecar.credential_cli set novelai
```

命令会关掉回显来读 key,存进 `Ultimate Novelai launcher (test)` 这个钥匙串条目;
`set llm` / `set llm-backup` 同理,`status` 只报「有没有」,`delete` 清掉。起真链路
sidecar 时带同一个 `ULTIMATE_NOVELAI_LAUNCHER_CREDENTIAL_NAMESPACE=test`,它就读这套。

代理走 fake-ip 模式(域名解析成 198.18.x.x)的机器上,public 出站策略默认放行这一段;
用了别的段就配 `ULTIMATE_NOVELAI_LAUNCHER_FAKE_IP_RANGES`,私网段填不进去。

前端另开一个终端:`VITE_SIDECAR_URL=http://127.0.0.1:38999 npm run dev`。

## 让浏览器连上

sidecar 启动日志里那行 `Browser pairing code: NNNNNN`(120 秒有效)。在
`http://localhost:5173` 的控制台里:

```js
const endpoint = 'http://127.0.0.1:38999';
const r = await fetch(`${endpoint}/api/v1/auth/pair/exchange`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ code: '把日志里那六位填这儿' }),
});
sessionStorage.setItem('ultimate_novelai_launcher_sidecar_session', (await r.json()).access_token);
const s = JSON.parse(localStorage.getItem('novelai_app_settings') || '{}');
s.sidecarUrl = endpoint;
localStorage.setItem('novelai_app_settings', JSON.stringify(s));
location.reload();
```

码过期了就重签:

```bash
curl -s -X POST http://127.0.0.1:38999/api/v1/auth/pair \
  -H "Authorization: Bearer dev-local-token" -H "Content-Type: application/json" -d '{}'
```

## 看真正发出去的载荷

界面对不对是一回事,**发出去的那份 JSON 对不对是另一回事** —— V5 的错法大多是
「服务端照收、界面无反馈」。生成任务把完整载荷存下来了,直接查:

```bash
curl -s "http://127.0.0.1:38999/api/v1/generation/jobs?limit=1" \
  -H "Authorization: Bearer dev-local-token" \
  | python3 -c "import sys,json; p=json.load(sys.stdin)['items'][0]['payload']; \
lp=p['legacy_payload']; print(json.dumps({'input':lp['input'],'parameters':lp['parameters']}, ensure_ascii=False, indent=1))"
```

重点看:`input` 末尾有没有 `teXt:` 块、`ucPresetId`/`qualityPresetId` 与
`tag_hint_qt`/`tag_hint_uc_preset` 对不对、V5 上有没有混进数字口径的
`ucPreset`/`qualityToggle`。

## 已知的环境噪声(不是 bug)

- 没配 LLM 时,词条会一直显示「翻译中…」,控制台刷 `[Translate] API 调用失败`。
- 助手面板显示「本地主模型未配置」,固定指令仍可用。

## Agent harness 联调(无 NAI 订阅也能跑)

- 假 LLM:`scripts/dev-mock-llm.py`(父目录 `.claude/launch.json` 里叫 `mock-llm`,38111,无状态,
  按最后一条用户消息选分支):`步数` 读参→改参、`问我` ask_user、`看图` view_canvas_image、
  `联想` suggest_tags、`加角色`、`出图` novelai_generate(走付费闸)、`放大` novelai_upscale、
  `账号` account_info、`把步数改成 N 然后出图` 三连、`回忆` 报上下文里有几条用户消息、`慢` 慢速流(测 Esc 中断)、
  `笔记` context_memory 记两条再 list、`批量词库` 词库 entries[2] → updates[3](含一个不存在的 id)→ ids[] 一起删、
  `读技能` load_skill 先列 `mock-pack` 的资源清单再读第一个文件(要先在预设面板装一个标识为 mock-pack 的技能包并启用)。
- 把 sidecar 槽位指过去:`PATCH /api/v1/settings {llm_base_url:"http://127.0.0.1:38111/v1",
  llm_model:"mock-1", llm_network_scope:"loopback"}`,再 `POST /auth/llm-key {api_key:"假的", slot:"primary"}`。
  **完事必须 `DELETE /auth/llm-key?slot=primary` 并把槽位清空**,
  用 `security find-generic-password -s "Ultimate Novelai launcher" -a llm-api-key` 复核钥匙串干净。
- 生图必须走 `dev-sidecar`(`MOCK_GENERATION=1`):mock 图是按请求尺寸的渐变 PNG,upscale / vibe 也 mock;
  `/api/anlas` 仍是真接口(只读),所以付费闸会估出真实价钱,正好测钱包闸。
  真正发出去的载荷看 `GET /api/v1/generation/jobs?limit=1` 的 `payload.legacy_payload`。
