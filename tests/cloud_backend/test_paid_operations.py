from __future__ import annotations

import asyncio
import base64

import pytest

from cloud_backend.errors import AuthenticationError, InvalidRequestError, UsageRecordingError
from cloud_backend.identity import Principal
from cloud_backend.paid_operations import (
    PaidOperationService,
    UsageCharge,
    normalize_image_base64,
    validate_translate_context,
)

PNG = b"\x89PNG\r\n\x1a\npaid-operation-test"


def test_image_validation_enforces_format_mime_base64_and_decoded_budget() -> None:
    encoded = base64.b64encode(PNG).decode("ascii")
    assert normalize_image_base64(encoded) == encoded
    assert normalize_image_base64(f"data:image/png;base64,{encoded}") == encoded

    with pytest.raises(InvalidRequestError, match="does not match"):
        normalize_image_base64(f"data:image/jpeg;base64,{encoded}")
    with pytest.raises(InvalidRequestError, match="base64"):
        normalize_image_base64("not-base64!")
    with pytest.raises(InvalidRequestError, match="format"):
        normalize_image_base64(base64.b64encode(b"not-an-image").decode("ascii"))
    with pytest.raises(InvalidRequestError, match="size limit"):
        normalize_image_base64(encoded, max_decoded_bytes=8)
    with pytest.raises(InvalidRequestError, match="required"):
        normalize_image_base64("")
    with pytest.raises(ValueError, match="positive"):
        normalize_image_base64(encoded, max_decoded_bytes=0)
    with pytest.raises(InvalidRequestError, match="data URL"):
        normalize_image_base64("data:image/png;base64")
    with pytest.raises(InvalidRequestError, match="unsupported"):
        normalize_image_base64(f"data:image/avif;base64,{encoded}")
    nine_bytes = base64.b64encode(b"\x89PNG\r\n\x1a\nx").decode("ascii")
    with pytest.raises(InvalidRequestError, match="size limit"):
        normalize_image_base64(nine_bytes, max_decoded_bytes=8)


@pytest.mark.parametrize(
    ("payload", "mime"),
    [
        (b"\xff\xd8\xffjpeg", "image/jpeg"),
        (b"GIF89a-gif", "image/gif"),
        (b"RIFF\x04\x00\x00\x00WEBPdata", "image/webp"),
    ],
)
def test_supported_image_signatures(payload: bytes, mime: str) -> None:
    encoded = base64.b64encode(payload).decode("ascii")
    assert normalize_image_base64(f"data:{mime};base64,{encoded}") == encoded


def test_translate_context_uses_encoded_byte_budget() -> None:
    validate_translate_context([{"role": "user", "content": "你好"}], max_bytes=10)
    with pytest.raises(InvalidRequestError, match="text budget"):
        validate_translate_context([{"role": "user", "content": "你好"}], max_bytes=9)
    with pytest.raises(ValueError, match="positive"):
        validate_translate_context([], max_bytes=0)


@pytest.mark.parametrize(
    "charge",
    [
        lambda: UsageCharge(0, "reason"),
        lambda: UsageCharge(1, ""),
        lambda: UsageCharge(1, " padded "),
        lambda: UsageCharge(1, "x" * 201),
    ],
)
def test_usage_charge_validation(charge) -> None:
    with pytest.raises(InvalidRequestError):
        charge()


@pytest.mark.asyncio
async def test_paid_operation_accounts_only_success_and_requires_owner() -> None:
    recorded: list[tuple[str, int, str]] = []

    async def recorder(owner_id: str, points: int, reason: str) -> None:
        recorded.append((owner_id, points, reason))

    service = PaidOperationService(recorder)
    principal = Principal.user("owner", "tenant")

    async def succeed() -> str:
        return "ok"

    assert (
        await service.execute(
            principal,
            succeed,
            charge=UsageCharge(2, "vibe"),
        )
        == "ok"
    )
    assert recorded == [("owner", 2, "vibe")]

    await service.execute(
        principal,
        succeed,
        charge=UsageCharge(4, "upscale"),
        account_when=lambda result: result == "chargeable",
    )
    assert recorded == [("owner", 2, "vibe")]

    with pytest.raises(AuthenticationError):
        await service.execute(Principal.admin("admin", "tenant"), succeed)


@pytest.mark.asyncio
async def test_paid_operation_error_and_cancellation_never_account() -> None:
    recorded: list[tuple[str, int, str]] = []

    async def recorder(owner_id: str, points: int, reason: str) -> None:
        recorded.append((owner_id, points, reason))

    service = PaidOperationService(recorder)
    principal = Principal.user("owner", "tenant")

    async def fail() -> str:
        raise RuntimeError("provider failed")

    async def cancel() -> str:
        raise asyncio.CancelledError

    with pytest.raises(RuntimeError, match="provider failed"):
        await service.execute(principal, fail, charge=UsageCharge(2, "vibe"))
    with pytest.raises(asyncio.CancelledError):
        await service.execute(principal, cancel, charge=UsageCharge(2, "vibe"))
    assert recorded == []


@pytest.mark.asyncio
async def test_paid_operation_exposes_recording_failure_without_repeating_provider() -> None:
    provider_calls = 0
    recorder_calls = 0

    async def provider() -> str:
        nonlocal provider_calls
        provider_calls += 1
        return "already-produced"

    async def recorder(owner_id: str, points: int, reason: str) -> None:
        nonlocal recorder_calls
        recorder_calls += 1
        raise OSError("stats disk unavailable")

    service = PaidOperationService(recorder)
    with pytest.raises(UsageRecordingError, match="usage recording"):
        await service.execute(
            Principal.user("owner", "tenant"),
            provider,
            charge=UsageCharge(2, "vibe"),
        )

    assert provider_calls == 1
    assert recorder_calls == 1
