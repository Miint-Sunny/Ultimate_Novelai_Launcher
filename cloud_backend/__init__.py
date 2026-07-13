"""Framework-neutral foundations for the future legacy cloud adapter.

Nothing in this package registers routes or imports the legacy FastAPI app.  HTTP,
WebSocket, and Bot-specific wiring is intentionally left to outer adapters.
"""

from .capabilities import (
    HmacJobCapabilityTokens,
    JobCapability,
    JobCapabilityVerifier,
)
from .errors import (
    AuthenticationError,
    CloudBackendError,
    IdempotencyConflictError,
    InvalidCapabilityError,
    InvalidRequestError,
    QuotaExceededError,
    ReservationStateError,
    ResourceNotFoundError,
)
from .identity import (
    OwnerBoundRequest,
    OwnerClaim,
    Principal,
    PrincipalKind,
    RequestOwnerChecker,
    ResourceAccessPolicy,
    ResourceOwner,
    StrictRequestOwnerChecker,
)
from .job_events import (
    AuthenticatedJobEventWebSocket,
    JobEventRecord,
    JobEventSource,
    JobEventSubscriptionSet,
    WebSocketPort,
    WebSocketServeResult,
)
from .library_access import LibraryOwnershipService, OwnerScopedLibraryStorage
from .quota import (
    QuotaBalance,
    QuotaRepository,
    QuotaReservation,
    QuotaReservationRequest,
    QuotaService,
    QuotaSettlementRequest,
    ReservationResult,
    ReservationState,
    SettlementAction,
    SettlementResult,
)

__all__ = [
    "AuthenticationError",
    "AuthenticatedJobEventWebSocket",
    "CloudBackendError",
    "HmacJobCapabilityTokens",
    "IdempotencyConflictError",
    "InvalidCapabilityError",
    "InvalidRequestError",
    "JobCapability",
    "JobCapabilityVerifier",
    "JobEventRecord",
    "JobEventSource",
    "JobEventSubscriptionSet",
    "LibraryOwnershipService",
    "OwnerBoundRequest",
    "OwnerClaim",
    "OwnerScopedLibraryStorage",
    "Principal",
    "PrincipalKind",
    "QuotaBalance",
    "QuotaExceededError",
    "QuotaRepository",
    "QuotaReservation",
    "QuotaReservationRequest",
    "QuotaService",
    "QuotaSettlementRequest",
    "RequestOwnerChecker",
    "ReservationResult",
    "ReservationState",
    "ReservationStateError",
    "ResourceAccessPolicy",
    "ResourceNotFoundError",
    "ResourceOwner",
    "SettlementAction",
    "SettlementResult",
    "StrictRequestOwnerChecker",
    "WebSocketPort",
    "WebSocketServeResult",
]
