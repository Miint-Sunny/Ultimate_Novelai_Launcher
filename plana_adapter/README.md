# Plana 协议适配器

一个**独立的反向代理进程**,让 [Plana](https://github.com/mc5024/Plana-App)
客户端(朋友的 Flutter NAI 客户端)能连本项目的云宿主(`server/app.py`)。

宿主代码零改动。适配器对外说 Plana 的 bot 后端协议方言,把请求翻译后转发到
宿主的原生端点。可单独部署、单独开关、单独下线。

```
Plana 客户端  ──(Plana 协议)──▶  plana_adapter  ──(宿主原生方言)──▶  server/app.py
```

## 为什么需要它

两边协议同源(共同祖先),差异只来自本项目 dev 分支后来的三处安全加固,
适配器把它们收敛在传输层:

| 差异 | 适配器的翻译 |
|---|---|
| 授权 `generate` 多返 `poll_token`(反爆破),Plana 不认 | 截获并代管 `code→poll_token`,`check` 时补回;Plana 只看到 `{code, expires_in}` |
| 任务轮询 Plana 用 `GET /api/bot/task/{id}`(Bearer),宿主是 `POST /api/bot/task`(body) | 路径与认证互转,并映射状态词 `cancelling→generating`、`interrupted→failed` |
| `image_backend` Plana 放顶层,宿主从 `params` 读 | 下沉进 `params` |
| 宿主库/统计端点认 `X-Bot-Session`,Plana 只发 `Authorization: Bearer` | 通用透传时把 Bearer 桥成 `X-Bot-Session` |
| 宿主开配额账本时要 `Idempotency-Key` | 每次生成代发唯一键(循环生成同参数连抽,故不用 params hash) |
| WS 身份绑定:Plana 匿名连上后发 `bind_session`;宿主握手期从子协议 `bot-session.<sid>` 取会话,**收到 `bind_session` 会 close 4403** | `/ws/bot` 双向代理:对下游两种方言都接受,对上游一律用子协议连;`bind_session` 只用于绑定、绝不转发给宿主 |

其余端点(`validate` / `verify` / `anlas` / `wd-tagger` / 公开 tags 等)原样透传。

WS 在 Plana 协议里是**可选**链路(客户端有 2.5s 轮询兜底),代理里任何 WS 失败都以
关闭连接收场,让客户端退回轮询 —— 不会把错误伪装成正常进度。走 WS 的收益是
**中间预览图与细粒度进度**。

## 运行

```bash
PLANA_ADAPTER_UPSTREAM=https://你的宿主地址 \
  uv run --frozen python -m plana_adapter
```

Plana 客户端把后端地址填成适配器的 `http://<host>:<port>` 即可。

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `PLANA_ADAPTER_UPSTREAM` | (必需) | 云宿主基址,http(s),不含 `/api` |
| `PLANA_ADAPTER_HOST` | `127.0.0.1` | 监听地址 |
| `PLANA_ADAPTER_PORT` | `8765` | 监听端口 |
| `PLANA_ADAPTER_TIMEOUT` | `30` | 转发上游超时(秒) |
| `PLANA_ADAPTER_GENERATE_TIMEOUT` | `120` | 生成提交超时(秒) |
| `PLANA_ADAPTER_MAX_PENDING_CODES` | `2000` | 代管 poll_token 的内存上限 |

## dev 站联调拓扑

```
                          ┌── Plana 客户端(Android)──▶ plana_adapter ──┐
                          │                              :8765          │
   dev 站(我们的宿主)◀──┤                                             │
                          └── 我们的 web 前端(custom 模式)────────────┘
                                 │
                                 └─ 直接填 dev 站地址 = 走我们自己的方言
                                    填 adapter 地址   = 走 Plana 方言
```

**联调技巧**:我们的 web 前端在 `serverMode='custom'` 下把后端地址填成
**适配器地址**,就能在不碰对方服务器的前提下,端到端验证"客户端说 Plana 方言"
这条路(方向二)。适配器对下游同时接受两种方言,所以它既是 Plana 客户端的入口,
也是我们自己客户端的 Plana 方言陪练。

## 安全须知

- 适配器不持久化任何东西,不解析业务语义,不持有 NAI/LLM 密钥;它只搬字节 +
  补协议差异。
- `code→poll_token` 代管把"6 位码不可抢 session"的加固降回了旧水平(适配器
  下游即 Plana,本就信任)。**适配器应部署在受信网络内、或加自身的接入控制**,
  不要直接裸露公网。
- Bearer→`X-Bot-Session` 桥接只在适配器出站方向发生,不回传任何跨源凭据。

## 测试

```bash
npm run test:adapter
```

用内存假上游(挂 httpx ASGITransport)端到端验证翻译层,无网络、不碰真实后端。
