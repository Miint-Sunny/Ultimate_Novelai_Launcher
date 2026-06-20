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
cd novelai_web_ui/server
pip install -r requirements.txt
```

## 启动

```bash
# 默认端口 8765
python run.py

# 自定义端口
python run.py --port 8080

# 开发模式（自动重载）
python run.py --reload
```

## API

### HTTP

- `GET /health` - 健康检查

### WebSocket

- `ws://host:port/ws/queue` - 排队连接

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
