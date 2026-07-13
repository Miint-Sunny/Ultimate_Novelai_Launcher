"""Fail-closed identity boundary for the legacy Agent HTTP adapter.

The Agent implementation is shared by Bot and Web callers, but it must not know
how a FastAPI deployment authenticates either one.  The outer application installs
an authenticator and a paid-capability checker on ``app.state``.  This module turns
those adapters into one small, typed dependency used by every Agent route.
"""

from __future__ import annotations

import inspect
import re
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Annotated, Any, Protocol, cast

from fastapi import Depends, HTTPException, Request

from cloud_backend.errors import InvalidRequestError, ResourceNotFoundError
from cloud_backend.identity import Principal, ResourceAccessPolicy, ResourceOwner

_PLATFORM = re.compile(r"^[A-Za-z0-9.-]{1,32}$")
_GROUP = re.compile(r"^[^\x00-\x1f\x7f]{1,160}$")
_MAX_HISTORY_KEY_LENGTH = 512


class AgentAuthenticator(Protocol):
    def __call__(self, request: Request) -> AgentAccess | Awaitable[AgentAccess]: ...


class AgentPaidAuthorizer(Protocol):
    def __call__(self, access: AgentAccess) -> bool | Awaitable[bool]: ...


@dataclass(frozen=True)
class AgentAccess:
    """Authenticated actor and the narrow delegation granted by its transport.

    Normal users are confined to ``Principal.effective_owner_id``.  A verified Bot
    service may name the user on whose behalf it is handling a Bot event.  Admins
    may inspect or repair another user's Agent state.  Merely constructing a Bot
    principal is not enough to delegate: the outer authenticator must explicitly
    set ``trusted_service`` after validating the deployment's Bot credential.
    """

    principal: Principal
    administrator: bool = False
    trusted_service: bool = False

    @property
    def owner_id(self) -> str | None:
        return self.principal.effective_owner_id

    def require_owner(self, requested_owner: str) -> str:
        try:
            resource = ResourceOwner(_tenant_for(self.principal), requested_owner)
        except (InvalidRequestError, TypeError) as exc:
            raise _not_found_error() from exc
        if self.administrator or self.trusted_service:
            if resource.owner_id is None:  # pragma: no cover - Agent state is user-owned
                raise _not_found_error()
            return resource.owner_id
        try:
            ResourceAccessPolicy().require_access(self.principal, resource)
        except ResourceNotFoundError as exc:
            raise _not_found_error() from exc
        if resource.owner_id is None:  # pragma: no cover - Agent state is user-owned
            raise _not_found_error()
        return resource.owner_id


async def require_agent_access(request: Request) -> AgentAccess:
    """Resolve one verified principal or fail closed when wiring is absent."""

    authenticator = getattr(request.app.state, "agent_authenticator", None)
    if not callable(authenticator):
        raise HTTPException(status_code=503, detail="Agent authentication is unavailable")
    result = cast(Callable[[Request], Any], authenticator)(request)
    if inspect.isawaitable(result):
        result = await result
    if not isinstance(result, AgentAccess):
        raise HTTPException(status_code=503, detail="Agent authentication is unavailable")
    return result


async def require_paid_agent_access(
    request: Request,
    access: Annotated[AgentAccess, Depends(require_agent_access)],
) -> AgentAccess:
    """Require the deployment's explicit paid-capability/entitlement check."""

    return await authorize_paid_agent_access(request, access)


async def authorize_paid_agent_access(request: Request, access: AgentAccess) -> AgentAccess:
    """Apply the paid-capability check after any route-specific owner checks."""

    authorizer = getattr(request.app.state, "agent_paid_authorizer", None)
    if not callable(authorizer):
        raise HTTPException(status_code=503, detail="Agent quota validation is unavailable")
    allowed = cast(Callable[[AgentAccess], Any], authorizer)(access)
    if inspect.isawaitable(allowed):
        allowed = await allowed
    if allowed is not True:
        raise HTTPException(status_code=402, detail="Agent quota is unavailable")
    return access


async def require_agent_admin(
    access: Annotated[AgentAccess, Depends(require_agent_access)],
) -> AgentAccess:
    if not access.administrator:
        raise _not_found_error()
    return access


def bind_chat_identity(request: Any, access: AgentAccess) -> Any:
    """Return a ChatRequest whose owner and history key are authenticated.

    ``Any`` keeps this module independent from the Agent's Pydantic request model;
    callers supply a model supporting ``model_copy`` and the documented fields.
    """

    owner_id = access.require_owner(request.user_id)
    group_id = request.group_id if request.scene == "group" else None
    if request.scene == "group" and group_id is None:
        raise HTTPException(status_code=400, detail="group_id is required for group Agent chat")
    user_key = canonical_user_key(
        platform=request.platform,
        owner_id=owner_id,
        group_id=group_id,
    )
    supplied_key = (request.user_key or "").strip()
    if supplied_key and supplied_key != user_key:
        raise _not_found_error()
    return request.model_copy(update={"user_id": owner_id, "user_key": user_key})


def authorize_history_key(user_key: str, access: AgentAccess) -> str:
    """Authorize one legacy JSON history key without trusting a claimed owner.

    Legacy keys are opaque storage keys, and owner identifiers may themselves
    contain the historical ``_u_``/``_p_`` delimiters.  For a normal principal,
    compare the complete authenticated-owner suffix instead of reparsing it.
    Verified service/admin callers may address another owner, but still have to
    pass the structural key validation below.
    """

    _validate_history_key(user_key)
    if access.administrator or access.trusted_service:
        history_owner(user_key)
        return user_key
    owner_id = access.owner_id
    if owner_id is None or not user_key.endswith((f"_p_{owner_id}", f"_u_{owner_id}")):
        raise _not_found_error()
    return user_key


def canonical_user_key(*, platform: str, owner_id: str, group_id: str | None) -> str:
    if not isinstance(platform, str) or _PLATFORM.fullmatch(platform) is None:
        raise HTTPException(status_code=400, detail="invalid Agent platform")
    # ResourceOwner applies the shared identifier validation to the owner.
    owner = ResourceOwner("agent", owner_id).owner_id
    if owner is None:  # pragma: no cover - Agent histories are always user-owned
        raise _not_found_error()
    if group_id is None:
        return f"{platform}_p_{owner}"
    if not isinstance(group_id, str) or _GROUP.fullmatch(group_id) is None:
        raise HTTPException(status_code=400, detail="invalid Agent group")
    return f"{platform}_g_{group_id}_u_{owner}"


def history_owner(user_key: str) -> str:
    _validate_history_key(user_key)
    for marker in ("_u_", "_p_"):
        prefix, separator, owner = user_key.rpartition(marker)
        if separator and prefix and owner:
            # Validate the parsed owner through the shared domain type.
            try:
                validated = ResourceOwner("agent", owner).owner_id
            except Exception as exc:
                raise _not_found_error() from exc
            if validated is not None:
                return validated
    raise _not_found_error()


def _validate_history_key(user_key: str) -> None:
    if (
        not isinstance(user_key, str)
        or not user_key
        or len(user_key) > _MAX_HISTORY_KEY_LENGTH
        or any(ord(character) < 0x20 or ord(character) == 0x7F for character in user_key)
    ):
        raise _not_found_error()


def _tenant_for(principal: Principal) -> str:
    # App wiring gives every Agent principal an explicit tenant.  Keep this helper
    # fail-closed for a platform-admin principal constructed by another adapter.
    if principal.tenant_id is None:
        raise _not_found_error()
    return principal.tenant_id


def _not_found_error() -> HTTPException:
    return HTTPException(status_code=404, detail="resource was not found")


__all__ = [
    "AgentAccess",
    "authorize_paid_agent_access",
    "authorize_history_key",
    "bind_chat_identity",
    "canonical_user_key",
    "history_owner",
    "require_agent_access",
    "require_agent_admin",
    "require_paid_agent_access",
]
