"""Opt-in adapters for the historical unversioned API."""

from .router import create_v0_compat_router

create_v0_router = create_v0_compat_router

__all__ = ["create_v0_compat_router", "create_v0_router"]
