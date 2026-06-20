#!/usr/bin/env python3
"""
NovelAI Web UI 后端服务启动脚本

独立运行版本 - 内置图片生成队列，不依赖 Bot

使用方法:
    python run.py [--host HOST] [--port PORT] [--reload]

示例:
    python run.py                    # 默认 0.0.0.0:8765
    python run.py --port 8080        # 使用端口 8080
    python run.py --reload           # 开发模式，自动重载
"""

import argparse
import uvicorn


def main():
    parser = argparse.ArgumentParser(description="NovelAI Web UI Backend Server")
    parser.add_argument("--host", default="0.0.0.0", help="绑定地址 (默认: 0.0.0.0)")
    parser.add_argument("--port", type=int, default=8765, help="端口号 (默认: 8765)")
    parser.add_argument("--reload", action="store_true", help="开发模式，自动重载")
    args = parser.parse_args()

    print(f"""
╔══════════════════════════════════════════════════════════════╗
║           NovelAI Web UI Backend Server v2.0                 ║
║                                                              ║
║  独立运行版 - 内置图片生成队列                               ║
║                                                              ║
║  地址: http://{args.host}:{args.port}                              ║
║  健康检查: http://{args.host}:{args.port}/health                   ║
║  API 文档: http://{args.host}:{args.port}/docs                     ║
╚══════════════════════════════════════════════════════════════╝
    """)

    uvicorn.run(
        "app:app",
        host=args.host,
        port=args.port,
        reload=args.reload,
    )


if __name__ == "__main__":
    main()
