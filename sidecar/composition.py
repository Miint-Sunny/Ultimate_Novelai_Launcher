from __future__ import annotations

from dataclasses import dataclass

from sidecar import APP_VERSION
from sidecar.agent_runtime import DesktopAgentAdapter
from sidecar.application import MutationGate, SettingsStore, TaskSupervisor
from sidecar.config import Settings, load_settings
from sidecar.infrastructure import HttpClientPool
from sidecar.persistence import Database
from sidecar.process_control import process_control
from sidecar.runtime import AppRuntime
from sidecar.security import AuthManager, PairingManager
from sidecar.services.assets import AssetService
from sidecar.services.backup import BackupService
from sidecar.services.generation import GenerationJobCoordinator, NovelAIGenerationExecutor
from sidecar.services.jobs import JobService
from sidecar.services.library import LibraryService
from sidecar.tags import close_tag_clients


@dataclass(frozen=True)
class RuntimeComponents:
    runtime: AppRuntime
    settings: SettingsStore
    database: Database
    assets: AssetService
    library: LibraryService
    jobs: GenerationJobCoordinator
    backups: BackupService
    security: AuthManager
    pairing: PairingManager
    tasks: TaskSupervisor
    mutations: MutationGate
    http: HttpClientPool
    agent: DesktopAgentAdapter


def build_runtime(
    settings: Settings,
    *,
    reload_from_environment: bool = True,
) -> RuntimeComponents:
    settings_store = SettingsStore(
        settings,
        loader=load_settings if reload_from_environment else None,
    )
    database = Database(
        settings.db_path,
        migration_backup_dir=settings.data_dir / "migration-backups",
        migration_backup_keep=3,
    )
    assets = AssetService(
        database,
        settings.data_dir / "assets",
        managed_root=settings.data_dir,
        quota_bytes=settings.storage_quota_bytes,
        reserve_bytes=settings.storage_reserve_bytes,
    )
    library = LibraryService(database, assets)
    clients = HttpClientPool()
    agent = DesktopAgentAdapter(settings_store, clients, library)
    persistent_jobs = JobService(
        database,
        capacity=settings.generation_queue_capacity,
    )
    executor = NovelAIGenerationExecutor(settings_store, assets, clients, jobs=persistent_jobs)
    jobs = GenerationJobCoordinator(
        persistent_jobs,
        executor,
        workers=settings.generation_workers,
    )
    security = AuthManager(
        settings.sidecar_auth_token,
        allow_legacy_header=True,
        required=not settings.unsafe_dev_no_auth,
    )
    if not security.enabled and not settings.unsafe_dev_no_auth:
        raise RuntimeError("sidecar authentication token is required")
    pairing = PairingManager(session_token=settings.sidecar_auth_token or "unsafe-dev-no-auth")
    tasks = TaskSupervisor()
    mutations = MutationGate()
    backups = BackupService(
        database,
        assets.root,
        asset_service=assets,
        managed_root=settings.data_dir,
        quota_bytes=settings.storage_quota_bytes,
        max_uncompressed_bytes=settings.storage_quota_bytes,
        disk_reserve_bytes=settings.storage_reserve_bytes,
    )

    # Assign public protocols after registering infrastructure in dependency order.
    runtime = AppRuntime(settings=settings_store, mutations=mutations, version=APP_VERSION)
    runtime.jobs = jobs
    runtime.security = security
    runtime.database = database
    runtime.assets = assets
    runtime.library = library
    runtime.backups = backups
    runtime.pairing = pairing
    runtime.tasks = tasks
    runtime.agent = agent
    runtime.http = clients
    runtime.process_control = process_control
    runtime.capability_provider = lambda: {
        "generation_model_configured": settings_store.current.nai_configured,
        "llm_model_configured": settings_store.current.llm_configured,
        "comfyui_configured": settings_store.current.comfy_configured,
        **agent.capabilities(),
    }
    # A prepared restore may have moved the canonical database aside. Recover it
    # before Database.initialize() gets any chance to create a fresh empty file.
    runtime.register_hooks(
        "restore_recovery",
        startup=backups.recover_interrupted_restore,
    )
    runtime.register("database", database)
    runtime.register("assets", assets)
    runtime.register("library", library)
    runtime.register_hooks("asset_reconciliation", startup=assets.reconcile_orphans)
    runtime.register("backups", backups)
    runtime.register_hooks("tag_clients", shutdown=close_tag_clients, required=False)
    runtime.register("http_clients", clients)
    # Missing formal prompts disable only the Agent capability; they do not make
    # storage, settings, or generation unavailable.
    runtime.register("desktop_agent", agent, required=False)
    runtime.register("security", security)
    runtime.register("pairing", pairing)
    runtime.register("generation_jobs", jobs)
    runtime.register("task_supervisor", tasks)
    return RuntimeComponents(
        runtime=runtime,
        settings=settings_store,
        database=database,
        assets=assets,
        library=library,
        jobs=jobs,
        backups=backups,
        security=security,
        pairing=pairing,
        tasks=tasks,
        mutations=mutations,
        http=clients,
        agent=agent,
    )


__all__ = ["RuntimeComponents", "build_runtime"]
