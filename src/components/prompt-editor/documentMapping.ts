import type { Node } from '@tiptap/pm/model';

export function docOffsetToTextIndex(parent: Node, docOffset: number): number {
  let textIdx = 0;
  let pos = 0;
  for (let i = 0; i < parent.childCount; i++) {
    const child = parent.child(i);
    if (pos + child.nodeSize > docOffset) {
      if (child.isText) {
        textIdx += docOffset - pos;
      }
      return textIdx;
    }
    pos += child.nodeSize;
    textIdx += child.isText ? child.text!.length : 0;
  }
  return textIdx;
}

export function textIndexToDocOffset(parent: Node, textIndex: number): number {
  let docPos = 0;
  let textPos = 0;
  for (let i = 0; i < parent.childCount; i++) {
    const child = parent.child(i);
    const textLen = child.isText ? child.text!.length : 0;
    if (textPos + textLen > textIndex) {
      if (child.isText) {
        docPos += textIndex - textPos;
      }
      return docPos;
    }
    textPos += textLen;
    docPos += child.nodeSize;
  }
  return docPos;
}

const COLLAPSIBLE_MARKER_RE = /<<([\w-]+):([^:]+):((?:.|\n)*?)>>/g;

export function parseValueToDocContent(value: string): object {
  const text = value || '';
  const regex = new RegExp(COLLAPSIBLE_MARKER_RE.source, 'g');
  type Token =
    | { kind: 'text'; text: string }
    | { kind: 'tag'; type: string; label: string; content: string };
  const tokens: Token[] = [];
  let lastIndex = 0;
  let match;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      tokens.push({ kind: 'text', text: text.slice(lastIndex, match.index) });
    }
    tokens.push({ kind: 'tag', type: match[1], label: match[2], content: match[3] });
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) {
    tokens.push({ kind: 'text', text: text.slice(lastIndex) });
  }

  const paragraphs: object[] = [];
  let cur: object[] = [];
  const flush = () => {
    paragraphs.push(cur.length > 0 ? { type: 'paragraph', content: cur } : { type: 'paragraph' });
    cur = [];
  };

  for (const tk of tokens) {
    if (tk.kind === 'tag') {
      cur.push({
        type: 'collapsibleTag',
        attrs: {
          id: `tag-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
          type: tk.type,
          label: tk.label,
          content: tk.content,
          collapsed: true,
        },
      });
    } else {
      const parts = tk.text.split('\n');
      parts.forEach((p, i) => {
        if (i > 0) flush();
        if (p) cur.push({ type: 'text', text: p });
      });
    }
  }

  flush();

  return { type: 'doc', content: paragraphs };
}
