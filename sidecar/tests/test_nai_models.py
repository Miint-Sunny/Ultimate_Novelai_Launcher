from __future__ import annotations

import unittest

from pydantic import ValidationError

from sidecar.nai.client import build_official_payload, parse_anlas_subscription
from sidecar.nai.models import GenerationParams


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
        self.assertEqual(
            payload["parameters"]["v4_prompt"]["caption"]["base_caption"],
            "1girl, smile",
        )
        self.assertEqual(
            payload["parameters"]["v4_negative_prompt"]["caption"]["base_caption"],
            "bad anatomy",
        )

    def test_parses_subscription_anlas_balance(self) -> None:
        parsed = parse_anlas_subscription(
            {
                "tier": 3,
                "active": True,
                "trainingStepsLeft": {
                    "fixedTrainingStepsLeft": 1200,
                    "purchasedTrainingSteps": 34,
                },
            }
        )

        self.assertEqual(parsed["fixedTrainingStepsLeft"], 1200)
        self.assertEqual(parsed["purchasedTrainingSteps"], 34)
        self.assertTrue(parsed["isOpus"])

    def test_parses_missing_subscription_steps_as_zero(self) -> None:
        parsed = parse_anlas_subscription({"tier": 1, "active": True})

        self.assertEqual(parsed["fixedTrainingStepsLeft"], 0)
        self.assertEqual(parsed["purchasedTrainingSteps"], 0)
        self.assertFalse(parsed["isOpus"])


if __name__ == "__main__":
    unittest.main()
