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

    def test_accepts_v5_models(self) -> None:
        for model in ("nai-diffusion-5-full", "nai-diffusion-5-curated"):
            with self.subTest(model=model):
                self.assertEqual(GenerationParams(model=model).model, model)

    def test_rejects_unsupported_model(self) -> None:
        with self.assertRaises(ValidationError):
            GenerationParams(model="nai-diffusion-6-full")

    def test_builds_v5_payload_envelope(self) -> None:
        params = GenerationParams(model="nai-diffusion-5-full", seed=7)
        parameters = build_official_payload("1girl", "bad anatomy", params)["parameters"]

        self.assertEqual(parameters["params_version"], 4)
        # String preset ids replace the numeric pair; both spellings must never
        # travel together.
        self.assertEqual(parameters["ucPresetId"], "heavy")
        self.assertEqual(parameters["qualityPresetId"], "none")
        self.assertNotIn("ucPreset", parameters)
        self.assertNotIn("qualityToggle", parameters)
        # V5 has no schedule picker and no Variety+, and rejects SMEA outright.
        self.assertEqual(parameters["noise_schedule"], "karras")
        self.assertNotIn("skip_cfg_above_sigma", parameters)
        self.assertFalse(parameters["sm"])
        self.assertFalse(parameters["sm_dyn"])
        self.assertTrue(parameters["straight_alpha"])
        # Vibe transfer is unavailable on V5 for now, so the arrays are dropped
        # rather than sent empty.
        self.assertNotIn("reference_image_multiple", parameters)
        self.assertNotIn("reference_strength_multiple", parameters)
        # The v4-shaped condition objects stay -- V5 answers 500 without them.
        self.assertEqual(parameters["v4_prompt"]["caption"]["base_caption"], "1girl")
        self.assertEqual(
            parameters["v4_negative_prompt"]["caption"]["base_caption"], "bad anatomy"
        )

    def test_builds_v4_payload_unchanged_by_the_v5_branch(self) -> None:
        params = GenerationParams(model="nai-diffusion-4-5-full", seed=7)
        parameters = build_official_payload("1girl", "bad anatomy", params)["parameters"]

        self.assertEqual(parameters["params_version"], 3)
        self.assertEqual(parameters["ucPreset"], 0)
        self.assertFalse(parameters["qualityToggle"])
        self.assertIsNone(parameters["skip_cfg_above_sigma"])
        self.assertNotIn("straight_alpha", parameters)
        self.assertEqual(parameters["reference_image_multiple"], [])

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

    def test_parses_opus_usage_limit(self) -> None:
        parsed = parse_anlas_subscription(
            {
                "tier": 3,
                "active": True,
                # Over 100 is legal: NovelAI granted a one-time boost past the cap.
                "usage": {"percent": 170, "isNegative": False, "timeUntilNextPercent": 0},
            }
        )

        self.assertEqual(parsed["opusUsage"]["percent"], 170)
        self.assertFalse(parsed["opusUsage"]["isNegative"])
        self.assertEqual(parsed["opusUsage"]["timeUntilNextPercent"], 0)

    def test_omits_opus_usage_when_absent(self) -> None:
        # Below Opus the field is not sent at all; the client must not invent a
        # zeroed bar, which would read as "allowance exhausted".
        self.assertNotIn("opusUsage", parse_anlas_subscription({"tier": 1, "active": True}))

    def test_reports_exhausted_opus_usage(self) -> None:
        parsed = parse_anlas_subscription(
            {
                "tier": 3,
                "active": True,
                "usage": {"percent": 0, "isNegative": True, "timeUntilNextPercent": 240},
            }
        )

        self.assertEqual(parsed["opusUsage"]["percent"], 0)
        self.assertTrue(parsed["opusUsage"]["isNegative"])
        self.assertEqual(parsed["opusUsage"]["timeUntilNextPercent"], 240)


if __name__ == "__main__":
    unittest.main()
