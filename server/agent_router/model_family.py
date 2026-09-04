"""Normalize NovelAI image-model identifiers into planner behavior families."""

from __future__ import annotations

from typing import Literal

ModelFamily = Literal["v5", "v45", "anima", "unknown"]

_MODEL_FAMILIES: dict[str, ModelFamily] = {
    "nai-diffusion-5-full": "v5",
    "nai-diffusion-5-curated": "v5",
    "nai_v5_full": "v5",
    "nai_v5_curated": "v5",
    "nai-diffusion-4-5-full": "v45",
    "nai-diffusion-4-5-curated": "v45",
    "nai_v45_full": "v45",
    "nai_v45_curated": "v45",
    "anima": "anima",
}


def normalize_model_family(image_model: str | None) -> ModelFamily:
    """Return the prompt-writing family for a loose image-model identifier."""

    normalized = (image_model or "").strip().casefold()
    return _MODEL_FAMILIES.get(normalized, "unknown")


__all__ = ["ModelFamily", "normalize_model_family"]
