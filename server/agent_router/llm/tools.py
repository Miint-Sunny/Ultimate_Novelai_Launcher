"""
自研 LLM 框架 —— 工具层（替代 pydantic_ai 的 @agent.tool schema 生成 + 调用 + 结果序列化）。

职责：
    1. 由 Python 函数签名（去掉首个 RunContext 参）生成入参 JSON Schema：
         str/int/float/bool/Optional[X]/list[X]/dict 映射成对应 JSON 类型；
         必填项 = 没有默认值的参；docstring 整段作 description（含 Args 段，模型够用）。
    2. 运行时把 RunContext 作为第一个位置参注入、模型给的 kwargs 按名传入、缺省走 Python 默认值。
    3. 结果序列化：list[BaseModel] -> [item.model_dump()] 发给模型；**原始返回值**另存，
       挂到 ToolReturnPart.content（router._extract_used_resources 直接 duck-type 读 .name/.tags/.prompt）。

注意：本项目工具均 `@agent.tool(strict=True)`，故 OpenAI 协议下走 strict（转换在 models/openai.py）。
"""
from __future__ import annotations

import inspect
import json
from dataclasses import dataclass, field
from typing import Any, Callable, Union, get_args, get_origin, get_type_hints

from pydantic import BaseModel

from .messages import ToolDefinition


# ============================================================
# 类型注解 -> JSON Schema
# ============================================================

def _py_type_to_schema(tp: Any) -> dict:
    """把一个 Python 类型注解映射成（普通、非 strict 的）JSON Schema 片段。"""
    if tp is None or tp is type(None):
        return {"type": "null"}
    if tp is str:
        return {"type": "string"}
    if tp is bool:
        return {"type": "boolean"}
    if tp is int:
        return {"type": "integer"}
    if tp is float:
        return {"type": "number"}

    origin = get_origin(tp)
    args = get_args(tp)

    if origin is Union:
        non_none = [a for a in args if a is not type(None)]
        if non_none:
            # Optional[X] / Union[...]：取首个非 None 分支的形态（可空性由 required 列表 + strict 渲染处理）
            return _py_type_to_schema(non_none[0])
        return {"type": "null"}

    if origin in (list, tuple, set, frozenset):
        item = args[0] if args else str
        return {"type": "array", "items": _py_type_to_schema(item)}

    if origin is dict:
        return {"type": "object"}

    if isinstance(tp, type) and issubclass(tp, BaseModel):
        # 入参极少用嵌套模型；真要用就走内联 schema（避免 $ref）
        from .output import build_inlined_json_schema
        return build_inlined_json_schema(tp)

    # 兜底当字符串
    return {"type": "string"}


def build_param_schema(
    func: Callable,
) -> tuple[dict, list[str], list[str], dict[str, Any]]:
    """
    由函数签名生成入参 schema。

    Returns:
        (schema, param_names, required_names, defaults)
        - schema: {"type":"object","properties":{...},"required":[...]}（普通形态）
        - param_names: 去掉首个 ctx 后的形参名（保持顺序）
        - required_names: 没有默认值的形参
        - defaults: {名: 默认值}（有默认值的形参）
    """
    sig = inspect.signature(func)
    try:
        hints = get_type_hints(func)
    except Exception:
        hints = {}

    params = list(sig.parameters.values())
    # 去掉第一个参（RunContext）——它不出现在 LLM 可见 schema 里
    if params:
        params = params[1:]

    properties: dict[str, dict] = {}
    required: list[str] = []
    param_names: list[str] = []
    defaults: dict[str, Any] = {}

    for p in params:
        if p.kind in (inspect.Parameter.VAR_POSITIONAL, inspect.Parameter.VAR_KEYWORD):
            continue
        name = p.name
        param_names.append(name)
        annotation = hints.get(name, p.annotation)
        if annotation is inspect.Parameter.empty:
            annotation = str
        properties[name] = _py_type_to_schema(annotation)
        if p.default is inspect.Parameter.empty:
            required.append(name)
        else:
            defaults[name] = p.default

    schema: dict = {"type": "object", "properties": properties}
    if required:
        schema["required"] = required
    return schema, param_names, required, defaults


# ============================================================
# 已注册工具
# ============================================================

@dataclass
class RegisteredTool:
    """一个挂在 Agent 上的工具：函数 + 元数据 + 入参 schema。"""

    name: str
    description: str
    func: Callable
    parameters_schema: dict
    strict: bool = False
    param_names: list[str] = field(default_factory=list)
    required_names: list[str] = field(default_factory=list)
    defaults: dict[str, Any] = field(default_factory=dict)

    def definition(self) -> ToolDefinition:
        """转成发给 provider 的 wire 描述。"""
        return ToolDefinition(
            name=self.name,
            description=self.description,
            parameters_json_schema=self.parameters_schema,
            strict=self.strict,
        )

    async def invoke(self, ctx: Any, args: dict | None) -> Any:
        """注入 ctx + 按名传 kwargs（缺省走 Python 默认值）执行，返回原始结果。"""
        kwargs: dict[str, Any] = {}
        args = args or {}
        properties = self.parameters_schema.get("properties") or {}
        for name in self.param_names:
            if name in args:
                kwargs[name] = _coerce_arg_for_schema(args[name], properties.get(name))
            elif name in self.defaults:
                kwargs[name] = self.defaults[name]
            # 既没给又没默认值 -> 不传，让函数自身报错（与 pydantic_ai 行为一致：模型应补齐 required）
        result = self.func(ctx, **kwargs)
        if inspect.isawaitable(result):
            result = await result
        return result


def _coerce_arg_for_schema(value: Any, schema: Any) -> Any:
    """Coerce stringified complex tool args back to their Python shapes."""
    if value is None or not isinstance(schema, dict):
        return value
    stype = schema.get("type")

    if stype == "array":
        if isinstance(value, list):
            return value
        if isinstance(value, str):
            s = value.strip()
            if not s:
                return []
            try:
                parsed = json.loads(s)
                if isinstance(parsed, list):
                    return parsed
            except Exception:
                pass
            return [part.strip() for part in s.split(",") if part.strip()]
        return [value]

    if stype == "object" and isinstance(value, str):
        s = value.strip()
        if not s:
            return {}
        try:
            parsed = json.loads(s)
            if isinstance(parsed, dict):
                return parsed
        except Exception:
            pass
    return value


def build_registered_tool(func: Callable, *, strict: bool = False) -> RegisteredTool:
    """从一个 `async def tool(ctx, ...)` 函数构造 RegisteredTool。"""
    schema, param_names, required, defaults = build_param_schema(func)
    return RegisteredTool(
        name=func.__name__,
        description=(func.__doc__ or "").strip(),
        func=func,
        parameters_schema=schema,
        strict=strict,
        param_names=param_names,
        required_names=required,
        defaults=defaults,
    )


# ============================================================
# 工具结果序列化
# ============================================================

def serialize_tool_result(value: Any) -> tuple[Any, Any]:
    """
    把工具返回值拆成 (给模型的 JSON 可序列化值, 留存的原始值)。

    - list[BaseModel] -> [item.model_dump()]，原始值保留为该 list[BaseModel]
    - BaseModel       -> model_dump()
    - 其它（list/dict/str/数字）-> 原样
    原始值会挂到 ToolReturnPart.content，供 router 跨轮提炼直接读结构化字段。
    """
    raw = value
    if isinstance(value, BaseModel):
        return value.model_dump(), raw
    if isinstance(value, list):
        out = [item.model_dump() if isinstance(item, BaseModel) else item for item in value]
        return out, raw
    return value, raw


__all__ = [
    "RegisteredTool",
    "build_registered_tool",
    "build_param_schema",
    "serialize_tool_result",
]
