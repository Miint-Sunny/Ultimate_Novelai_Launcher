> ⚠️ **LEGACY / 已隔离（quarantined）**
>
> 本目录是参考项目遗留的旧版独立后端单体（`app.py`，约 9k 行），直接调用 NovelAI 生图 / vibe / upscale / anlas，并自带队列与 Bot 授权。
> 桌面端的活跃实现已迁移到仓库根的 `sidecar/`（FastAPI sidecar），前端只通过 `src/api/sidecar.ts` 访问 sidecar。
>
> 维护约束：
> - 不要在 `server/app.py` 新增功能；新行为请加到 `sidecar/`。
> - 仅作为可选的云 / 队列 / workshop 适配面保留，按职责小步拆 routers/services 后逐步下线，禁止 big-bang 重写。
> - 日志中禁止出现 token / cookie / Authorization / 完整 base64 图片。

---

# NovelAI Web UI 后端服务

排队系统后端服务，用于多用户共享Token时的单线程队列管理。

## 功能特点

- **Token安全**：服务器只接收Token哈希（前8位的SHA256），不接触完整Token
- **IP分散**：实际API调用在用户浏览器进行，每个用户IP独立
- **可选排队**：用户可在设置中自由开启/关闭排队模式
- **实时通知**：通过WebSocket实时推送队列状态

## 安装

```bash
cd Ultimate_Novelai_launcher
uv sync --frozen
```

## 启动

```bash
# 默认端口 8765
uv run python server/run.py

# 自定义端口
uv run python server/run.py --port 8080

# 开发模式（自动重载）
uv run python server/run.py --reload
```

## API

### HTTP

- `GET /health` - 健康检查
- `POST /api/generate` - 匿名提交生成任务；响应包含仅可访问该任务的
  `capability_token`
- `GET /api/task/{task_id}` - 已登录 Bot 客户端带 `session_id`；匿名客户端带
  `Authorization: Bearer <capability_token>`
- `DELETE /api/task/{task_id}` - 与查询使用相同的 owner/capability 校验

### Bot 配对与会话

1. 浏览器调用 `POST /api/bot/auth/generate`，得到可展示的六位 `code` 和仅由该
   浏览器保存的高熵 `poll_token`。
2. Bot 使用 `X-Bot-Secret` 调用 `POST /api/bot/auth/verify` 确认六位码。六位码
   不是会话凭据，不能用来轮询或读取会话。
3. 浏览器向 `POST /api/bot/auth/check` 同时提交 `code` 与 `poll_token`。会话只会
   返回一次；错误令牌会限次，挑战五分钟后过期。

生产环境必须设置 `BOT_SHARED_SECRET`，缺失时 Bot 服务端操作失败关闭并返回
503。会话以 owner-only、原子 JSON 存放在 `BOT_SESSIONS_FILE`（默认
`BOT_DATA_DIR/sessions.json`）；临时配对码和轮询令牌绝不落盘。

跨源网页客户端必须把完整 origin（scheme、host、port）加入
`LEGACY_CORS_ORIGINS` 的逗号分隔列表。服务端不接受 `*`，也不启用跨源 cookie；
桌面 Tauri 与常用本地开发 origin 已列在 `config.example.py` 的默认值中。
请求体按 ASGI 实际收到的字节计数：全局上限 72 MiB，认证/控制请求为 64 KiB，
文本上下文为 4 MiB，单资产兼容上传为 32 MiB。

### WebSocket

- `ws://host:port/ws/queue` - 排队连接
- `ws://host:port/ws/task/{task_id}` - 单任务进度；握手子协议使用
  `job-capability.<capability_token>`，不把凭据放进 URL
- `ws://host:port/ws/bot` - Bot 用户任务流；握手子协议使用
  `bot-session.<session_id>`。服务端在 `accept()` 前验证身份，连接建立后不可
  重新绑定为另一个会话。

#### 消息格式

**加入队列**
```json
{
  "action": "join_queue",
  "token_hash": "sha256(token前8位)",
  "user_id": "可选的用户标识"
}
```

**离开队列**
```json
{
  "action": "leave_queue"
}
```

**完成生成**
```json
{
  "action": "done",
  "ticket": "任务票据"
}
```

**心跳**
```json
{
  "action": "heartbeat"
}
```

#### 服务器推送

**加入成功**
```json
{
  "action": "joined",
  "ticket": "任务票据",
  "position": 1,
  "message": "已加入队列，当前位置: 1"
}
```

**位置更新**
```json
{
  "action": "position_update",
  "position": 2,
  "queue_size": 5
}
```

**轮到你了**
```json
{
  "action": "your_turn",
  "ticket": "任务票据",
  "message": "轮到你了，请开始生成"
}
```

## 工作流程

1. 用户在Web端启用排队模式
2. 点击生成时，浏览器连接排队服务器
3. 发送 `join_queue` 加入队列
4. 等待 `your_turn` 通知
5. 收到通知后，浏览器直接调用NovelAI API生成图片
6. 生成完成后发送 `done` 释放队列位置

## 部署建议

- 本地使用：直接运行，默认 `http://localhost:8765`
- 公网部署：建议使用反向代理（nginx）并启用HTTPS/WSS
- 公网部署必须配置独立的 `BOT_SHARED_SECRET`；不要复用管理员令牌或任务
  capability 密钥。可选额度账本启用后，生成提交必须携带 `Idempotency-Key`。
