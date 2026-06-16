"""
知识库 tools 注册器。

这些 @agent.tool 装饰函数直接调用本机 server 的 /api/cr /api/oc /api/artists /api/vibes /api/tags
路由，本模块只做"OpenAI tool schema → 内部 API"的薄壳。

所有 tools 都通过 RunContext[AgentDeps] 拿到:
    - http_client     - 共享连接池
    - internal_base_url - 本机 server 地址
    - session_id      - 透传给授权 endpoint

注册方式:
    from .tools import register_knowledge_tools
    register_knowledge_tools(chat_agent)
"""
from __future__ import annotations

import json
import random
from pathlib import Path
from typing import Optional

from ..llm import Agent, RunContext

from ..deps import AgentDeps
from ..schemas import Character, Artist, DanbooruTag, SseEvent


# search_danbooru 给前 N 热门结果查 wiki 摘要（节省请求）
_DANBOORU_WIKI_ENRICH_TOP_N = 3

# Danbooru autocomplete category 数字 → 字符串
_DANBOORU_CATEGORY_MAP = {
    0: "general",
    1: "artist",
    3: "copyright",
    4: "character",
    5: "meta",
}


def _internal_get(deps: AgentDeps, path: str, params: Optional[dict] = None):
    """便捷封装：拼 URL + 带 session_id"""
    url = f"{deps.internal_base_url.rstrip('/')}{path}"
    final_params = dict(params or {})
    if deps.session_id and "session_id" not in final_params:
        final_params["session_id"] = deps.session_id
    return deps.http_client.get(url, params=final_params)


def _internal_post(deps: AgentDeps, path: str, json: Optional[dict] = None):
    url = f"{deps.internal_base_url.rstrip('/')}{path}"
    return deps.http_client.post(url, json=json or {})


# ============================================================
# 本地库直读（绕开 Bot 授权）
# ============================================================
# artist / OC 这类「公共库」的 HTTP 接口（/api/artists/list、/api/oc/list）要求
# Bot 授权 session_id；而 agent 内部调用拿不到 session → 必被 403 拦成空库。
# 这些数据就在本机 data 目录，agent 与 server 同进程，直接读文件即可。
def _bot_data_dir() -> Path:
    """本地库目录。优先 server config 的 BOT_DATA_DIR（响应环境变量），兜底按文件位置上推。"""
    try:
        from config import BOT_DATA_DIR  # type: ignore
        return Path(BOT_DATA_DIR)
    except Exception:
        return Path(__file__).resolve().parents[4] / "data"


def _read_local_json(path: Path):
    try:
        if path.exists():
            return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        pass
    return None


def _load_artists_local() -> list[dict]:
    """读 artist_strings.json，返回与 /api/artists/list 一致的 artists 结构。"""
    raw = _read_local_json(_bot_data_dir() / "artist_strings.json")
    if not isinstance(raw, dict):
        return []
    out: list[dict] = []
    for name, record in raw.items():
        if not isinstance(record, dict):
            continue
        out.append({
            "id": name,
            "name": name,
            "artist_string": record.get("artist_string", ""),
            "created_time_str": record.get("created_time_str", ""),
        })
    out.sort(key=lambda x: x["name"])
    return out


def _load_artists_from_web(deps: AgentDeps) -> list[dict]:
    """把 Web 前端传来的画师串上下文规范化为工具内部结构。"""
    out: list[dict] = []
    for item in deps.web_artists or []:
        if not isinstance(item, dict):
            continue
        artist_id = str(item.get("id") or item.get("name") or "").strip()
        name = str(item.get("name") or artist_id).strip()
        prompt = str(item.get("prompt") or item.get("artist_string") or "").strip()
        if not (artist_id or name) or not prompt:
            continue
        out.append({
            "id": artist_id or name,
            "name": name or artist_id,
            "artist_string": prompt,
            "created_time_str": str(item.get("description") or item.get("createdTimeStr") or "web"),
        })
    return out


def _dedupe_artists(items: list[dict]) -> list[dict]:
    seen: set[str] = set()
    out: list[dict] = []
    for item in items:
        key = (
            str(item.get("id") or "").upper(),
            str(item.get("name") or "").upper(),
            str(item.get("artist_string") or ""),
        )
        marker = "|".join(key)
        if marker in seen:
            continue
        seen.add(marker)
        out.append(item)
    return out


def _load_artists_for_deps(deps: AgentDeps) -> list[dict]:
    """Web 端优先使用浏览器传来的资料；Bot/兜底继续读服务端本地库。"""
    return _dedupe_artists(_load_artists_from_web(deps) + _load_artists_local())


def _load_ocs_local() -> list[dict]:
    """读 oc_data.json，返回与 /api/oc/list 一致的 ocs 结构（仅取工具用到的字段）。"""
    raw = _read_local_json(_bot_data_dir() / "oc_data.json")
    if not isinstance(raw, dict):
        return []
    out: list[dict] = []
    for en_name, data in raw.items():
        if not isinstance(data, dict):
            continue
        out.append({
            "en_name": en_name,
            "zh_name": data.get("zh_name"),
            "zh_aliases": data.get("zh_aliases") or [],
            "tag_group": data.get("tag_group"),
        })
    return out


def _load_ocs_from_web(deps: AgentDeps) -> list[dict]:
    """把 Web 前端传来的 OC 上下文规范化为 /api/oc/list 近似结构。"""
    out: list[dict] = []
    for item in deps.web_ocs or []:
        if not isinstance(item, dict):
            continue
        name = str(item.get("name") or item.get("zh_name") or item.get("id") or "").strip()
        en_name = str(item.get("en_name") or item.get("id") or name).strip()
        zh_name = str(item.get("zh_name") or item.get("zhName") or name).strip()
        tag_group = str(item.get("tag_group") or item.get("positive") or "").strip()
        if not (name or en_name or zh_name) or not tag_group:
            continue
        aliases_raw = item.get("zh_aliases") or item.get("aliases") or []
        aliases = [str(a) for a in aliases_raw if str(a).strip()] if isinstance(aliases_raw, list) else []
        out.append({
            "en_name": en_name or name,
            "zh_name": zh_name or name,
            "zh_aliases": aliases,
            "tag_group": tag_group,
        })
    return out


def _dedupe_ocs(items: list[dict]) -> list[dict]:
    seen: set[str] = set()
    out: list[dict] = []
    for item in items:
        marker = "|".join([
            str(item.get("en_name") or "").lower(),
            str(item.get("zh_name") or ""),
            str(item.get("tag_group") or ""),
        ])
        if marker in seen:
            continue
        seen.add(marker)
        out.append(item)
    return out


def _load_ocs_for_deps(deps: AgentDeps) -> list[dict]:
    """Web 端优先使用浏览器传来的 OC；Bot/兜底继续读服务端本地库。"""
    return _dedupe_ocs(_load_ocs_from_web(deps) + _load_ocs_local())


# ============================================================
# role_tag_mapping.json 缓存
# ============================================================
# 通用角色（含中英文映射 + origin）来自 data/role_tag_mapping.json，无需鉴权。
# 每次工具调用都拉全量太重，缓存 5 分钟。
_ROLE_MAPPING_CACHE: Optional[dict] = None
_ROLE_MAPPING_CACHE_AT: float = 0.0
_ROLE_MAPPING_TTL = 300.0


async def _get_role_mapping(deps: AgentDeps) -> dict:
    """获取通用角色映射库（中英文 + origin）。带 5 分钟 TTL 缓存。"""
    import time
    global _ROLE_MAPPING_CACHE, _ROLE_MAPPING_CACHE_AT
    now = time.time()
    if _ROLE_MAPPING_CACHE is not None and now - _ROLE_MAPPING_CACHE_AT < _ROLE_MAPPING_TTL:
        return _ROLE_MAPPING_CACHE
    try:
        resp = await _internal_get(deps, "/api/data/role_tag_mapping.json")
        if resp.status_code == 200:
            data = resp.json()
            if isinstance(data, dict):
                _ROLE_MAPPING_CACHE = data
                _ROLE_MAPPING_CACHE_AT = now
                return data
    except Exception:
        pass
    return _ROLE_MAPPING_CACHE or {}


async def _emit_tool_call(ctx: RunContext[AgentDeps], name: str, args: dict) -> None:
    await ctx.deps.emit(SseEvent(event="tool_call", data={"name": name, "arguments": args}))


async def _emit_tool_result(ctx: RunContext[AgentDeps], name: str, result_summary: str) -> None:
    await ctx.deps.emit(SseEvent(event="tool_result", data={"name": name, "summary": result_summary}))


def register_knowledge_tools(agent: Agent[AgentDeps, ...]) -> None:
    """把知识库相关工具集挂到 agent 上"""

    @agent.tool(strict=True)
    async def search_character(
        ctx: RunContext[AgentDeps],
        query: Optional[str] = None,
        origin: Optional[str] = None,
        limit: int = 30,
    ) -> list[Character]:
        """
        查角色 —— **同时查 OC 库 + 通用角色库**。query / origin 至少传一个。

        三种用法：
          1. **按名字查**: query="芙兰朵露"（origin 不传）
             → OC 库 + 通用库都按名字搜，通常返回少量精确匹配
          2. **按出处查**: origin="东方"（query 不传）
             → 只查通用库，返回该出处下的所有角色（OC 库无出处概念，跳过）
             → **想看全可以把 limit 调大到 50 / 100**（例如用户说"列出所有 touhou 角色让我挑"）
          3. **名字 + 出处筛选**: query="爱丽丝", origin="东方"
             → OC 按名字；通用库在指定出处内按名字搜（消除重名歧义）

        返回的 `source` 字段决定 tag 用法：
          source = "oc"       → OC 角色：用 tags 字段（完整 tag 组，含外貌服装）
          source = "roleTag"  → 通用角色：直接用 name 字段作 tag；**禁止追加发色/瞳色等外貌 tag**
                                例外：用户明确要换装 / cos 时才加额外服装 tag

        Args:
            query:  角色名称（中文或英文），如 "芙兰朵露" / "flandre" / "flandre_scarlet"
            origin: 出处（中文或英文），如 "东方" / "touhou" / "fate" / "原神"
            limit:  返回结果上限，默认 30。按出处查时如果用户想"看全"可以传 50-100。
                    OC 优先填充，剩余空间给 roleTag。

        Returns:
            匹配列表。OC 优先排前；总数截断到 limit。两参数都空时返回 []。
        """
        await _emit_tool_call(
            ctx, "search_character",
            {"query": query, "origin": origin, "limit": limit},
        )

        q_lower = (query or "").lower().strip()
        origin_lower = (origin or "").lower().strip()
        has_query = bool(q_lower)
        has_origin = bool(origin_lower)
        limit = max(1, min(int(limit or 30), 200))  # 1-200 之间，防止 LLM 传非法值

        if not has_query and not has_origin:
            await _emit_tool_result(ctx, "search_character", "query / origin 都为空，跳过")
            return []

        oc_results: list[Character] = []
        role_results: list[Character] = []

        # ===== 1. 查 OC 库（仅当 has_query 时；OC 没有出处概念）=====
        if has_query:
            try:
                oc_list = _load_ocs_for_deps(ctx.deps)
                if oc_list:
                    for oc in oc_list:
                        en = (oc.get("en_name") or "").lower()
                        zh = oc.get("zh_name") or ""
                        aliases = [str(a) for a in (oc.get("zh_aliases") or [])]
                        hit = (
                            (q_lower in en)
                            or (zh and query and query in zh)
                            or any(query and query in a for a in aliases)
                        )
                        if not hit:
                            continue
                        oc_results.append(Character(
                            name=oc.get("en_name") or "",
                            zh_aliases=([zh] if zh else []) + aliases,
                            tags=oc.get("tag_group") or "",
                            source="oc",
                        ))
            except Exception:
                pass  # OC 库读取失败

        # ===== 2. 查通用角色库（role_tag_mapping.json）=====
        mapping = await _get_role_mapping(ctx.deps)
        if mapping:
            for name, data in mapping.items():
                if not isinstance(data, dict):
                    continue
                role_en = str(data.get("role_en") or "")
                role_zh = data.get("role_zh") or []
                if not isinstance(role_zh, list):
                    role_zh = []
                origin_en = str(data.get("origin_en") or "")
                origin_zh = data.get("origin_zh") or []
                if not isinstance(origin_zh, list):
                    origin_zh = []

                # origin 筛选
                if has_origin:
                    origin_hit = (
                        (origin_en and origin_lower in origin_en.lower())
                        or any(origin in str(z) for z in origin_zh)
                    )
                    if not origin_hit:
                        continue

                # 角色名匹配（仅当 has_query 时；只有 origin 时不做名字过滤）
                if has_query:
                    name_hit = (
                        q_lower in name.lower()
                        or (role_en and q_lower in role_en.lower())
                        or any(query == str(z) for z in role_zh)
                        or any(q_lower in str(z).lower() for z in role_zh)
                    )
                    if not name_hit:
                        continue

                role_results.append(Character(
                    name=role_en or name,
                    zh_aliases=[str(z) for z in role_zh],
                    origin_en=origin_en or None,
                    origin_zh=[str(z) for z in origin_zh],
                    tags=role_en or name,
                    source="roleTag",
                ))
                # 按 limit 收尾：留出 OC 已占的位置，role 最多再填这么多
                if len(role_results) >= max(limit - len(oc_results), 1):
                    break

        # OC 优先排前面（用户自定义，匹配更精准）；总数限制 = limit
        results = oc_results + role_results
        truncated_flag = len(results) > limit
        if truncated_flag:
            results = results[:limit]

        oc_n = len(oc_results)
        role_n = len(role_results)
        truncated = f" (截断至前 {limit})" if truncated_flag else ""
        await _emit_tool_result(
            ctx, "search_character",
            f"OC {oc_n} 个 + 通用 {role_n} 个 = {len(results)} 个{truncated}"
        )
        return results

    @agent.tool(strict=True)
    async def search_artist(
        ctx: RunContext[AgentDeps],
        artist_ids: Optional[list[str]] = None,
        keyword: Optional[str] = None,
    ) -> list[Artist]:
        """
        搜索画师串。两种用法二选一：
            1) 按编号列表查找（如 ["A1", "B2"]）
            2) 按关键词搜索（如 "ciloranko"）

        Args:
            artist_ids: 画师串编号列表
            keyword: 关键词

        Returns:
            匹配的画师串列表，prompt 字段是可直接使用的完整 tag 串。
            使用方法：把 prompt 字段的 tag 串原样放入 draw_specs[*].positive 靠前位置。
            不要输出 Web 前端芯片包装语法（例如 <<artist:画师名:tag串>>）；Web 端需要折叠时会在返回前自动包装。
        """
        await _emit_tool_call(ctx, "search_artist", {"artist_ids": artist_ids, "keyword": keyword})
        all_artists = _load_artists_for_deps(ctx.deps)
        out: list[Artist] = []

        if artist_ids:
            id_set = {i.strip().upper() for i in artist_ids if i}
            for a in all_artists:
                if str(a.get("id", "")).upper() in id_set or str(a.get("name", "")).upper() in id_set:
                    out.append(Artist(
                        id=str(a.get("id", "")),
                        name=str(a.get("name", "")),
                        prompt=str(a.get("artist_string", "")),
                        description=str(a.get("created_time_str") or ""),
                    ))
        elif keyword:
            k = keyword.lower().strip()
            for a in all_artists:
                hay = (
                    str(a.get("name", "")) + " "
                    + str(a.get("artist_string", ""))
                ).lower()
                if k in hay:
                    out.append(Artist(
                        id=str(a.get("id", "")),
                        name=str(a.get("name", "")),
                        prompt=str(a.get("artist_string", "")),
                    ))
        await _emit_tool_result(ctx, "search_artist", f"匹配 {len(out)} 个画师串")
        return out

    @agent.tool(strict=True)
    async def random_artist(ctx: RunContext[AgentDeps], count: int = 1) -> list[Artist]:
        """
        随机抽取画师串。用于用户明确表示"抽卡"、"随便画"或不指定画师时。

        Args:
            count: 抽取数量（1-5）

        Returns:
            随机抽取的画师串列表。把 prompt 字段的 tag 串原样放入 draw_specs[*].positive，
            不要输出 Web 前端芯片包装语法；Web 端需要折叠时会在返回前自动包装。
        """
        count = max(1, min(int(count or 1), 5))
        await _emit_tool_call(ctx, "random_artist", {"count": count})
        all_artists = _load_artists_for_deps(ctx.deps)
        if not all_artists:
            return []
        picked = random.sample(all_artists, k=min(count, len(all_artists)))
        out = [
            Artist(
                id=str(a.get("id", "")),
                name=str(a.get("name", "")),
                prompt=str(a.get("artist_string", "")),
            )
            for a in picked
        ]
        await _emit_tool_result(ctx, "random_artist", f"随机抽取 {len(out)} 个画师串")
        return out

    @agent.tool(strict=True)
    async def search_danbooru(
        ctx: RunContext[AgentDeps],
        query: str,
        category: Optional[str] = None,
        limit: int = 10,
    ) -> list[DanbooruTag]:
        """
        **【咨询专用】联网查 Danbooru，给热门结果附带中文 wiki 摘要。**

        ⚠️ **唯一触发场景：用户在咨询 / 问询某个名字或 tag 是什么**。
        例如：
          - "ciloranko 是谁 / 这画师啥风格 / 介绍一下 X 画师"
          - "X 这个 tag 是啥意思 / 怎么用"
          - "Y 角色是什么作品的 / 这角色的背景"

        **禁止使用的场景：**
          - 绘图流程里 search_character / search_artist 没命中 → 跳过 Danbooru，直接按用户原话和已有资料产出 draw_specs
          - 替用户"先了解了解"再画 → 用户没主动问就别查
          - 绘图时去"查证"常见 tag → 自己会写就直接写
          - 任何与"用户在画图"挂钩的场景 → 一律不调

        判断标准：用户语气是"问 / 想知道"才调；是"画 / 来一张 / 加 / 改"则跳过。

        返回内容：按 post_count 降序的匹配列表。前 3 条最热的会自动带 wiki_summary_zh
        中文摘要（约 120 字），直接用这段摘要转述给用户即可。

        Args:
            query: 名字 / tag 关键词（≥ 2 字符）
            category: 可选过滤 "character" / "artist" / "copyright" / "general" / "meta"
            limit: autocomplete 返回上限（默认 10，上限 20）

        Returns:
            list[DanbooruTag]，每条含 name / category / post_count；前 3 条额外含 wiki_summary_zh。
        """
        await _emit_tool_call(
            ctx, "search_danbooru",
            {"query": query, "category": category, "limit": limit},
        )

        q = (query or "").strip()
        if len(q) < 2:
            await _emit_tool_result(ctx, "search_danbooru", "query 太短（< 2 字符）")
            return []

        limit = max(1, min(int(limit or 10), 20))

        # ===== 1. autocomplete 主查询 =====
        try:
            resp = await _internal_get(
                ctx.deps, "/api/tags/autocomplete",
                params={"query": q, "limit": limit},
            )
            items = resp.json() if resp.status_code == 200 else []
        except Exception as e:
            await _emit_tool_result(ctx, "search_danbooru", f"autocomplete 失败: {e}")
            return []

        out: list[DanbooruTag] = []
        for it in items or []:
            if not isinstance(it, dict):
                continue
            name = str(it.get("value") or it.get("label") or "").strip()
            if not name:
                continue
            cat_num = it.get("category")
            cat_str = _DANBOORU_CATEGORY_MAP.get(cat_num, "unknown")
            if category and cat_str != category.lower().strip():
                continue
            out.append(DanbooruTag(
                name=name,
                category=cat_str,  # type: ignore[arg-type]
                post_count=int(it.get("post_count") or 0),
            ))

        # 按 post_count 降序
        out.sort(key=lambda x: x.post_count, reverse=True)

        # ===== 2. 给前 N 热门结果并行拉 wiki 中文摘要 =====
        import asyncio

        async def _fetch_summary(tag_name: str) -> str:
            try:
                r = await _internal_get(
                    ctx.deps, "/api/tags/wiki-preview-summary-zh",
                    params={"tag": tag_name},
                )
                if r.status_code == 200:
                    data = r.json() or {}
                    if data.get("hasWiki"):
                        return str(data.get("summaryZh") or "")
            except Exception:
                pass
            return ""

        top = out[:_DANBOORU_WIKI_ENRICH_TOP_N]
        if top:
            summaries = await asyncio.gather(
                *[_fetch_summary(t.name) for t in top],
                return_exceptions=False,
            )
            for tag, summary in zip(top, summaries):
                summary = (summary or "").strip()
                if summary:
                    tag.has_wiki = True
                    tag.wiki_summary_zh = summary

        # ===== 3. 汇总 =====
        wiki_hits = sum(1 for t in out if t.has_wiki)
        by_cat: dict[str, int] = {}
        for t in out:
            by_cat[t.category] = by_cat.get(t.category, 0) + 1
        cat_summary = ", ".join(f"{k}:{v}" for k, v in by_cat.items()) or "0"
        await _emit_tool_result(
            ctx, "search_danbooru",
            f"匹配 {len(out)} 条 ({cat_summary}), wiki 摘要附带 {wiki_hits} 条",
        )
        return out

