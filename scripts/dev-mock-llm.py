"""Loopback OpenAI-compatible mock for exercising the Agent harness end to end.

Stateless: the reply is chosen from the tail of the conversation, so any number of
test conversations can be run without restarting.

  user text contains "步数"   -> get_studio_parameters, then update_studio_parameters, then answer
  user text contains "问我"   -> ask_user (single choice), then answer echoing the reply
  user text contains "回忆"   -> answer with how many user messages the request carried (history check)
  user text contains "加角色" -> add_character_prompt with a fixed centre, then answer
  user text contains "看图"   -> view_canvas_image index 0, then answer echoing the tool text
  user text contains "联想"   -> novelai_suggest_tags (dictionary), then answer
  user text contains "出图"   -> novelai_generate (P class: exercises the permission gate), then answer
                                 ("改完出图" chains get -> update -> generate -> answer)
  user text contains "放大"   -> novelai_upscale index 0, then answer
  user text contains "账号"   -> novelai_account_info, then answer
  tool result for get_...     -> update_studio_parameters
  tool result for update_...  -> final answer
  anything else               -> plain streamed answer (with a short reasoning delta)

Never called by anything but the local sidecar's LLM slot.
"""
import json, os, re
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(os.environ.get("MOCK_LLM_PORT", "38111"))


def chunk(delta, finish=None, usage=None, choices=True):
    body = {"id": "mock", "object": "chat.completion.chunk", "created": 0, "model": "mock-1",
            "choices": [{"index": 0, "delta": delta, "finish_reason": finish}] if choices else []}
    if usage:
        body["usage"] = usage
    return f"data: {json.dumps(body, ensure_ascii=False)}\n\n".encode()


def tool_call(name, args, cid, thought="先看看工作台现在的参数。"):
    yield chunk({"role": "assistant", "reasoning_content": thought})
    yield chunk({"tool_calls": [{"index": 0, "id": cid, "type": "function", "function": {"name": name, "arguments": ""}}]})
    text = json.dumps(args, ensure_ascii=False)
    for i in range(0, len(text), 6):
        yield chunk({"tool_calls": [{"index": 0, "function": {"arguments": text[i:i + 6]}}]})
    yield chunk({}, finish="tool_calls")


def answer(text, thought=None):
    yield chunk({"role": "assistant", "content": ""})
    if thought:
        yield chunk({"reasoning_content": thought})
    for i in range(0, len(text), 4):
        yield chunk({"content": text[i:i + 4]})
    yield chunk({}, finish="stop")


def text_of(msg):
    c = msg.get("content")
    if isinstance(c, str):
        return c
    if isinstance(c, list):
        return "".join(p.get("text", "") for p in c if isinstance(p, dict))
    return ""


def tool_name_for(messages, tool_call_id):
    for m in reversed(messages):
        for tc in m.get("tool_calls") or []:
            if tc.get("id") == tool_call_id:
                return (tc.get("function") or {}).get("name", "")
    return ""


def last_user_text(messages):
    for m in reversed(messages):
        if m.get("role") == "user":
            return text_of(m)
    return ""


def requested_steps(messages):
    """Steps asked for in the last user message ("改成 24"), default 20."""
    found = re.search(r"(\d{1,3})", last_user_text(messages))
    return int(found.group(1)) if found else 20


def pick(req):
    messages = req.get("messages") or []
    if not req.get("tools"):
        return answer("## 目标\n(mock 摘要)")
    last = messages[-1] if messages else {}
    role = last.get("role")
    if role == "tool":
        name = tool_name_for(messages, last.get("tool_call_id"))
        result = text_of(last)
        if name == "get_studio_parameters":
            steps = requested_steps(messages)
            return tool_call("update_studio_parameters",
                             {"steps": steps, "prompt": "1girl, solo, rainy street at night, umbrella"},
                             "call_write", thought=f"按要求把步数改成 {steps} 并换成雨夜场景。")
        if name == "update_studio_parameters":
            if "拒绝" in result:
                return answer("好的,这次不改了。需要的话告诉我要改成多少。")
            if "出图" in last_user_text(messages):
                return tool_call("novelai_generate", {}, "call_gen", thought="参数改好了,直接出图。")
            return answer("已按要求改好步数,提示词换成雨夜街头。要出图的话我可以调用 novelai_generate。")
        if name == "novelai_generate":
            if "拒绝" in result or "失败" in result:
                return answer(f"这次没有出图:{result[:120]}")
            return answer(f"出图完成。工具说:{result[:120]}")
        if name == "novelai_upscale":
            return answer(f"放大结果:{result[:120]}")
        if name == "novelai_account_info":
            return answer(f"账号情况:{result[:200]}")
        if name == "ask_user":
            return answer(f"收到,你选的是:{result[:80]}")
        if name == "view_canvas_image":
            return answer(f"看到了。工具说:{result[:160]}")
        if name == "add_character_prompt":
            return answer(f"角色加好了:{result[:100]}")
        return answer(f"工具 {name} 返回了:{result[:120]}")
    user_text = text_of(last)
    if "问我" in user_text:
        return tool_call("ask_user", {"questions": [{"question": "想要哪种画风?", "options": ["水彩", "赛璐璐", "厚涂"]}]},
                         "call_ask", thought="先确认画风偏好。")
    if "步数" in user_text:
        # 「全部」时读整份报表(含最终提示词与角色详情),否则只读两个键。
        keys = ["all"] if "全部" in user_text else ["steps", "resolution"]
        return tool_call("get_studio_parameters", {"keys": keys}, "call_read")
    if "回忆" in user_text:
        users = [text_of(m) for m in messages if m.get("role") == "user"]
        return answer(f"这轮请求里有 {len(users)} 条用户消息,第一条是「{users[0][:30]}」。", thought="数一下上下文。")
    if "加角色" in user_text:
        return tool_call("add_character_prompt", {"name": "Alice", "prompt": "1girl, red hair, smile", "position_x": 0.3, "position_y": 0.5}, "call_addchar", thought="加一个带坐标的角色。")
    if "看图" in user_text:
        return tool_call("view_canvas_image", {"index": 0}, "call_view", thought="先看一眼最新那张。")
    if "联想" in user_text:
        return tool_call("novelai_suggest_tags", {"query": "silver hair", "source": "dictionary"}, "call_suggest", thought="查一下规范拼法。")
    if "放大" in user_text:
        return tool_call("novelai_upscale", {"index": 0}, "call_upscale", thought="把最新那张放大一档。")
    if "账号" in user_text:
        return tool_call("novelai_account_info", {}, "call_account", thought="先看看余额。")
    if "出图" in user_text:
        return tool_call("novelai_generate", {}, "call_gen", thought="按当前参数直接出图。")
    return answer("(mock) 我在,说说你想怎么改。", thought="普通对话,不需要工具。")


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_POST(self):
        length = int(self.headers.get("content-length", "0"))
        req = json.loads(self.rfile.read(length) or b"{}")
        if req.get("stream") is False:
            # 非流式调用(标签翻译之类的旁路功能):回一个普通 completion,别拿 SSE 噎它。
            body = json.dumps({"id": "mock", "object": "chat.completion", "created": 0, "model": "mock-1",
                               "choices": [{"index": 0, "message": {"role": "assistant", "content": "(mock) 非流式请求"}, "finish_reason": "stop"}],
                               "usage": {"prompt_tokens": 10, "completion_tokens": 5}}, ensure_ascii=False).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        for part in pick(req):
            self.wfile.write(part)
            self.wfile.flush()
        usage = {"prompt_tokens": 120, "completion_tokens": 30, "prompt_tokens_details": {"cached_tokens": 60}}
        self.wfile.write(chunk({}, usage=usage, choices=False))
        self.wfile.write(b"data: [DONE]\n\n")
        self.wfile.flush()


if __name__ == "__main__":
    print(f"mock llm on http://127.0.0.1:{PORT}/v1", flush=True)
    ThreadingHTTPServer(("127.0.0.1", PORT), H).serve_forever()
