"""
自研 LLM 框架 —— Agent（替代 pydantic_ai.Agent）。

职责：
    - 注册（装饰器或命令式两种形态）：system_prompt / output_validator / tool
    - run()：组装 system + history + 用户轮 → 驱动「工具循环 + 结构化输出解析 + validator 链」
             → ModelRetry / 校验失败按 retries 预算重投 → 反复空输出抛 EMPTY_OUTPUT_MESSAGE
    - system_prompt_parts(deps=)：不发网络，仅求值各 system_prompt 函数（router 调试 + lite 用）

关键语义（与 pydantic_ai 1.x 对齐，router 依赖）：
    - 带 message_history 时 all_messages() **不含 SystemPromptPart**（system 只在无 history 时
      并入首条 ModelRequest）；router 据此用 system_prompt_parts() 补回。
    - ToolReturnPart.content 存**原始**工具返回值（router 跨轮提炼直接 duck-type 读字段）。
    - native 结构化输出靠合成的 final_result 工具收尾；str/prompted 用最终助手文本。
"""
from __future__ import annotations

import json
from typing import Any, Callable, Generic, Optional, TypeVar

from .context import RunContext
from .messages import (
    ModelMessage, ModelRequest, ModelResponse,
    SystemPromptPart, UserPromptPart, ToolReturnPart, RetryPromptPart,
    TextPart, ToolCallPart, ToolDefinition, BinaryContent,
)
from .output import (
    resolve_output_strategy, OUTPUT_TOOL_NAME, StrOutput,
)
from .exceptions import ModelRetry, UnexpectedModelBehavior, EMPTY_OUTPUT_MESSAGE
from .result import RunResult, Usage
from .tools import build_registered_tool, serialize_tool_result, RegisteredTool

DepsT = TypeVar("DepsT")
OutputT = TypeVar("OutputT")

# 单次 run 内最多模型往返次数（工具循环 + 重试）的硬上限，防跑飞。
_MAX_ITERATIONS = 16


class Agent(Generic[DepsT, OutputT]):
    def __init__(
        self,
        model: Any = None,
        *,
        deps_type: Optional[type] = None,
        output_type: Any = str,
        retries: int = 1,
    ) -> None:
        self._default_model = model
        self._deps_type = deps_type
        self._output_type = output_type
        self._strategy = resolve_output_strategy(output_type)
        self._retries = max(0, int(retries))
        self._system_prompt_fns: list[Callable] = []
        self._output_validators: list[Callable] = []
        self._tools: dict[str, RegisteredTool] = {}

    # ============================================================
    # 注册（@agent.x 装饰器 与 agent.x(fn) 命令式 双形态）
    # ============================================================

    def system_prompt(self, func: Optional[Callable] = None):
        def deco(fn: Callable) -> Callable:
            self._system_prompt_fns.append(fn)
            return fn
        return deco(func) if func is not None else deco

    def output_validator(self, func: Optional[Callable] = None):
        def deco(fn: Callable) -> Callable:
            self._output_validators.append(fn)
            return fn
        return deco(func) if func is not None else deco

    def tool(self, func: Optional[Callable] = None, *, strict: bool = False):
        def deco(fn: Callable) -> Callable:
            self._tools[fn.__name__] = build_registered_tool(fn, strict=strict)
            return fn
        return deco(func) if func is not None else deco

    # ============================================================
    # system prompt 求值
    # ============================================================

    async def _eval_system_fns(self, ctx: RunContext) -> list[SystemPromptPart]:
        parts: list[SystemPromptPart] = []
        for fn in self._system_prompt_fns:
            try:
                s = fn(ctx)
                if hasattr(s, "__await__"):
                    s = await s
            except Exception:
                s = ""
            parts.append(SystemPromptPart(content=s or ""))
        return parts

    async def system_prompt_parts(self, *, deps: Any = None) -> list[SystemPromptPart]:
        """仅求值各 system_prompt 函数（不发网络、不含 prompted 指令），供 router 调试。"""
        ctx = RunContext(deps=deps)
        return await self._eval_system_fns(ctx)

    async def _resolve_system_for_run(self, ctx: RunContext) -> list[SystemPromptPart]:
        parts = await self._eval_system_fns(ctx)
        instr = self._strategy.system_instruction()
        if instr:
            parts.append(SystemPromptPart(content=instr))
        return parts

    # ============================================================
    # run
    # ============================================================

    async def run(
        self,
        user_input: Any,
        *,
        deps: Any = None,
        message_history: Optional[list[ModelMessage]] = None,
        model: Any = None,
        model_settings: Optional[dict] = None,
    ) -> RunResult:
        active_model = model or self._default_model
        if active_model is None:
            raise RuntimeError("Agent.run: 未提供 model")

        ctx = RunContext(deps=deps)
        history = list(message_history or [])
        history_len = len(history)

        system_parts = await self._resolve_system_for_run(ctx)

        # 工具集：用户工具 +（native 时）final_result 输出工具
        tool_defs: list[ToolDefinition] = [t.definition() for t in self._tools.values()]
        output_tool = self._strategy.output_tool()
        if output_tool is not None:
            tool_defs = [*tool_defs, output_tool]
        require_tool = not self._strategy.wants_text_output

        # 本轮新增消息（不含 system；system 仅经 system_parts 传给 provider）
        new_msgs: list[ModelMessage] = [ModelRequest(parts=[UserPromptPart(content=user_input)])]

        usage = Usage()
        retries_left = self._retries
        iterations = 0

        while True:
            iterations += 1
            if iterations > _MAX_ITERATIONS:
                raise UnexpectedModelBehavior(EMPTY_OUTPUT_MESSAGE)

            response, req_usage = await active_model.request(
                history + new_msgs,
                system_parts=system_parts,
                tools=tool_defs,
                require_tool=require_tool,
                model_settings=model_settings,
            )
            usage.incorporate(req_usage)
            new_msgs.append(response)

            tool_calls = [p for p in response.parts if isinstance(p, ToolCallPart)]
            final_call = None
            user_calls: list[ToolCallPart] = []
            for tc in tool_calls:
                if output_tool is not None and tc.tool_name == OUTPUT_TOOL_NAME:
                    final_call = tc
                else:
                    user_calls.append(tc)

            # ---- 执行用户工具调用 ----
            if user_calls:
                return_parts: list = []
                for tc in user_calls:
                    return_parts.append(await self._run_one_tool(ctx, tc))
                new_msgs.append(ModelRequest(parts=return_parts))
                # 工具抛 ModelRetry（_run_one_tool 返回 RetryPromptPart）消耗 retries 预算，
                # 否则会一直重投直到撞 _MAX_ITERATIONS。
                if any(isinstance(p, RetryPromptPart) for p in return_parts):
                    retries_left -= 1
                    if retries_left < 0:
                        raise UnexpectedModelBehavior(EMPTY_OUTPUT_MESSAGE)
                if final_call is None:
                    continue  # 回到模型，带着工具结果继续

            # ---- 收尾：解析候选输出 ----
            candidate, parse_error = await self._extract_candidate(response, final_call, user_calls)

            if parse_error is not None:
                retries_left -= 1
                if retries_left < 0:
                    raise UnexpectedModelBehavior(EMPTY_OUTPUT_MESSAGE)
                # 若本轮模型已发起 final_result 调用（native），重试必须以 tool_result 回应它，
                # 否则 assistant(tool_use) 后跟一条纯文本 user 会破坏工具配对（Anthropic/OpenAI 400）。
                new_msgs.append(self._retry_request(self._retry_instruction(parse_error), final_call))
                continue

            # ---- output_validators 链 ----
            retry_msg = None
            try:
                for validator in self._output_validators:
                    out = validator(ctx, candidate)
                    if hasattr(out, "__await__"):
                        out = await out
                    candidate = out
            except ModelRetry as mr:
                retry_msg = mr.message
            if retry_msg is not None:
                retries_left -= 1
                if retries_left < 0:
                    raise UnexpectedModelBehavior(EMPTY_OUTPUT_MESSAGE)
                # 同上：native 下 candidate 来自 final_result 调用，重试也要回应那次 tool_use。
                new_msgs.append(self._retry_request(retry_msg, final_call))
                continue

            # ---- 完成 ----
            if final_call is not None:
                new_msgs.append(ModelRequest(parts=[ToolReturnPart(
                    tool_name=OUTPUT_TOOL_NAME,
                    content="Final result processed.",
                    tool_call_id=final_call.tool_call_id,
                )]))
            transcript = self._build_transcript(history, new_msgs, system_parts)
            return RunResult(candidate, transcript, history_len=history_len, usage=usage)

    # ============================================================
    # 内部
    # ============================================================

    async def _run_one_tool(self, ctx: RunContext, tc: ToolCallPart) -> ToolReturnPart | RetryPromptPart:
        tool = self._tools.get(tc.tool_name)
        if tool is None:
            return ToolReturnPart(
                tool_name=tc.tool_name,
                content=f"未知工具: {tc.tool_name}",
                tool_call_id=tc.tool_call_id,
            )
        args = tc.args if isinstance(tc.args, dict) else _safe_json(tc.args)
        try:
            raw = await tool.invoke(ctx, args)
            _json_val, raw_val = serialize_tool_result(raw)
            return ToolReturnPart(tool_name=tc.tool_name, content=raw_val, tool_call_id=tc.tool_call_id)
        except ModelRetry as mr:
            return RetryPromptPart(content=mr.message, tool_name=tc.tool_name, tool_call_id=tc.tool_call_id)
        except Exception as e:  # 工具内部异常不致命，回灌错误让模型自纠
            return ToolReturnPart(
                tool_name=tc.tool_name,
                content=f"工具执行失败: {type(e).__name__}: {e}",
                tool_call_id=tc.tool_call_id,
            )

    async def _extract_candidate(self, response, final_call, user_calls) -> tuple[Any, Any]:
        """返回 (candidate, parse_error)；parse_error 非 None 表示需重试。"""
        if not self._strategy.wants_text_output:
            # native：靠 final_result 工具
            if final_call is not None:
                args = final_call.args if isinstance(final_call.args, dict) else _safe_json(final_call.args)
                try:
                    return self._strategy.parse_tool_args(args), None
                except Exception as e:
                    return None, e
            # 没 final_result：若本轮也没有用户工具调用 → 空输出，需重试
            if not user_calls:
                return None, "no_final_result"
            # 有用户工具调用但还没 final → 由 run 主循环 continue（不在这里收尾）
            return None, None
        # str / prompted：用最终助手文本
        text = _collect_text(response)
        if isinstance(self._strategy, StrOutput):
            return self._strategy.parse_text(text), None
        if not text.strip():
            return None, "empty_text"
        try:
            return self._strategy.parse_text(text), None
        except Exception as e:
            return None, e

    def _retry_request(self, content: str, final_call) -> ModelRequest:
        """
        构造一条重试请求。

        - final_call 非空（native：模型已发起 final_result 工具调用但解析/校验失败）：
          重试必须作为 **tool_result** 回应那次 final_result 调用（带 tool_name + tool_call_id），
          否则 assistant(tool_use) 后跟纯文本 user 会破坏工具配对，被 Anthropic/OpenAI 拒为 400。
        - final_call 为空（str/prompted，或 native 但模型只回了文本没调工具）：
          上一条 assistant 是纯文本，没有挂起的 tool_use，重试作为普通 user 文本即可。
        """
        if final_call is not None:
            return ModelRequest(parts=[RetryPromptPart(
                content=content,
                tool_name=OUTPUT_TOOL_NAME,
                tool_call_id=final_call.tool_call_id,
            )])
        return ModelRequest(parts=[RetryPromptPart(content=content)])

    def _retry_instruction(self, parse_error: Any) -> str:
        if not self._strategy.wants_text_output:
            return (
                "你没有调用 final_result 工具，或其参数不合法"
                f"（{_err_text(parse_error)}）。请调用 final_result 工具，并严格按其参数 schema 填写。"
            )
        return (
            "你的输出不是合法 JSON 或不匹配要求的 schema"
            f"（{_err_text(parse_error)}）。请**只输出一个**匹配 schema 的 JSON 对象，不要任何额外文字。"
        )

    def _build_transcript(
        self, history: list, new_msgs: list, system_parts: list[SystemPromptPart]
    ) -> list[ModelMessage]:
        """
        组装 all_messages 用的完整 transcript。
        无 history 时把 system 段并入首条 ModelRequest（与 pydantic_ai 一致，router 据此不重复补 system）。
        有 history 时不含 system 段（router 会用 system_prompt_parts() 补回）。
        """
        if history:
            return [*history, *new_msgs]
        if not new_msgs:
            return list(new_msgs)
        first = new_msgs[0]
        rest = new_msgs[1:]
        if isinstance(first, ModelRequest) and system_parts:
            first = ModelRequest(parts=[*system_parts, *first.parts])
        return [first, *rest]


# ============================================================
# helpers
# ============================================================

def _collect_text(response: ModelResponse) -> str:
    return "".join(p.content for p in response.parts if isinstance(p, TextPart) and p.content)


def _safe_json(s: Any) -> dict:
    if isinstance(s, dict):
        return s
    try:
        return json.loads(s)
    except Exception:
        return {}


def _err_text(e: Any) -> str:
    if isinstance(e, str):
        return e
    return f"{type(e).__name__}: {e}"


__all__ = ["Agent", "RunContext"]
