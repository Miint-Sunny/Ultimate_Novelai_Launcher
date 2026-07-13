"""Unified principals and owner/tenant authorization rules."""

from __future__ import annotations

import unicodedata
from dataclasses import dataclass
from enum import Enum
from typing import Protocol, runtime_checkable

from .errors import InvalidRequestError, ResourceNotFoundError

MAX_IDENTIFIER_LENGTH = 160


class PrincipalKind(str, Enum):
    USER = "user"
    BOT = "bot"
    ADMIN = "admin"
    TENANT = "tenant"


def _identifier(value: str, field_name: str) -> str:
    if not isinstance(value, str):
        raise InvalidRequestError(f"{field_name} must be a string")
    if not value or value != value.strip():
        raise InvalidRequestError(f"{field_name} is invalid")
    if len(value) > MAX_IDENTIFIER_LENGTH:
        raise InvalidRequestError(f"{field_name} is invalid")
    if any(unicodedata.category(char).startswith("C") for char in value):
        raise InvalidRequestError(f"{field_name} is invalid")
    return value


@dataclass(frozen=True)
class Principal:
    """An authenticated actor, independent of cookies, headers, or Bot sessions.

    ``delegated_owner_id`` is only legal for a Bot principal.  The authenticator
    constructing such a principal is responsible for proving the delegation; code
    below this boundary can then use one effective-owner rule consistently.

    An admin with no ``tenant_id`` is a platform admin.  This is intentionally a
    distinct, explicit state instead of treating a missing tenant as a wildcard for
    every principal kind.
    """

    kind: PrincipalKind
    subject_id: str
    tenant_id: str | None
    delegated_owner_id: str | None = None

    def __post_init__(self) -> None:
        if not isinstance(self.kind, PrincipalKind):
            raise InvalidRequestError("principal kind is invalid")
        object.__setattr__(self, "subject_id", _identifier(self.subject_id, "subject_id"))
        if self.tenant_id is not None:
            object.__setattr__(self, "tenant_id", _identifier(self.tenant_id, "tenant_id"))
        if self.kind is not PrincipalKind.ADMIN and self.tenant_id is None:
            raise InvalidRequestError("tenant_id is required for this principal")
        if self.delegated_owner_id is not None:
            if self.kind is not PrincipalKind.BOT:
                raise InvalidRequestError("only a bot principal may have a delegated owner")
            object.__setattr__(
                self,
                "delegated_owner_id",
                _identifier(self.delegated_owner_id, "delegated_owner_id"),
            )

    @classmethod
    def user(cls, subject_id: str, tenant_id: str) -> Principal:
        return cls(PrincipalKind.USER, subject_id, tenant_id)

    @classmethod
    def bot(
        cls,
        subject_id: str,
        tenant_id: str,
        *,
        delegated_owner_id: str | None = None,
    ) -> Principal:
        return cls(PrincipalKind.BOT, subject_id, tenant_id, delegated_owner_id)

    @classmethod
    def admin(cls, subject_id: str, tenant_id: str | None = None) -> Principal:
        return cls(PrincipalKind.ADMIN, subject_id, tenant_id)

    @classmethod
    def tenant(cls, subject_id: str, tenant_id: str) -> Principal:
        return cls(PrincipalKind.TENANT, subject_id, tenant_id)

    @property
    def effective_owner_id(self) -> str | None:
        if self.kind is PrincipalKind.USER:
            return self.subject_id
        if self.kind is PrincipalKind.BOT:
            return self.delegated_owner_id or self.subject_id
        return None

    @property
    def is_platform_admin(self) -> bool:
        return self.kind is PrincipalKind.ADMIN and self.tenant_id is None


@dataclass(frozen=True)
class ResourceOwner:
    """The complete security boundary for an owned or tenant-owned resource."""

    tenant_id: str
    owner_id: str | None

    def __post_init__(self) -> None:
        object.__setattr__(self, "tenant_id", _identifier(self.tenant_id, "tenant_id"))
        if self.owner_id is not None:
            object.__setattr__(self, "owner_id", _identifier(self.owner_id, "owner_id"))


class ResourceAccessPolicy:
    """Fail-closed access policy that obscures unauthorized resource existence."""

    def require_access(self, principal: Principal, resource: ResourceOwner) -> ResourceOwner:
        if principal.is_platform_admin:
            return resource
        if principal.tenant_id != resource.tenant_id:
            raise ResourceNotFoundError()
        if principal.kind in {PrincipalKind.ADMIN, PrincipalKind.TENANT}:
            return resource
        if resource.owner_id is not None and principal.effective_owner_id == resource.owner_id:
            return resource
        raise ResourceNotFoundError()


@runtime_checkable
class OwnerBoundRequest(Protocol):
    """Structural shape expected from transport request DTOs with owner claims."""

    @property
    def tenant_id(self) -> str | None: ...

    @property
    def owner_id(self) -> str | None: ...


@dataclass(frozen=True)
class OwnerClaim:
    """Small transport-neutral implementation useful for request composition."""

    tenant_id: str | None = None
    owner_id: str | None = None


@runtime_checkable
class RequestOwnerChecker(Protocol):
    def resolve(self, principal: Principal, request: OwnerBoundRequest) -> ResourceOwner: ...


class StrictRequestOwnerChecker:
    """Derive omitted user/Bot ownership and validate every explicit claim.

    Tenant principals and admins must name an owner by default, preventing an
    omitted field from silently selecting a broad tenant-owned account.  A caller
    that intentionally manages tenant-owned resources may opt in at construction.
    """

    def __init__(
        self,
        policy: ResourceAccessPolicy | None = None,
        *,
        allow_tenant_owned: bool = False,
    ) -> None:
        self._policy = policy or ResourceAccessPolicy()
        self._allow_tenant_owned = allow_tenant_owned

    def resolve(self, principal: Principal, request: OwnerBoundRequest) -> ResourceOwner:
        tenant_id = request.tenant_id if request.tenant_id is not None else principal.tenant_id
        if tenant_id is None:
            raise InvalidRequestError("tenant_id is required")

        owner_id = request.owner_id
        if owner_id is None:
            owner_id = principal.effective_owner_id
        if owner_id is None and not self._allow_tenant_owned:
            raise InvalidRequestError("owner_id is required")

        resource = ResourceOwner(tenant_id=tenant_id, owner_id=owner_id)
        return self._policy.require_access(principal, resource)
