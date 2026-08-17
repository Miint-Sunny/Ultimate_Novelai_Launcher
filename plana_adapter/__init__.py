"""Plana 协议适配器:一个独立的反向代理进程。

对外说 Plana 客户端(朋友的 Flutter NAI 客户端)的 bot 后端协议方言,把请求
翻译后转发到本项目的云宿主(`server/app.py`)原生端点。宿主代码零改动 —— 适配器
是一个可单独部署、单独开关的旁路进程,连它的是 Plana,它连的是后端。

两边协议同源(共同祖先),差异只在 dev 分支后来的安全加固处;适配器把这些差异
收敛在传输层:授权 poll_token 代管、任务轮询路径与状态词映射、Bearer→会话通道。
"""

from __future__ import annotations

__all__ = ["__version__"]

__version__ = "0.1.0"
