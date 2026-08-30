"""
挂载 nai5-prompting skill —— 写 NovelAI V5 提示词的方法层。

为什么是「按需读」而不是整份塞进系统提示词:
  - 两份参考合起来约 100KB。planner 的分段装载注释里记着一条实测:
    单段控制在 ~1.5KB 时注意力分布均匀,拼成 ~5KB 时中段就会塌。
    100KB 塞进去等于把整份方法读成噪声,本地主模型的上下文也放不下。
  - skill 自己的用法就是按需读:需求模糊先读构思,落笔时读写法
    (见 SKILL.md)。所以这里把它做成**目录 + 按节取用**,
    让模型自己决定这一轮要哪几节。

内置的那几个 md 是上游原样拷贝,不要就地改(见 resources/skills/*/VENDOR.md)。
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

SKILL_NAME = "nai5-prompting"

#: 两份参考的短名 —— 模型按这个名字点节,别用文件名(带中文扩展名容易被截断)。
DOC_WRITING = "写法"
DOC_IDEATION = "构思"

_DOC_FILES = {
    DOC_WRITING: "references/通用写法.md",
    DOC_IDEATION: "references/通用构思.md",
}

_HEADING_RE = re.compile(r"^## +(.*?)\s*$", re.MULTILINE)
#: `## 3. 必须词组化的（…）` → 编号 3;没编号的节用标题本身当 id。
_NUMBERED_RE = re.compile(r"^(\d+)\.\s*(.+)$")


def skill_root() -> Path:
    return Path(__file__).resolve().with_name("resources") / "skills" / SKILL_NAME


@dataclass(frozen=True)
class SkillSection:
    doc: str
    """`写法` 或 `构思`。"""
    key: str
    """点这一节用的 id,例如 `写法/3` 或 `构思/先分档`。"""
    title: str
    text: str

    @property
    def size(self) -> int:
        return len(self.text)


def _split_sections(doc: str, text: str) -> list[SkillSection]:
    matches = list(_HEADING_RE.finditer(text))
    if not matches:
        return [SkillSection(doc=doc, key=f"{doc}/全文", title=doc, text=text)]

    sections: list[SkillSection] = []
    # 第一个 `##` 之前的开头部分也要留着 —— 写法那份的开篇讲的是语法与能力边界。
    preamble = text[: matches[0].start()].strip()
    if preamble:
        sections.append(SkillSection(doc=doc, key=f"{doc}/开篇", title="开篇", text=preamble))

    for index, match in enumerate(matches):
        end = matches[index + 1].start() if index + 1 < len(matches) else len(text)
        title = match.group(1).strip()
        numbered = _NUMBERED_RE.match(title)
        # 有编号就用编号(短、稳定);没有就用标题里第一个括号之前的部分
        ident = numbered.group(1) if numbered else title.split("（")[0].strip()
        sections.append(
            SkillSection(
                doc=doc,
                key=f"{doc}/{ident}",
                title=title,
                text=text[match.start() : end].strip(),
            )
        )
    return sections


@lru_cache(maxsize=1)
def load_sections() -> dict[str, SkillSection]:
    """全部小节,按 key 索引。文件缺失是**硬失败**,不静默降级成空 skill。"""
    root = skill_root()
    out: dict[str, SkillSection] = {}
    for doc, relative in _DOC_FILES.items():
        path = root / relative
        if not path.is_file():
            raise FileNotFoundError(
                f"nai5-prompting skill 缺文件: {path}. "
                "它是 agent 写 V5 提示词的方法层,缺了就只剩拼 tag —— "
                "不要造一个空实现绕过去。"
            )
        for section in _split_sections(doc, path.read_text(encoding="utf-8")):
            out[section.key] = section
    return out


@lru_cache(maxsize=1)
def load_mandate() -> str:
    """SKILL.md 里那段「四条铁律」。它短、且每轮都要在场,直接进系统提示词。"""
    path = skill_root() / "SKILL.md"
    if not path.is_file():
        raise FileNotFoundError(f"nai5-prompting skill 缺 SKILL.md: {path}")
    text = path.read_text(encoding="utf-8")
    # 去掉 Agent Skills 的 YAML frontmatter,那是给挂载方看的,不是给模型的
    if text.startswith("---"):
        end = text.find("\n---", 3)
        if end >= 0:
            text = text[end + 4 :]
    return text.strip()


@lru_cache(maxsize=1)
def load_index() -> str:
    """给系统提示词用的目录:每节一行 key + 标题 + 体量,让模型能自己挑。"""
    lines = [
        f"- `{section.key}` {section.title}（约 {section.size // 1000 or 1}k 字）"
        for section in load_sections().values()
    ]
    return "\n".join(lines)


def read_section(key: str) -> str | None:
    """取一节原文。key 不认识时返回 None,由调用方回一句可执行的说明。"""
    return (section := load_sections().get(key.strip())) and section.text
