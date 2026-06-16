from __future__ import annotations

import unittest

try:
    from pydantic import ValidationError

    from sidecar.nai.client import build_official_payload
    from sidecar.nai.models import GenerationParams
except ModuleNotFoundError as exc:  # pragma: no cover - dependency bootstrap guard
    ValidationError = None  # type: ignore[assignment]
    _IMPORT_ERROR = exc
else:
    _IMPORT_ERROR = None


@unittest.skipIf(_IMPORT_ERROR is not None, f"missing dependency: {_IMPORT_ERROR}")
class NaiModelTests(unittest.TestCase):
    def test_rejects_invalid_size(self) -> None:
        with self.assertRaises(ValidationError):
            GenerationParams(width=833)

    def test_builds_official_payload(self) -> None:
        params = GenerationParams(seed=123)
        payload = build_official_payload("1girl, smile", "bad anatomy", params)
        self.assertEqual(payload["action"], "generate")
        self.assertEqual(payload["input"], "1girl, smile")
        self.assertEqual(payload["parameters"]["seed"], 123)
        self.assertEqual(payload["parameters"]["v4_prompt"]["caption"]["base_caption"], "1girl, smile")
        self.assertEqual(payload["parameters"]["v4_negative_prompt"]["caption"]["base_caption"], "bad anatomy")


if __name__ == "__main__":
    unittest.main()

