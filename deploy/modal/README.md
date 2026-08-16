# Modal 通道部署（运营者侧）

私域 server → Modal 的突发算力通道。终端用户不直连 modal.run,只有
server 需要能访问它(海外 VPS 或代理环境)。

## 前置

- Modal 账号(免费档每月送 $30 额度;大陆注册/付款需代理 + 虚拟卡)
- 本机(或任一能出海的机器)`pip install modal && modal setup`
- **工作流未定稿前此模板不可出图** —— `comfy_app.py` 里的 TODO 标记了
  需要填充的三处:模型权重下载、自定义节点、workflow JSON + 节点修补。

## 步骤

1. 把定稿的 API-format 工作流放进 `workflows/<model_id>.json`
   (ComfyUI 界面 → 开发者模式 → Save (API Format));
   在 `comfy_app.py` 的 `_run_workflow` 里补节点修补逻辑
   (参照 `server/agent_router/anima_provider.py::_patch_anima_payload`)。
2. 部署:`modal deploy comfy_app.py` → 记下输出的 web endpoint URL。
3. 签发 proxy-auth token:Modal 控制台 → Settings → Proxy Auth Tokens。
4. 填 server 配置(`server/config.py`):

   ```python
   MODAL_COMFY_ENDPOINT = "https://<workspace>--unl-comfy-comfyservice-generate.modal.run"
   MODAL_COMFY_TOKEN_ID = "wk-..."
   MODAL_COMFY_TOKEN_SECRET = "ws-..."
   MODAL_COMFY_MODEL_IDS = ["modal-anime-xl"]   # 认领的 model_id,与 workflows/ 文件名一致
   ```

5. 重启 server。workshop 请求带上述 model_id 时即路由到 Modal;
   配额/取消/恢复与其他 workshop 后端一致。

## 成本纪律

- 空闲缩容默认 5 分钟(`scaledown_window=300`),**不要**设常驻
  `min_containers`(L40S 常开 ≈ $1,405/月);会话密集期临时调,用完降回。
- 模型权重放 Volume(`unl-comfy-models`,$0.09/GiB/月),镜像保持小。
- 内存快照已开启(冷启动 ~3s 级;首次仍需 1-2 分钟拉起)。

## 故障预案

Modal 2026 年 5-6 月有过故障群发。server 侧该 model_id 失败时返回明确错误,
用户可切回 NAI/其他通道;不要把 Modal 设为唯一后端。
