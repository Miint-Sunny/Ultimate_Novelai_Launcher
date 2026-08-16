# ruff: noqa
"""Modal App 模板：无头 ComfyUI 出图端点（运营者侧部署，不进 server 依赖）。

与 server/workshop_providers/modal_comfy.py 的契约对齐：
  POST <endpoint>  headers: Modal-Key / Modal-Secret（proxy-auth token）
  body: {"model": str, "prompt": str, "aspect_ratio": str, "images": [dataURI...]}
  返回: {"success": bool, "image_base64": str, "mime_type": str, "elapsed": float, "error": str}

部署步骤见同目录 README.md。工作流 JSON（workflow_api.json）尚未定稿 ——
用户明确「先搭骨架不测图」；TODO 标记处等有成熟工作流后填充。

配方来源：Modal 官方 ComfyUI 示例（2026-03 从 modal-examples 移除，配方仍有效，
考古 ref c7c0e3f）+ 内存快照冷启动优化（社区验证 ~3s）。
"""

import json
import subprocess
import time
import uuid
from pathlib import Path

import modal

# ---------------------------------------------------------------- 镜像与模型

COMFY_VERSION = "0.3.71"  # TODO: 与本地验证过的版本对齐

image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("git")
    .uv_pip_install("comfy-cli==1.5.3", "fastapi[standard]")
    .run_commands(
        f"comfy --skip-prompt install --fast-deps --nvidia --version {COMFY_VERSION}",
    )
    # TODO: 需要的自定义节点在此安装，例如：
    # .run_commands("comfy node install --fast-deps was-node-suite-comfyui@3.0.1")
)

# 模型权重放 Volume：镜像保持小体积，冷启动只挂载不重拉。
models_volume = modal.Volume.from_name("unl-comfy-models", create_if_missing=True)
MODELS_DIR = "/models"

# TODO: 首次准备权重（示例：huggingface_hub 下载到 Volume 后 symlink 进 ComfyUI）。
# def _download_models() -> None:
#     from huggingface_hub import hf_hub_download
#     hf_hub_download("Comfy-Org/...", "....safetensors", cache_dir=MODELS_DIR)
# image = image.run_function(_download_models, volumes={MODELS_DIR: models_volume})

app = modal.App("unl-comfy", image=image)

# ---------------------------------------------------------------- 服务类


@app.cls(
    gpu="L40S",  # 图像够用；Wan 2.2 视频换 A100/H100 档
    volumes={MODELS_DIR: models_volume},
    scaledown_window=300,  # 空闲 5 分钟缩容；会话密集期可临时调 min_containers
    enable_memory_snapshot=True,  # CPU 内存快照：ComfyUI 进程初始化不重复付费
    timeout=1800,
)
@modal.concurrent(max_inputs=4)
class ComfyService:
    @modal.enter(snap=True)
    def launch_comfy(self) -> None:
        """快照阶段：起 ComfyUI（CPU 侧初始化进入快照，冷启动 ~3s 级）。"""
        subprocess.Popen(
            "comfy launch --background -- --listen 0.0.0.0 --port 8188",
            shell=True,
        )
        self._wait_healthy(timeout_s=120)

    def _wait_healthy(self, timeout_s: float) -> None:
        import urllib.request

        deadline = time.monotonic() + timeout_s
        while time.monotonic() < deadline:
            try:
                with urllib.request.urlopen("http://127.0.0.1:8188/system_stats", timeout=5):
                    return
            except Exception:
                time.sleep(1)
        raise RuntimeError("ComfyUI did not become healthy in time")

    def _run_workflow(self, model: str, prompt: str, aspect_ratio: str) -> Path:
        """按 model 选工作流模板、修补节点、同步跑完，返回输出文件路径。

        TODO(工作流未定稿): 把定稿的 API-format workflow JSON 放进
        deploy/modal/workflows/<model>.json，在此按固定节点号修补
        （正/负向 CLIPTextEncode、EmptyLatentImage 尺寸、KSampler 种子——
        参照 server/agent_router/anima_provider.py 的 _patch_anima_payload 模式）。
        """
        workflow_path = Path(__file__).parent / "workflows" / f"{model}.json"
        if not workflow_path.exists():
            raise RuntimeError(f"workflow template for model {model!r} is not provisioned yet")
        workflow = json.loads(workflow_path.read_text("utf-8"))
        _ = (prompt, aspect_ratio)  # TODO: 节点修补
        client_file = Path(f"/tmp/{uuid.uuid4().hex}.json")
        client_file.write_text(json.dumps(workflow), "utf-8")
        subprocess.run(
            f"comfy run --workflow {client_file} --wait --timeout 1500",
            shell=True,
            check=True,
        )
        output_dir = Path("/root/comfy/ComfyUI/output")
        outputs = sorted(output_dir.glob("**/*.png"), key=lambda p: p.stat().st_mtime)
        if not outputs:
            raise RuntimeError("workflow produced no output image")
        return outputs[-1]

    @modal.fastapi_endpoint(method="POST", requires_proxy_auth=True)
    def generate(self, body: dict) -> dict:
        """server/workshop_providers/modal_comfy.py 调用的唯一入口。"""
        import base64

        started = time.monotonic()
        try:
            output = self._run_workflow(
                model=str(body.get("model") or ""),
                prompt=str(body.get("prompt") or ""),
                aspect_ratio=str(body.get("aspect_ratio") or "auto"),
            )
            encoded = base64.b64encode(output.read_bytes()).decode("ascii")
            return {
                "success": True,
                "image_base64": encoded,
                "mime_type": "image/png",
                "elapsed": time.monotonic() - started,
            }
        except Exception as exc:  # 失败封闭；不泄露内部路径
            return {"success": False, "error": str(exc)[:500]}
