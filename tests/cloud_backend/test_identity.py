from __future__ import annotations

import pytest

from cloud_backend.errors import InvalidRequestError, ResourceNotFoundError
from cloud_backend.identity import (
    OwnerClaim,
    Principal,
    PrincipalKind,
    ResourceAccessPolicy,
    ResourceOwner,
    StrictRequestOwnerChecker,
)


def test_user_and_delegated_bot_share_one_effective_owner_rule() -> None:
    policy = ResourceAccessPolicy()
    resource = ResourceOwner("tenant-a", "user-1")

    assert policy.require_access(Principal.user("user-1", "tenant-a"), resource) == resource
    assert (
        policy.require_access(
            Principal.bot("bot-9", "tenant-a", delegated_owner_id="user-1"),
            resource,
        )
        == resource
    )


@pytest.mark.parametrize(
    "principal",
    [
        Principal.user("user-2", "tenant-a"),
        Principal.user("user-1", "tenant-b"),
        Principal.bot("bot-9", "tenant-a"),
    ],
)
def test_owner_or_tenant_mismatch_is_always_obscured_as_not_found(
    principal: Principal,
) -> None:
    with pytest.raises(ResourceNotFoundError) as caught:
        ResourceAccessPolicy().require_access(
            principal,
            ResourceOwner("tenant-a", "user-1"),
        )

    assert caught.value.code == "not_found"
    assert caught.value.message == "resource was not found"
    assert caught.value.details == {}


def test_tenant_admin_and_platform_admin_have_explicit_scopes() -> None:
    policy = ResourceAccessPolicy()
    owned = ResourceOwner("tenant-a", "user-1")

    assert policy.require_access(Principal.admin("admin-1", "tenant-a"), owned) == owned
    assert policy.require_access(Principal.tenant("service-1", "tenant-a"), owned) == owned
    assert policy.require_access(Principal.admin("root"), owned) == owned
    with pytest.raises(ResourceNotFoundError):
        policy.require_access(Principal.admin("admin-2", "tenant-b"), owned)


def test_request_owner_checker_derives_owner_but_validates_explicit_claims() -> None:
    checker = StrictRequestOwnerChecker()
    principal = Principal.user("user-1", "tenant-a")

    assert checker.resolve(principal, OwnerClaim()) == ResourceOwner("tenant-a", "user-1")
    with pytest.raises(ResourceNotFoundError):
        checker.resolve(principal, OwnerClaim(owner_id="user-2"))
    with pytest.raises(ResourceNotFoundError):
        checker.resolve(principal, OwnerClaim(tenant_id="tenant-b", owner_id="user-1"))
    with pytest.raises(InvalidRequestError):
        checker.resolve(principal, OwnerClaim(tenant_id=""))
    with pytest.raises(InvalidRequestError):
        checker.resolve(principal, OwnerClaim(owner_id=""))


def test_privileged_request_must_name_owner_and_platform_admin_must_name_tenant() -> None:
    checker = StrictRequestOwnerChecker()

    with pytest.raises(InvalidRequestError):
        checker.resolve(Principal.admin("admin-1", "tenant-a"), OwnerClaim())
    with pytest.raises(InvalidRequestError):
        checker.resolve(Principal.admin("root"), OwnerClaim(owner_id="user-1"))


def test_only_bot_authenticator_may_construct_delegated_owner() -> None:
    with pytest.raises(InvalidRequestError):
        Principal(PrincipalKind.USER, "user-1", "tenant-a", "user-2")
