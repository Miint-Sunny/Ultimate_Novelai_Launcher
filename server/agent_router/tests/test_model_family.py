"""Image-model normalization for request-scoped planner behavior."""

from __future__ import annotations

import pytest

from agent_router.model_family import normalize_model_family


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("nai-diffusion-5-full", "v5"),
        ("nai-diffusion-5-curated", "v5"),
        ("nai_v5_full", "v5"),
        ("NAI_V5_CURATED", "v5"),
        (" nai-diffusion-4-5-full ", "v45"),
        ("nai-diffusion-4-5-curated", "v45"),
        ("nai_v45_full", "v45"),
        ("NAI_V45_CURATED", "v45"),
        ("anima", "anima"),
        (" ANIMA ", "anima"),
        ("", "unknown"),
        (None, "unknown"),
        ("nai-diffusion-4-full", "unknown"),
        ("unrecognized", "unknown"),
    ],
)
def test_normalize_model_family(raw: str | None, expected: str) -> None:
    assert normalize_model_family(raw) == expected
