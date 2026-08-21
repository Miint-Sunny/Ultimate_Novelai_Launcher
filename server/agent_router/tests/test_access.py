from __future__ import annotations

from typing import Annotated

import httpx
import pytest
from fastapi import Depends, FastAPI, HTTPException

from agent_router.access import (
    AgentAccess,
    authorize_history_key,
    bind_chat_identity,
    canonical_user_key,
    history_owner,
    require_agent_access,
    require_agent_admin,
    require_paid_agent_access,
)
from agent_router.router import router
from agent_router.schemas import ChatRequest
from cloud_backend.identity import Principal


def _user(owner_id: str = "owner") -> AgentAccess:
    return AgentAccess(Principal.user(owner_id, "tenant"))


def _status(exc_info: pytest.ExceptionInfo[HTTPException]) -> int:
    return exc_info.value.status_code


def test_chat_identity_is_derived_from_authenticated_principal() -> None:
    request = ChatRequest(
        user_id="owner",
        user_key=None,
        platform="qq",
        scene="private",
        text="hello",
    )

    bound = bind_chat_identity(request, _user())

    assert bound.user_id == "owner"
    assert bound.user_key == "qq_p_owner"
    assert request.user_key is None


def test_private_chat_ignores_group_claim_and_group_chat_requires_group_id() -> None:
    private = bind_chat_identity(
        ChatRequest(user_id="owner", scene="private", group_id="forged-group"),
        _user(),
    )
    assert private.user_key == "qq_p_owner"

    with pytest.raises(HTTPException) as error:
        bind_chat_identity(ChatRequest(user_id="owner", scene="group"), _user())
    assert _status(error) == 400


def test_chat_identity_rejects_forged_owner_and_history_key_as_not_found() -> None:
    with pytest.raises(HTTPException) as owner_error:
        bind_chat_identity(ChatRequest(user_id="other"), _user())
    assert _status(owner_error) == 404

    with pytest.raises(HTTPException) as key_error:
        bind_chat_identity(
            ChatRequest(user_id="owner", user_key="qq_p_other"),
            _user(),
        )
    assert _status(key_error) == 404

    with pytest.raises(HTTPException) as invalid_owner:
        bind_chat_identity(ChatRequest(user_id=""), _user())
    assert _status(invalid_owner) == 404


def test_chat_identity_validates_platform_group_and_tenant() -> None:
    with pytest.raises(HTTPException) as platform_error:
        bind_chat_identity(ChatRequest(user_id="owner", platform="qq/invalid"), _user())
    assert _status(platform_error) == 400

    with pytest.raises(HTTPException) as group_error:
        bind_chat_identity(
            ChatRequest(user_id="owner", scene="group", group_id="bad\ngroup"),
            _user(),
        )
    assert _status(group_error) == 400

    platform_admin = AgentAccess(
        Principal.admin("platform-admin"),
        administrator=True,
    )
    with pytest.raises(HTTPException) as tenant_error:
        bind_chat_identity(ChatRequest(user_id="owner"), platform_admin)
    assert _status(tenant_error) == 404


def test_verified_service_and_admin_can_delegate_but_key_is_still_canonical() -> None:
    service = AgentAccess(
        Principal.bot("bot", "tenant"),
        trusted_service=True,
    )
    admin = AgentAccess(
        Principal.admin("admin", "tenant"),
        administrator=True,
    )
    request = ChatRequest(
        user_id="target",
        platform="discord",
        scene="group",
        group_id="room-1",
    )

    assert bind_chat_identity(request, service).user_key == "discord_g_room-1_u_target"
    assert bind_chat_identity(request, admin).user_key == "discord_g_room-1_u_target"


def test_history_access_is_owner_scoped_even_with_delimiters_in_owner_id() -> None:
    access = _user("owner_u_1")

    assert authorize_history_key("qq_p_owner_u_1", access) == "qq_p_owner_u_1"
    assert authorize_history_key("qq_g_room_u_owner_u_1", access) == "qq_g_room_u_owner_u_1"
    with pytest.raises(HTTPException) as error:
        authorize_history_key("qq_p_other", access)
    assert _status(error) == 404


def test_verified_service_history_access_still_validates_opaque_key() -> None:
    service = AgentAccess(
        Principal.bot("bot", "tenant"),
        trusted_service=True,
    )

    assert authorize_history_key("qq_p_other", service) == "qq_p_other"
    assert history_owner("qq_g_room_u_other") == "other"
    assert history_owner("qq_p_other") == "other"

    for invalid in ("", "no-owner-marker", "qq_p_ owner", "qq_p_bad\nowner", "x" * 513):
        with pytest.raises(HTTPException) as error:
            authorize_history_key(invalid, service)
        assert _status(error) == 404


@pytest.mark.parametrize(
    ("platform", "group_id", "expected"),
    [
        ("qq", None, "qq_p_owner"),
        ("discord", "room", "discord_g_room_u_owner"),
    ],
)
def test_canonical_history_key(
    platform: str,
    group_id: str | None,
    expected: str,
) -> None:
    assert canonical_user_key(platform=platform, owner_id="owner", group_id=group_id) == expected


@pytest.mark.asyncio
async def test_dependencies_fail_closed_and_enforce_paid_and_admin_capabilities() -> None:
    app = FastAPI()

    @app.get("/identity")
    async def identity(
        access: Annotated[AgentAccess, Depends(require_agent_access)],
    ) -> dict[str, str | None]:
        return {"owner": access.owner_id}

    @app.get("/paid")
    async def paid(
        access: Annotated[AgentAccess, Depends(require_paid_agent_access)],
    ) -> dict[str, str | None]:
        return {"owner": access.owner_id}

    @app.get("/admin")
    async def admin(
        access: Annotated[AgentAccess, Depends(require_agent_admin)],
    ) -> dict[str, bool]:
        return {"admin": access.administrator}

    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        assert (await client.get("/identity")).status_code == 503

        app.state.agent_authenticator = lambda _request: object()
        assert (await client.get("/identity")).status_code == 503

        async def authenticate(_request) -> AgentAccess:
            return _user()

        app.state.agent_authenticator = authenticate
        assert (await client.get("/identity")).json() == {"owner": "owner"}
        assert (await client.get("/paid")).status_code == 503

        async def deny_paid(_access) -> bool:
            return False

        app.state.agent_paid_authorizer = deny_paid
        assert (await client.get("/paid")).status_code == 402
        assert (await client.get("/admin")).status_code == 404

        app.state.agent_paid_authorizer = lambda _access: True
        assert (await client.get("/paid")).json() == {"owner": "owner"}

        app.state.agent_authenticator = lambda _request: AgentAccess(
            Principal.admin("admin", "tenant"),
            administrator=True,
        )
        assert (await client.get("/admin")).json() == {"admin": True}


@pytest.mark.asyncio
async def test_entire_agent_router_fails_closed_without_application_wiring() -> None:
    app = FastAPI()
    app.include_router(router)
    transport = httpx.ASGITransport(app=app)

    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.get("/api/agent/models")
        resolved = await client.post(
            "/api/agent/models/resolve",
            json={"target": "deepseek"},
        )

    assert response.status_code == 503
    assert response.json()["detail"] == "Agent authentication is unavailable"
    assert resolved.status_code == 503
    assert resolved.json()["detail"] == "Agent authentication is unavailable"
