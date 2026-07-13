"""Export a deterministic OpenAPI document for the canonical sidecar v1 API."""

from __future__ import annotations

import argparse
import json
import sys
from collections.abc import Iterator, Mapping, Sequence
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from sidecar.config import Settings  # noqa: E402
from sidecar.server import create_app  # noqa: E402

JsonObject = dict[str, Any]
_COMPONENT_REF_PREFIX = "#/components/"
_HTTP_METHODS = {"delete", "get", "head", "options", "patch", "post", "put", "trace"}
_PAIR_EXCHANGE = ("/api/v1/auth/pair/exchange", "post")


def _settings(data_dir: Path) -> Settings:
    """Create an explicit, side-effect-contained app configuration for schema export."""

    return Settings(
        host="127.0.0.1",
        port=0,
        data_dir=data_dir,
        nai_token="",
        nai_base_url="https://image.novelai.net",
        llm_base_url="",
        llm_api_key="",
        llm_model="",
        mock_generation=True,
        instance_id="openapi-contract",
        unsafe_dev_no_auth=True,
    )


def _walk(value: Any) -> Iterator[Any]:
    yield value
    if isinstance(value, Mapping):
        for item in value.values():
            yield from _walk(item)
    elif isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        for item in value:
            yield from _walk(item)


def _component_references(value: Any) -> set[tuple[str, str]]:
    references: set[tuple[str, str]] = set()
    for item in _walk(value):
        if not isinstance(item, Mapping):
            continue
        reference = item.get("$ref")
        if not isinstance(reference, str) or not reference.startswith(_COMPONENT_REF_PREFIX):
            continue
        parts = reference[len(_COMPONENT_REF_PREFIX) :].split("/", 1)
        if len(parts) == 2:
            references.add((parts[0], parts[1]))
    return references


def _security_scheme_names(value: Any) -> set[str]:
    names: set[str] = set()
    for item in _walk(value):
        if not isinstance(item, Mapping):
            continue
        security = item.get("security")
        if not isinstance(security, list):
            continue
        for requirement in security:
            if isinstance(requirement, Mapping):
                names.update(str(name) for name in requirement)
    return names


def _prune_components(schema: JsonObject, contract: JsonObject) -> None:
    source = schema.get("components")
    if not isinstance(source, Mapping):
        return

    pending = _component_references(contract)
    pending.update(("securitySchemes", name) for name in _security_scheme_names(contract))
    selected: set[tuple[str, str]] = set()
    while pending:
        component = pending.pop()
        if component in selected:
            continue
        category, name = component
        category_values = source.get(category)
        if not isinstance(category_values, Mapping) or name not in category_values:
            raise RuntimeError(f"OpenAPI component reference does not exist: {category}/{name}")
        selected.add(component)
        pending.update(_component_references(category_values[name]) - selected)

    components: JsonObject = {}
    for category, name in sorted(selected):
        category_values = source[category]
        components.setdefault(category, {})[name] = category_values[name]
    if components:
        contract["components"] = components


def _validate_authentication_contract(contract: JsonObject) -> None:
    components = contract.get("components", {})
    schemes = components.get("securitySchemes", {}) if isinstance(components, Mapping) else {}
    bearer = schemes.get("BearerAuth") if isinstance(schemes, Mapping) else None
    if (
        not isinstance(bearer, Mapping)
        or bearer.get("type") != "http"
        or bearer.get("scheme") != "bearer"
    ):
        raise RuntimeError("v1 OpenAPI must define the BearerAuth HTTP bearer scheme")

    paths = contract["paths"]
    pair_exchange_found = False
    for path, path_item in paths.items():
        if not isinstance(path_item, Mapping):
            continue
        for method, operation in path_item.items():
            if method not in _HTTP_METHODS or not isinstance(operation, Mapping):
                continue
            security = operation.get("security", contract.get("security"))
            if (path, method) == _PAIR_EXCHANGE:
                pair_exchange_found = True
                if security != []:
                    raise RuntimeError(
                        "the pairing exchange must be explicitly anonymous in OpenAPI"
                    )
                continue
            if not isinstance(security, list) or not any(
                isinstance(requirement, Mapping) and "BearerAuth" in requirement
                for requirement in security
            ):
                raise RuntimeError(f"v1 operation is missing BearerAuth: {method.upper()} {path}")
    if not pair_exchange_found:
        raise RuntimeError("v1 OpenAPI is missing POST /api/v1/auth/pair/exchange")


def build_contract() -> JsonObject:
    """Return the mounted application's v1-only OpenAPI contract."""

    with TemporaryDirectory(prefix="ultimate-novelai-openapi-") as temporary:
        schema = create_app(_settings(Path(temporary))).openapi()

    source_paths = schema.get("paths")
    if not isinstance(source_paths, Mapping):
        raise RuntimeError("FastAPI produced an OpenAPI document without paths")
    paths = {
        path: source_paths[path]
        for path in sorted(source_paths)
        if path == "/api/v1" or path.startswith("/api/v1/")
    }
    if not paths:
        raise RuntimeError("FastAPI produced no /api/v1 paths")

    contract: JsonObject = {
        key: schema[key]
        for key in (
            "openapi",
            "info",
            "jsonSchemaDialect",
            "servers",
            "security",
            "tags",
            "externalDocs",
        )
        if key in schema
    }
    contract["paths"] = paths
    _prune_components(schema, contract)
    _validate_authentication_contract(contract)
    return contract


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--output",
        type=Path,
        help="Write JSON to this path instead of stdout.",
    )
    arguments = parser.parse_args()
    rendered = json.dumps(
        build_contract(),
        ensure_ascii=False,
        indent=2,
        sort_keys=True,
    ) + "\n"
    if arguments.output is None:
        sys.stdout.write(rendered)
        return
    arguments.output.parent.mkdir(parents=True, exist_ok=True)
    with arguments.output.open("w", encoding="utf-8", newline="\n") as output:
        output.write(rendered)


if __name__ == "__main__":
    main()
