from __future__ import annotations

import base64
import struct
import zlib
from pathlib import Path

from .config import Settings

_ONE_PIXEL_PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII="
)

#: mock 图的边长上限。真实出图尺寸远在此之下(总像素上限 1024×3072),
#: 这个夹取只是防止畸形请求让我们在测试路径上分配几百 MB。
_MOCK_MAX_SIDE = 4096


def _png_chunk(tag: bytes, data: bytes) -> bytes:
    return (
        struct.pack(">I", len(data))
        + tag
        + data
        + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
    )


def mock_png(width: int, height: int) -> bytes:
    """
    按**请求尺寸**生成一张 mock PNG(纯 stdlib,不引 Pillow)。

    为什么不继续用那张 1×1:任何依赖图像尺寸的功能 —— 放大档位、图生图重绘、
    裁切、局部重绘 —— 在 1×1 上都算不出真东西(放大对话框会显示成 64×64,
    那是前端的最小值兜底,不是真结果)。于是 mock 模式只能证明"管线跑得通",
    证明不了"尺寸算得对"。按请求尺寸出图之后这些才真正可测。

    画面是一条对角渐变(红随 x、绿随 y),方向一眼可辨 —— 纯色图看不出
    宽高有没有被搞反。
    """
    w = max(1, min(int(width or 1), _MOCK_MAX_SIDE))
    h = max(1, min(int(height or 1), _MOCK_MAX_SIDE))

    row = bytearray()
    for x in range(w):
        row += bytes(((x * 255) // max(1, w - 1), 0, 128))

    raw = bytearray()
    for y in range(h):
        # 绿通道整行同值,用 C 层的切片赋值改,别再套一层像素循环
        row[1::3] = bytes([(y * 255) // max(1, h - 1)]) * w
        raw += b"\x00" + row

    return (
        b"\x89PNG\r\n\x1a\n"
        + _png_chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
        + _png_chunk(b"IDAT", zlib.compress(bytes(raw), 6))
        + _png_chunk(b"IEND", b"")
    )


def ensure_storage(settings: Settings) -> None:
    settings.data_dir.mkdir(parents=True, exist_ok=True)
    settings.images_dir.mkdir(parents=True, exist_ok=True)


def image_path(settings: Settings, image_id: str) -> Path:
    return settings.images_dir / f"{image_id}.png"


def save_image(settings: Settings, image_id: str, payload: bytes) -> Path:
    ensure_storage(settings)
    path = image_path(settings, image_id)
    path.write_bytes(payload)
    return path


def write_mock_image(
    settings: Settings, image_id: str, *, width: int = 1, height: int = 1
) -> Path:
    return save_image(settings, image_id, mock_png(width, height))
