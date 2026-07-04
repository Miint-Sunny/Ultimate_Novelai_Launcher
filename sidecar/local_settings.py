from __future__ import annotations

import ipaddress
import json
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

EDITABLE_KEYS = {
    "nai_base_url",
    "llm_base_url",
    "llm_model",
}

_URL_KEYS = ("nai_base_url", "llm_base_url")

# The stored NovelAI token is only ever legitimately sent to NovelAI, so the
# UI-writable base URL is pinned to NovelAI hosts. This stops a hostile (or merely
# CSRF-style) write to POST /settings from repointing the outbound base URL at an
# attacker and having the sidecar attach the Authorization: Bearer <token> header to
# it (SSRF -> credential exfiltration). Power users who genuinely need a different
# NovelAI endpoint can still set the NAI_API_BASE_URL env var, which takes precedence
# over this stored value in config.load_settings().
_NAI_ALLOWED_HOSTS = ("novelai.net",)


def _host_matches(host: str, allowed: tuple[str, ...]) -> bool:
    host = host.lower()
    return any(host == suffix or host.endswith("." + suffix) for suffix in allowed)


def _is_blocked_ip_host(host: str) -> bool:
    """Whether host is (or encodes) a link-local / cloud-metadata address.

    Handles bracketed IPv6, IPv4-mapped IPv6 (``::ffff:169.254.169.254``), and the
    integer / hex IPv4 encodings that OS resolvers still route to ``169.254.169.254``.
    Hostnames (which cannot be resolved here) are treated as not-blocked, since the
    LLM base URL is allowed to point at an arbitrary host by design.
    """
    candidate = host[1:-1] if host.startswith("[") and host.endswith("]") else host
    ip: ipaddress._BaseAddress | None = None
    try:
        ip = ipaddress.ip_address(candidate)
    except ValueError:
        try:
            if candidate.lower().startswith("0x"):
                ip = ipaddress.ip_address(int(candidate, 16) & 0xFFFFFFFF)
            elif candidate.isdigit():
                ip = ipaddress.ip_address(int(candidate) & 0xFFFFFFFF)
        except (ValueError, OverflowError):
            ip = None
    if ip is None:
        return False
    if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped is not None:
        ip = ip.ipv4_mapped
    return ip.is_link_local


def _is_safe_base_url(key: str, value: str) -> bool:
    """Whether a base-URL settings value is safe to persist and use for outbound calls.

    Rejects non-HTTP(S) schemes and the link-local / cloud-metadata range for every
    outbound base URL, and additionally pins ``nai_base_url`` to HTTPS NovelAI hosts.
    """
    parsed = urlparse(value)
    if parsed.scheme not in ("http", "https"):
        return False
    host = (parsed.hostname or "").lower()
    if not host:
        return False
    if _is_blocked_ip_host(host):
        return False
    if key == "nai_base_url":
        if parsed.scheme != "https" or not _host_matches(host, _NAI_ALLOWED_HOSTS):
            return False
    return True


def _sanitize_editable(data: dict[str, Any]) -> dict[str, str]:
    """Keep only known string keys; drop any base URL that fails validation.

    An empty base URL is preserved (it means "fall back to the built-in default").
    """
    result: dict[str, str] = {}
    for key in EDITABLE_KEYS:
        value = data.get(key)
        if not isinstance(value, str):
            continue
        value = value.strip()
        if key in _URL_KEYS and value != "" and not _is_safe_base_url(key, value):
            continue
        result[key] = value
    return result


def settings_path(data_dir: Path) -> Path:
    return data_dir / "settings.json"


def read_local_settings(data_dir: Path) -> dict[str, Any]:
    path = settings_path(data_dir)
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {}
    except Exception:
        return {}
    if not isinstance(data, dict):
        return {}
    return _sanitize_editable(data)


def write_local_settings(data_dir: Path, updates: dict[str, Any]) -> dict[str, Any]:
    current = read_local_settings(data_dir)
    current.update(_sanitize_editable(updates))
    path = settings_path(data_dir)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(current, ensure_ascii=False, indent=2), encoding="utf-8")
    return current
