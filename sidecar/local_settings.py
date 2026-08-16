from __future__ import annotations

import ipaddress
import json
import os
import tempfile
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from sidecar.security import OutboundPolicy, validate_trusted_network_allowlist

EDITABLE_KEYS = {
    "nai_base_url",
    "llm_provider",
    "llm_base_url",
    "llm_model",
    "llm_network_scope",
    "llm_trusted_networks",
    "llm_backup_provider",
    "llm_backup_base_url",
    "llm_backup_model",
    "llm_backup_network_scope",
    "llm_backup_trusted_networks",
    "comfy_base_url",
    "comfy_network_scope",
    "comfy_trusted_networks",
}

_URL_KEYS = ("nai_base_url", "llm_base_url", "llm_backup_base_url", "comfy_base_url")
_PROVIDER_KEYS = ("llm_provider", "llm_backup_provider")
_NETWORK_SCOPE_KEYS = ("llm_network_scope", "llm_backup_network_scope")
# ComfyUI is a local/LAN service; "public" is never a valid scope for it.
_COMFY_SCOPE_KEYS = ("comfy_network_scope",)
_TRUSTED_NETWORK_KEYS = (
    "llm_trusted_networks",
    "llm_backup_trusted_networks",
    "comfy_trusted_networks",
)
_ALLOWED_PROVIDERS = {"openai", "anthropic", "gemini"}
_ALLOWED_NETWORK_SCOPES = {"public", "loopback", "trusted-lan"}
_ALLOWED_COMFY_SCOPES = {"loopback", "trusted-lan"}

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
    if parsed.username is not None or parsed.password is not None:
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


def normalize_trusted_networks(value: Any, *, canonical: bool = False) -> list[str] | None:
    """Return a canonical trusted-LAN allowlist, or ``None`` when it is unsafe.

    ``OutboundPolicy`` is the security authority for permitted address space and
    maximum network breadth.  Keeping persistence and HTTP validation on that same
    path prevents a setting from being accepted by one adapter and rejected by the
    client that later consumes it.
    """

    if not isinstance(value, list) or len(value) > 16:
        return None
    if not all(isinstance(item, str) and 1 <= len(item) <= 64 for item in value):
        return None
    try:
        networks = (
            validate_trusted_network_allowlist(value)
            if canonical
            else OutboundPolicy("trusted-lan", trusted_networks=value).trusted_networks
        )
    except ValueError:
        return None
    return list(dict.fromkeys(str(network) for network in networks))


def _sanitize_editable(data: dict[str, Any]) -> dict[str, Any]:
    """Keep only known settings and reject unsafe endpoint/network values.

    An empty base URL is preserved (it means "fall back to the built-in default").
    """
    result: dict[str, Any] = {}
    for key in EDITABLE_KEYS:
        value = data.get(key)
        if key in _TRUSTED_NETWORK_KEYS:
            networks = normalize_trusted_networks(value)
            if networks is not None:
                result[key] = networks
            continue
        if not isinstance(value, str):
            continue
        value = value.strip()
        if key in _URL_KEYS and value != "" and not _is_safe_base_url(key, value):
            continue
        if key in _PROVIDER_KEYS and value not in _ALLOWED_PROVIDERS:
            continue
        if key in _NETWORK_SCOPE_KEYS and value not in _ALLOWED_NETWORK_SCOPES:
            continue
        if key in _COMFY_SCOPE_KEYS and value not in _ALLOWED_COMFY_SCOPES:
            continue
        result[key] = value
    return result


def normalize_editable_updates(data: dict[str, Any]) -> dict[str, Any]:
    """Validate an API settings update and return its normalized representation."""

    unknown = sorted(set(data) - EDITABLE_KEYS)
    if unknown:
        raise ValueError(f"unknown settings: {', '.join(unknown)}")
    normalized = _sanitize_editable(data)
    for key in _TRUSTED_NETWORK_KEYS:
        if key not in data:
            continue
        networks = normalize_trusted_networks(data[key], canonical=True)
        if networks is None:
            normalized.pop(key, None)
        else:
            normalized[key] = networks
    rejected = sorted(set(data) - set(normalized))
    if rejected:
        raise ValueError(f"invalid settings: {', '.join(rejected)}")
    return normalized


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
    payload = json.dumps(current, ensure_ascii=False, indent=2).encode("utf-8")
    descriptor, temporary = tempfile.mkstemp(prefix=".settings-", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        try:
            os.chmod(temporary, 0o600)
        except OSError:
            pass
        os.replace(temporary, path)
    finally:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass
    return current
