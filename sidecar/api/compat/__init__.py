"""One-release compatibility transport for the historical desktop API."""

from .router import create_compat_router, register_compat_routes

__all__ = ["create_compat_router", "register_compat_routes"]
