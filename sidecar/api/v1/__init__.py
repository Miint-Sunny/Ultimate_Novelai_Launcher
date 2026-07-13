"""Public contract for API version 1."""

from ..models import ProblemDetails
from .auth import create_auth_router
from .auth import router as auth_router
from .library import create_library_router
from .library import router as library_router
from .models import (
    GenerationJobCancel,
    GenerationJobCreate,
    GenerationJobEventListResponse,
    GenerationJobEventResponse,
    GenerationJobListResponse,
    GenerationJobResponse,
    ReadyResponse,
    SettingsResponse,
    SettingsUpdateRequest,
)
from .router import create_v1_router
from .settings import create_settings_router
from .settings import router as settings_router

__all__ = [
    "GenerationJobCancel",
    "GenerationJobCreate",
    "GenerationJobEventListResponse",
    "GenerationJobEventResponse",
    "GenerationJobListResponse",
    "GenerationJobResponse",
    "ProblemDetails",
    "ReadyResponse",
    "SettingsResponse",
    "SettingsUpdateRequest",
    "auth_router",
    "create_auth_router",
    "create_library_router",
    "create_settings_router",
    "create_v1_router",
    "library_router",
    "settings_router",
]
