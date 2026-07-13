"""Process-local browser pairing routes."""

from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, Request

from backend_core.errors import DependencyUnavailableError
from sidecar.runtime import AppRuntime

from ..dependencies import authorize_request, map_security_error, resolve_runtime
from ..problems import ProblemDetailsRoute
from .models import (
    PairingChallengeResponse,
    PairingExchangeRequest,
    PairingExchangeResponse,
)


def create_auth_router(runtime: AppRuntime | None = None) -> APIRouter:
    router = APIRouter(prefix="/auth", tags=["v1-auth"], route_class=ProblemDetailsRoute)

    @router.post("/pair", response_model=PairingChallengeResponse)
    async def issue_pairing_code(request: Request) -> PairingChallengeResponse:
        current = resolve_runtime(request, runtime)
        await authorize_request(current, request)
        pairing = current.pairing
        if pairing is None:
            raise DependencyUnavailableError(
                "browser pairing is not configured",
                code="pairing_unavailable",
            )
        challenge = pairing.issue()
        return PairingChallengeResponse(
            code=challenge.code,
            expires_at=datetime.fromtimestamp(challenge.expires_at, tz=timezone.utc),
            expires_in=challenge.expires_in,
            max_attempts=challenge.max_attempts,
        )

    @router.post("/pair/exchange", response_model=PairingExchangeResponse)
    async def exchange_pairing_code(
        body: PairingExchangeRequest,
        request: Request,
    ) -> PairingExchangeResponse:
        current = resolve_runtime(request, runtime)
        pairing = current.pairing
        if pairing is None:
            raise DependencyUnavailableError(
                "browser pairing is not configured",
                code="pairing_unavailable",
            )
        try:
            token = pairing.exchange(body.code)
        except Exception as exc:
            mapped = map_security_error(exc)
            if mapped is None:
                raise
            raise mapped from exc
        configured = getattr(current.settings, "current", current.settings)
        return PairingExchangeResponse(
            access_token=token,
            instance_id=str(getattr(configured, "instance_id", "")),
            protocol=int(getattr(configured, "protocol_version", 1)),
        )

    return router


router = create_auth_router()
