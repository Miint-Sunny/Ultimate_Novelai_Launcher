from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from sidecar.security.payloads import (
    MAX_GENERATION_DECODED_BYTES,
    MAX_SINGLE_ASSET_BYTES,
    enforce_json_decoded_budget,
    enforce_text_budget,
)

AVAILABLE_MODELS = {
    "nai-diffusion-3",
    "nai-diffusion-furry-3",
    "nai-diffusion-4-full",
    "nai-diffusion-4-curated-preview",
    "nai-diffusion-4-5-curated",
    "nai-diffusion-4-5-full",
}

AVAILABLE_SAMPLERS = {
    "k_euler_ancestral",
    "k_euler",
    "k_dpmpp_2s_ancestral",
    "k_dpmpp_2m_sde",
    "k_dpmpp_2m",
    "k_dpmpp_sde",
}

AVAILABLE_NOISE_SCHEDULES = {"karras", "native", "exponential", "polyexponential"}


class GenerationParams(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, allow_inf_nan=False)

    model: str = "nai-diffusion-4-5-full"
    width: int = 832
    height: int = 1216
    steps: int = 23
    scale: float = 5
    cfg_rescale: float = 0
    sampler: str = "k_euler_ancestral"
    noise_schedule: str = "karras"
    seed: int | None = None

    @field_validator("model")
    @classmethod
    def validate_model(cls, value: str) -> str:
        if value not in AVAILABLE_MODELS:
            raise ValueError(f"unsupported model: {value}")
        return value

    @field_validator("sampler")
    @classmethod
    def validate_sampler(cls, value: str) -> str:
        if value not in AVAILABLE_SAMPLERS:
            raise ValueError(f"unsupported sampler: {value}")
        return value

    @field_validator("noise_schedule")
    @classmethod
    def validate_noise_schedule(cls, value: str) -> str:
        if value not in AVAILABLE_NOISE_SCHEDULES:
            raise ValueError(f"unsupported noise schedule: {value}")
        return value

    @field_validator("width", "height")
    @classmethod
    def validate_size(cls, value: int) -> int:
        if value < 64 or value > 2048 or value % 64 != 0:
            raise ValueError("size must be a 64px multiple between 64 and 2048")
        return value

    @field_validator("steps")
    @classmethod
    def validate_steps(cls, value: int) -> int:
        if value < 1 or value > 50:
            raise ValueError("steps must be between 1 and 50")
        return value

    @field_validator("scale")
    @classmethod
    def validate_scale(cls, value: float) -> float:
        if value < 0 or value > 20:
            raise ValueError("scale must be between 0 and 20")
        return value

    @field_validator("cfg_rescale")
    @classmethod
    def validate_cfg(cls, value: float) -> float:
        if value < 0 or value > 1:
            raise ValueError("cfg_rescale must be between 0 and 1")
        return value

    @field_validator("seed")
    @classmethod
    def validate_seed(cls, value: int | None) -> int | None:
        if value is None:
            return value
        if value < 0 or value > 2**32 - 1:
            raise ValueError("seed must fit uint32")
        return value


class GenerateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, allow_inf_nan=False)

    input: str = Field(min_length=1, max_length=4 * 1024 * 1024)
    mode: Literal["natural", "tags"] = "tags"
    tags: str | None = Field(default=None, max_length=4 * 1024 * 1024)
    negative: str | None = Field(default=None, max_length=4 * 1024 * 1024)
    params: GenerationParams = Field(default_factory=GenerationParams)
    legacy_payload: dict[str, Any] | None = None

    @model_validator(mode="after")
    def validate_decoded_budgets(self) -> GenerateRequest:
        text_bytes = enforce_text_budget((self.input, self.tags, self.negative))
        payload_bytes = 0
        if self.legacy_payload is not None:
            payload_bytes = enforce_json_decoded_budget(
                self.legacy_payload,
                maximum=MAX_GENERATION_DECODED_BYTES,
                maximum_single_asset=MAX_SINGLE_ASSET_BYTES,
            )
        if text_bytes + payload_bytes > MAX_GENERATION_DECODED_BYTES:
            raise ValueError(
                f"decoded generation request exceeds {MAX_GENERATION_DECODED_BYTES} bytes"
            )
        return self


class ResolvedPrompt(BaseModel):
    tags: str
    negative: str = ""
    params: GenerationParams = Field(default_factory=GenerationParams)


class GenerateResponse(BaseModel):
    image_id: str
    image_url: str
    image_path: str
    input: str
    tags: str
    negative: str
    params: dict[str, Any]
    created_at: str
