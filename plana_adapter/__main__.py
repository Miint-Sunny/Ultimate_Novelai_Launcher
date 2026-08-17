"""独立进程入口:``uv run --frozen python -m plana_adapter``。

环境变量:
  PLANA_ADAPTER_UPSTREAM   (必需) 云宿主基址,如 https://nai.example.com
  PLANA_ADAPTER_HOST       (默认 127.0.0.1)
  PLANA_ADAPTER_PORT       (默认 8765)
  PLANA_ADAPTER_TIMEOUT / _GENERATE_TIMEOUT / _MAX_PENDING_CODES  见 config.py
"""

from __future__ import annotations

import uvicorn

from .app import create_app
from .config import ConfigError, load_config


def main() -> None:
    try:
        config = load_config()
    except ConfigError as exc:
        raise SystemExit(f"[plana_adapter] 配置错误: {exc}") from exc
    app = create_app(config)
    print(
        f"[plana_adapter] 监听 {config.host}:{config.port} → 上游 {config.upstream_base}"
    )
    uvicorn.run(app, host=config.host, port=config.port, log_level="info")


if __name__ == "__main__":
    main()
