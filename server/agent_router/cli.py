"""
AI Agent 交互式调试 CLI。

用法（在 server/ 目录下跑）:
    python -m agent_router.cli

或从仓库根:
    cd novelai_web_ui/server && python -m agent_router.cli

前置条件:
    - server 必须在 8766（或自定义）端口跑着，因为 chat_agent 的 tools 要调本机数据 API
    - 模型渠道已配置（CLI Proxy 等）

功能:
    - REPL：输入消息，回车发送
    - 实时打印每一步：工具调用 / 子 Agent 委派 / 模型切换 / 耗时
    - 上下文累积：连续多轮对话使用同一份 history
    - 命令:
        /model <名称/别名>      - 切换本会话使用的 model
        /clear                  - 清空 history
        /info                   - 显示当前 model 与状态
        /quit                   - 退出（Ctrl+D / Ctrl+C 也行）

注意:
    本工具与正在运行的 server 共享 *数据* 但不共享 *进程*：
    CLI 进程内启一个新的 chat_agent 实例做调度，工具调用通过 HTTP 打到 server。
    这样能拿到 chat_agent 内部所有 SSE 事件（HTTP /api/agent/chat 不流式）。
"""
from __future__ import annotations

import asyncio
import os
import sys
import time
import argparse
from pathlib import Path

# 把 server 目录加进 sys.path（这样能 import agent_router 子模块）
_SERVER_DIR = Path(__file__).resolve().parents[1]
if str(_SERVER_DIR) not in sys.path:
    sys.path.insert(0, str(_SERVER_DIR))

import httpx  # noqa: E402

from agent_router.deps import AgentDeps  # noqa: E402
from agent_router.schemas import SseEvent  # noqa: E402
from agent_router.model_provider import get_active_channel_info  # noqa: E402
from agent_router.cli_preprocess import build_env_info_for_cli  # noqa: E402


# ============================================================
# ANSI 颜色（Windows cmd 可能不支持，靠 colorama 或 PowerShell 自动 OK）
# ============================================================

class C:
    R = "\033[0m"
    DIM = "\033[2m"
    B = "\033[1m"
    CYAN = "\033[36m"
    YEL = "\033[33m"
    GRN = "\033[32m"
    RED = "\033[31m"
    BLU = "\033[34m"
    MAG = "\033[35m"
    GRY = "\033[90m"


def _enable_windows_ansi() -> None:
    """Windows 10+ 启用 ANSI 转义码 + 强制 UTF-8 输出（cmd.exe 默认 GBK，无法打印 emoji）"""
    if os.name != "nt":
        return
    try:
        # 强制 stdout/stderr UTF-8，避免 GBK 撞死 emoji / unicode 符号
        for stream in (sys.stdout, sys.stderr):
            try:
                stream.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[attr-defined]
            except Exception:
                pass
        import ctypes
        kernel32 = ctypes.windll.kernel32
        # ENABLE_VIRTUAL_TERMINAL_PROCESSING = 0x0004
        for handle in (-11, -12):  # stdout, stderr
            h = kernel32.GetStdHandle(handle)
            mode = ctypes.c_uint32()
            if kernel32.GetConsoleMode(h, ctypes.byref(mode)):
                kernel32.SetConsoleMode(h, mode.value | 0x0004)
        # 切换控制台 code page 到 UTF-8（65001）
        try:
            kernel32.SetConsoleOutputCP(65001)
            kernel32.SetConsoleCP(65001)
        except Exception:
            pass
    except Exception:
        pass


# ============================================================
# Trace 记录器：负责把 SSE 事件 + agent 阶段打印到终端
# ============================================================

class TraceLogger:
    """累积本轮对话的事件 + 时间戳"""

    def __init__(self) -> None:
        self.t0: float = 0.0
        self.last_t: float = 0.0
        self.delegate_starts: dict[str, float] = {}  # target -> start_time
        self.tool_starts: dict[str, float] = {}      # name -> start_time

    def start(self) -> None:
        self.t0 = time.time()
        self.last_t = self.t0
        self.delegate_starts.clear()
        self.tool_starts.clear()

    def _stamp(self) -> tuple[int, int]:
        """返回 (总耗时 ms, 距上一事件 ms)"""
        now = time.time()
        total = int((now - self.t0) * 1000)
        delta = int((now - self.last_t) * 1000)
        self.last_t = now
        return total, delta

    def elapsed_ms(self) -> int:
        return int((time.time() - self.t0) * 1000)

    async def emit(self, event: SseEvent) -> None:
        total, delta = self._stamp()
        prefix = f"{C.GRY}[{total:>6}ms +{delta:>5}ms]{C.R}"

        e = event.event
        d = event.data
        if hasattr(d, "model_dump"):
            try:
                d = d.model_dump()
            except Exception:
                pass
        d = d or {}

        if e == "tool_call":
            name = d.get("name", "?")
            args = d.get("arguments") or {}
            args_str = ", ".join(f"{k}={_truncate(repr(v), 40)}" for k, v in args.items())
            self.tool_starts[name] = time.time()
            print(f"{prefix} {C.CYAN}→ tool      {C.B}{name:20}{C.R} {C.DIM}({args_str}){C.R}")

        elif e == "tool_result":
            name = d.get("name", "?")
            summary = d.get("summary", "")
            tstart = self.tool_starts.pop(name, None)
            took = int((time.time() - tstart) * 1000) if tstart else None
            took_str = f"{C.DIM}[{took}ms]{C.R} " if took is not None else ""
            print(f"{prefix} {C.GRN}← tool ok   {C.R}{name:20} {took_str}{C.DIM}{summary}{C.R}")

        elif e == "delegate_start":
            target = d.get("target", "?")
            preview = _truncate(str(d.get("input", "")), 80)
            self.delegate_starts[target] = time.time()
            print(f"{prefix} {C.MAG}↘ delegate  {C.B}{target:20}{C.R} {C.DIM}input: {preview}{C.R}")

        elif e == "delegate_end":
            target = d.get("target", "?")
            tstart = self.delegate_starts.pop(target, None)
            took = int((time.time() - tstart) * 1000) if tstart else None
            took_str = f"{C.B}[{took}ms]{C.R} " if took is not None else ""
            extra = ""
            if "positive_preview" in d:
                extra = f"  {C.DIM}positive: {_truncate(d['positive_preview'], 60)}{C.R}"
            print(f"{prefix} {C.MAG}↖ delegate  {target:20}{C.R} {took_str}done{extra}")

        elif e == "error":
            print(f"{prefix} {C.RED}✗ error      {d}{C.R}")

        elif e == "degraded":
            print(f"{prefix} {C.YEL}⚠ degraded   {d}{C.R}")

        else:
            print(f"{prefix} {e}: {_truncate(repr(d), 100)}")


def _truncate(s: str, n: int) -> str:
    if len(s) <= n:
        return s
    return s[: n - 1] + "…"


# ============================================================
# agent.iter() node 内容打印
# ============================================================

def _describe_part(part) -> tuple[str, str, str]:
    """
    把 PydanticAI 的 ModelRequest/ModelResponse part 转成 (kind_label, color, preview)。
    返回:
        kind_label: 'system' / 'user' / 'tool_return' / 'text' / 'tool_call' 等
        color: ANSI 颜色
        preview: 字段值的字符串预览
    """
    cls_name = type(part).__name__

    if cls_name == "SystemPromptPart":
        content = getattr(part, "content", "")
        return ("system", C.GRY, content if isinstance(content, str) else str(content))
    if cls_name == "UserPromptPart":
        content = getattr(part, "content", "")
        if isinstance(content, list):
            # 多模态：拼成预览
            previews = []
            for sub in content:
                if isinstance(sub, str):
                    previews.append(sub)
                else:
                    previews.append(f"<{type(sub).__name__}>")
            return ("user", C.YEL, " | ".join(previews))
        return ("user", C.YEL, str(content))
    if cls_name == "ToolReturnPart":
        name = getattr(part, "tool_name", "?")
        content = getattr(part, "content", "")
        return (f"tool_return[{name}]", C.GRN, str(content))
    if cls_name == "TextPart":
        return ("text", C.CYAN, str(getattr(part, "content", "")))
    if cls_name == "ToolCallPart":
        name = getattr(part, "tool_name", "?")
        args = getattr(part, "args", None)
        if isinstance(args, str):
            args_str = args
        else:
            args_str = str(args)
        return (f"tool_call[{name}]", C.MAG, args_str)
    if cls_name == "RetryPromptPart":
        return ("retry", C.RED, str(getattr(part, "content", "")))
    if cls_name == "ThinkingPart":
        return ("thinking", C.GRY, str(getattr(part, "content", "")))
    return (cls_name, C.GRY, str(part))


def _print_request_node(idx: int, parts: list, node_ms: int, verbose: bool) -> None:
    """打印一次 LLM Request 节点（即将发给 LLM 的内容）"""
    head = f"{C.GRY}[{node_ms:>6}ms]{C.R} {C.B}{C.BLU}→ LLM#{idx} REQUEST{C.R}"
    if not verbose:
        # 简洁版：只统计每种 part 的数量
        from collections import Counter
        kinds = Counter()
        for p in parts:
            kind, _, _ = _describe_part(p)
            kinds[kind] += 1
        summary = ", ".join(f"{k}×{v}" for k, v in kinds.items())
        print(f"{head}  {C.DIM}{summary}{C.R}")
        return

    # verbose 版：每个 part 完整打印（system 截断为 200 字符避免刷屏）
    print(f"{head}  {C.DIM}({len(parts)} parts){C.R}")
    for i, p in enumerate(parts):
        kind, color, preview = _describe_part(p)
        prefix = f"  {C.GRY}[{i}]{C.R} {color}{kind:18}{C.R}"
        if kind == "system":
            # system 通常很长，预览前 180 字
            print(f"{prefix}  ({len(preview)} chars) {C.DIM}{_truncate(preview, 180)}{C.R}")
        elif "tool_return" in kind:
            print(f"{prefix}  {C.DIM}{_truncate(preview, 220)}{C.R}")
        else:
            print(f"{prefix}  {_truncate(preview, 220)}")


def _print_response_node(idx: int, parts: list, node_ms: int, verbose: bool) -> None:
    """打印一次 LLM Response 节点（LLM 回的内容，含 text / tool_calls）"""
    head = f"{C.GRY}[{node_ms:>6}ms]{C.R} {C.B}{C.MAG}← LLM#{idx} RESPONSE{C.R}"

    # 简洁与 verbose 都打印每个 part：因为 response 通常短，且承载关键决策信息
    print(f"{head}  {C.DIM}({len(parts)} parts){C.R}")
    for i, p in enumerate(parts):
        kind, color, preview = _describe_part(p)
        prefix = f"  {C.GRY}[{i}]{C.R} {color}{kind:18}{C.R}"
        if "tool_call" in kind:
            print(f"{prefix}  {C.B}{preview}{C.R}")
        elif kind == "text":
            limit = 400 if verbose else 200
            print(f"{prefix}  {_truncate(preview, limit)}")
        else:
            print(f"{prefix}  {_truncate(preview, 200)}")


def _print_end_node(output, node_ms: int, verbose: bool) -> None:
    """打印 End 节点（最终 agent output）"""
    print(f"{C.GRY}[{node_ms:>6}ms]{C.R} {C.B}{C.GRN}■ END{C.R}  {C.DIM}output type: {type(output).__name__}{C.R}")
    if verbose and output is not None:
        try:
            data = output.model_dump() if hasattr(output, "model_dump") else output
        except Exception:
            data = str(output)
        import json as _json
        try:
            dump = _json.dumps(data, ensure_ascii=False, default=str, indent=2)
        except Exception:
            dump = str(data)
        # 限制到 1KB
        if len(dump) > 1000:
            dump = dump[:997] + "…"
        for line in dump.split("\n"):
            print(f"  {C.DIM}{line}{C.R}")


def _print_transcript(messages: list, *, verbose: bool) -> None:
    """把一次 run 的完整 transcript（all_messages）按 request/response 节点打印（事后回看）。"""
    from agent_router.llm.messages import ModelRequest, ModelResponse
    idx = 0
    for m in messages:
        if isinstance(m, ModelRequest):
            idx += 1
            _print_request_node(idx, list(getattr(m, "parts", []) or []), 0, verbose=verbose)
        elif isinstance(m, ModelResponse):
            _print_response_node(idx, list(getattr(m, "parts", []) or []), 0, verbose=verbose)


# ============================================================
# REPL 主循环
# ============================================================

async def run_repl(
    *,
    model: str,
    base_url: str,
    scene: str,
    session_id: str = "",
    verbose: bool = False,
    preprocess: bool = True,
) -> None:
    info = get_active_channel_info()
    print(f"{C.B}━━━ AI Agent 交互式调试器（合并版）━━━{C.R}")
    print(f"{C.DIM}默认协议: {info['default_protocol']}  全局默认 model: {info.get('active_model')}{C.R}")
    for ckey, choice in info.get("choices", {}).items():
        print(f"{C.DIM}  {ckey:12} {choice.get('label', '')}  → {choice.get('model')}{C.R}")
    print(f"{C.DIM}Internal API base (tools 调用): {base_url}{C.R}")
    if session_id:
        print(f"{C.DIM}Session ID: {session_id[:12]}...（用于授权工具调用 /api/oc, /api/artists 等）{C.R}")
    else:
        print(f"{C.YEL}Session ID: <空> (search_character 的 OC 部分 / search_artist 等需授权工具会降级，传 --session-id 启用){C.R}")
    print(f"{C.DIM}Scene: {scene}   model: {model or '(默认)'}   verbose: {verbose}   preprocess: {preprocess}{C.R}")
    print(f"{C.DIM}命令: /model <名称>  /scene <private|group>  /verbose  /preprocess  /clear  /info  /quit{C.R}")
    print()

    user_id = "cli_debug_user"
    user_key = f"cli_p_{user_id}" if scene == "private" else f"cli_g_{user_id}"
    history: list = []
    http_client = httpx.AsyncClient(timeout=httpx.Timeout(120.0))

    try:
        while True:
            try:
                msg = input(f"{C.YEL}{C.B}You>{C.R} ").strip()
            except (EOFError, KeyboardInterrupt):
                print()
                break

            if not msg:
                continue

            # ----- 命令处理 -----
            if msg in ("/quit", "/exit", "/q"):
                break
            if msg == "/clear":
                history = []
                print(f"{C.GRN}history cleared.{C.R}\n")
                continue
            if msg == "/info":
                print(f"{C.DIM}history msgs: {len(history)}  model: {model or '(默认)'}  scene: {scene}  verbose: {verbose}  preprocess: {preprocess}{C.R}\n")
                continue
            if msg == "/verbose":
                verbose = not verbose
                print(f"{C.GRN}verbose = {verbose}{C.R}\n")
                continue
            if msg == "/preprocess":
                preprocess = not preprocess
                print(f"{C.GRN}preprocess = {preprocess}{C.R}\n")
                continue
            if msg.startswith("/model"):
                parts = msg.split(maxsplit=1)
                if len(parts) == 2 and parts[1].strip():
                    try:
                        from config import resolve_model  # type: ignore
                        key, _ch = resolve_model(parts[1].strip())
                        model = key
                        print(f"{C.GRN}model = {model}{C.R}\n")
                    except Exception as e:
                        print(f"{C.RED}未知 model: {e}{C.R}\n")
                else:
                    print(f"{C.RED}usage: /model <名称/别名>{C.R}\n")
                continue
            if msg.startswith("/scene"):
                parts = msg.split()
                if len(parts) == 2 and parts[1] in ("private", "group"):
                    scene = parts[1]
                    user_key = f"cli_{'g' if scene == 'group' else 'p'}_{user_id}"
                    print(f"{C.GRN}scene = {scene}, user_key = {user_key}{C.R}\n")
                else:
                    print(f"{C.RED}usage: /scene <private|group>{C.R}\n")
                continue

            # ----- 模拟 bot preprocess：构建 env_info 并拼到 msg 末尾 -----
            agent_input = msg
            env_info = ""
            if preprocess:
                try:
                    env_info = build_env_info_for_cli(msg)
                except Exception as e:
                    print(f"{C.RED}preprocess 失败（不影响主流程）: {e}{C.R}")
                if env_info:
                    agent_input = f"{msg}\n\n[环境信息]\n{env_info}"

            # ----- 实际调用 chat_agent -----
            print(f"{C.DIM}─── run: model={model or '(默认)'} scene={scene} history={len(history)} msg={_truncate(msg, 60)!r}{C.R}")
            if env_info:
                first_line = env_info.split("\n", 1)[0]
                print(f"{C.DIM}     env_info 注入: {len(env_info)} 字符（首行: {_truncate(first_line, 60)}）{C.R}")

            tracer = TraceLogger()
            tracer.start()
            print(f"{C.GRY}[     0ms      0ms]{C.R} {C.B}{C.BLU}▶ lite + planner ({model or '默认'}){C.R} start")

            deps = AgentDeps(
                user_id=user_id,
                user_key=user_key,
                platform="cli",
                scene=scene,  # type: ignore[arg-type]
                selected_model=model,
                http_client=http_client,
                internal_base_url=base_url,
                session_id=session_id,
                sse_emitter=tracer.emit,
            )

            t0 = time.time()
            try:
                from agent_router.model_provider import get_model, get_model_settings
                from agent_router.agents.lite_chat import run_lite_chat
                from agent_router.agents.pure_planner import pure_planner_agent
                from agent_router.schemas import ChatOutput
                from agent_router.router import _split_prequery_from_env

                # ===== Lite 阶段：回复 + 意图判断 + 资料筛选三合一（与生产 router 一致）=====
                raw_prequery, _other_env = _split_prequery_from_env(env_info or "")
                lite_result, lite_messages, _lite_sys = await run_lite_chat(
                    user_text=msg,
                    candidates=raw_prequery,
                    history=history,
                    deps=deps,
                )
                reply = (lite_result.reply_text or "本喵在喵~").strip() or "本喵在喵~"
                should_draw = bool(lite_result.should_draw)
                draw_spec = None
                pp_result = None

                if verbose and lite_messages:
                    print(f"{C.GRY}─── lite_chat transcript ───{C.R}")
                    _print_transcript(lite_messages, verbose=verbose)

                # ===== Planner 阶段：pure_planner 产 DrawSpec =====
                if should_draw:
                    pp_result = await pure_planner_agent.run(
                        agent_input,
                        deps=deps,
                        message_history=history,
                        model=get_model(model),
                        model_settings=get_model_settings(model),
                    )
                    spec = pp_result.output  # DrawSpec
                    draw_spec = spec.model_dump() if hasattr(spec, "model_dump") else dict(spec)
                    if verbose:
                        print(f"{C.GRY}─── pure_planner transcript ───{C.R}")
                        _print_transcript(list(pp_result.all_messages()), verbose=verbose)

                total_ms = int((time.time() - t0) * 1000)
                output = ChatOutput(reply_text=reply, draw_spec=draw_spec, should_draw=should_draw)

                # 追加新消息到 history（CLI 连续多轮的上下文延续；planner 阶段为准）
                try:
                    if pp_result is not None:
                        history.extend(pp_result.new_messages())
                except Exception:
                    pass

                stages = "lite" + ("+planner" if should_draw else "（闲聊收尾）")
                print(f"{C.GRY}[{tracer.elapsed_ms():>6}ms {' ':>8}]{C.R} {C.B}{C.GRN}✓ done{C.R}  total {C.B}{total_ms}ms{C.R}  ({stages})")
                print()
                print(f"{C.CYAN}{C.B}Bot>{C.R} {output.reply_text}")

                # 单 spec：output.draw_spec 是 Optional[dict]
                effective_specs = [output.draw_spec] if output.draw_spec else []
                effective_should_draw = output.should_draw

                if effective_should_draw and effective_specs:
                    for i, spec in enumerate(effective_specs):
                        if not isinstance(spec, dict):
                            spec = spec.model_dump() if hasattr(spec, "model_dump") else dict(spec)
                        positive = spec.get("positive", "")
                        negative = spec.get("negative", "")
                        size = spec.get("size") or "(none)"
                        chars = spec.get("characters")
                        print(f"{C.MAG}  ✏ draw_spec:{C.R}")
                        print(f"{C.DIM}    positive: {_truncate(str(positive), 200)}{C.R}")
                        if negative:
                            print(f"{C.DIM}    negative: {_truncate(str(negative), 120)}{C.R}")
                        print(f"{C.DIM}    size: {size}{C.R}")
                        # 防御性显示：LLM 偶尔会把 characters 输出成 int / str / 错误结构
                        if isinstance(chars, list) and chars:
                            print(f"{C.DIM}    characters: {len(chars)} 个{C.R}")
                        elif chars and not isinstance(chars, list):
                            print(f"{C.YEL}    characters: 类型错误 (期望 list[dict]，得到 {type(chars).__name__}: {chars!r}){C.R}")

                if pp_result is not None:
                    try:
                        u = pp_result.usage
                        if u:
                            print(f"{C.DIM}  usage(planner): in={u.input_tokens} out={u.output_tokens} reqs={u.requests}{C.R}")
                    except Exception:
                        pass

                print()
            except KeyboardInterrupt:
                print(f"\n{C.RED}✗ 取消{C.R}\n")
            except Exception as e:
                print(f"{C.RED}✗ ERROR: {type(e).__name__}: {e}{C.R}\n")
    finally:
        await http_client.aclose()
        print(f"{C.DIM}bye.{C.R}")


# ============================================================
# Entry
# ============================================================

def main() -> None:
    _enable_windows_ansi()
    parser = argparse.ArgumentParser(description="AI Agent 交互式调试 CLI")
    parser.add_argument("--model", default="",
                        help="初始 model（MODEL_CHOICES 的 key/别名；空=全局默认）")
    parser.add_argument(
        "--base-url",
        default=os.environ.get("AGENT_BASE_URL", "http://127.0.0.1:8766"),
        help="server 地址（CLI 调本机 data API 用）。可用环境变量 AGENT_BASE_URL 覆盖。"
             " 示例: https://nai.sora214.top"
    )
    parser.add_argument(
        "--session-id",
        default=os.environ.get("AGENT_SESSION_ID", ""),
        help="后端授权 session（用于 search_character 的 OC 部分 / search_artist 等需授权工具）。"
             " 可用环境变量 AGENT_SESSION_ID 覆盖。空则跳过授权（部分工具会失败）。"
    )
    parser.add_argument("--scene", default="private", choices=["private", "group"],
                        help="对话场景（默认 private）")
    parser.add_argument("-v", "--verbose", action="store_true",
                        help="启用详细模式，打印每次 LLM call 的完整 request/response parts")
    parser.add_argument("--no-preprocess", action="store_true",
                        help="跳过 env_info 预匹配模拟，把原始 msg 直接喂给 chat_agent（纯净测试）")
    args = parser.parse_args()

    try:
        asyncio.run(run_repl(
            model=args.model,
            base_url=args.base_url,
            scene=args.scene,
            session_id=args.session_id,
            verbose=args.verbose,
            preprocess=not args.no_preprocess,
        ))
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
