"""
Helpers for turning provider-side errors into user-facing messages.
"""

from __future__ import annotations

GOOGLE_PROHIBITED_CONTENT_MESSAGE = "请求被 Gemini/Vertex 安全系统拒绝（PROHIBITED_CONTENT）。"


def _exception_text(error: BaseException | str) -> str:
    if isinstance(error, str):
        return error

    parts: list[str] = []
    cur: BaseException | None = error
    seen: set[int] = set()
    while cur is not None and id(cur) not in seen:
        seen.add(id(cur))
        parts.append(str(cur))
        cur = cur.__cause__ or cur.__context__
    return "\n".join(parts)


def is_google_prohibited_content_error(error: BaseException | str) -> bool:
    text = _exception_text(error)
    upper = text.upper()
    return "PROHIBITED_CONTENT" in upper or (
        "PROMPTFEEDBACK" in upper and "BLOCKREASON" in upper and "PROHIBITED" in upper
    )


def humanize_provider_error(error: BaseException | str) -> str:
    if is_google_prohibited_content_error(error):
        return GOOGLE_PROHIBITED_CONTENT_MESSAGE
    return str(error)
