import type { Editor } from '@tiptap/core';
import type { CollapsibleTag, CollapsibleTagType } from './types';
import { docOffsetToTextIndex } from './documentMapping';

export function extractEditorContent(editor: Editor | null): { text: string; tags: CollapsibleTag[] } {
  if (!editor) return { text: '', tags: [] };

  const tags: CollapsibleTag[] = [];
  let text = '';

  editor.state.doc.descendants((node) => {
    if (node.type.name === 'collapsibleTag') {
      const { id, type, label, content, collapsed } = node.attrs;
      tags.push({ id, type, label, content, collapsed });
      text += `<<${type}:${label}:${content}>>`;
    } else if (node.isText) {
      text += node.text;
    } else if (node.type.name === 'hardBreak') {
      text += '\n';
    } else if (node.type.name === 'paragraph') {
      if (text) {
        text += '\n';
      }
    }
  });

  return { text: text.trim(), tags };
}

export function insertCollapsibleTag(editor: Editor | null, tag: Omit<CollapsibleTag, 'id'>) {
  if (!editor) return;

  const id = `tag-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  const { selection } = editor.state;
  const { $from } = selection;
  const textIndex = docOffsetToTextIndex($from.parent, $from.parentOffset);
  const textBefore = $from.parent.textContent.slice(0, textIndex);
  const needCommaBefore = textBefore.length > 0 && !textBefore.trimEnd().endsWith(',');
  const content: Array<{ type: string; text?: string; attrs?: Record<string, unknown> }> = [];

  if (needCommaBefore) {
    content.push({ type: 'text', text: ',' });
  }
  content.push({
    type: 'collapsibleTag',
    attrs: {
      id,
      type: tag.type,
      label: tag.label,
      content: tag.content,
      collapsed: tag.collapsed,
    },
  });
  content.push({ type: 'text', text: ',' });

  editor.chain().focus().insertContent(content).run();
}

export function removeCollapsibleTagsByType(editor: Editor | null, type: CollapsibleTagType) {
  if (!editor) return;

  const nodesToDelete: { pos: number; size: number }[] = [];
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name === 'collapsibleTag' && node.attrs.type === type) {
      nodesToDelete.push({ pos, size: node.nodeSize });
    }
  });

  if (nodesToDelete.length === 0) return;
  nodesToDelete.reverse();

  editor.chain().focus().command(({ tr }) => {
    nodesToDelete.forEach(({ pos, size }) => {
      let deleteFrom = pos;
      let deleteTo = pos + size;
      const beforePos = pos - 1;

      if (beforePos >= 0) {
        const $before = tr.doc.resolve(beforePos);
        const nodeBefore = $before.nodeBefore;
        if (nodeBefore?.isText && nodeBefore.text?.endsWith(',')) {
          deleteFrom = beforePos;
        }
      }

      const afterPos = pos + size;
      if (afterPos < tr.doc.content.size) {
        const $after = tr.doc.resolve(afterPos);
        const nodeAfter = $after.nodeAfter;
        if (nodeAfter?.isText && nodeAfter.text?.startsWith(',')) {
          deleteTo = afterPos + 1;
        }
      }

      tr.delete(deleteFrom, deleteTo);
    });
    return true;
  }).run();
}

export function setPlainTextSelection(editor: Editor | null, from: number, to: number) {
  if (!editor) return;

  let rawText = '';
  editor.state.doc.descendants((node) => {
    if (node.type.name === 'collapsibleTag') {
      rawText += node.attrs.content || '';
    } else if (node.isText && node.text) {
      rawText += node.text;
    } else if (node.type.name === 'paragraph' && rawText && !rawText.endsWith('\n')) {
      rawText += '\n';
    }
  });

  const leadingSpaces = rawText.length - rawText.trimStart().length;
  const adjustedFrom = from + leadingSpaces;
  const adjustedTo = to + leadingSpaces;
  let textOffset = 0;
  let editorFrom = 1;
  let editorTo = 1;
  let foundFrom = false;
  let foundTo = false;

  editor.state.doc.descendants((node, pos) => {
    if (foundFrom && foundTo) return false;

    if (node.type.name === 'collapsibleTag') {
      const contentLength = node.attrs.content?.length || 0;
      if (!foundFrom && textOffset + contentLength >= adjustedFrom) {
        editorFrom = pos;
        foundFrom = true;
      }
      if (!foundTo && textOffset + contentLength >= adjustedTo) {
        editorTo = pos + node.nodeSize;
        foundTo = true;
      }
      textOffset += contentLength;
    } else if (node.isText && node.text) {
      const nodeLength = node.text.length;
      if (!foundFrom && textOffset + nodeLength >= adjustedFrom) {
        editorFrom = pos + (adjustedFrom - textOffset);
        foundFrom = true;
      }
      if (!foundTo && textOffset + nodeLength >= adjustedTo) {
        editorTo = pos + (adjustedTo - textOffset);
        foundTo = true;
      }
      textOffset += nodeLength;
    } else if (node.type.name === 'paragraph' && textOffset > 0) {
      if (!foundFrom && textOffset + 1 >= adjustedFrom) {
        editorFrom = pos;
        foundFrom = true;
      }
      if (!foundTo && textOffset + 1 >= adjustedTo) {
        editorTo = pos;
        foundTo = true;
      }
      textOffset += 1;
    }
  });

  if (!foundFrom) editorFrom = editor.state.doc.content.size;
  if (!foundTo) editorTo = editor.state.doc.content.size;

  editor.chain().focus().setTextSelection({ from: editorFrom, to: editorTo }).run();
}

export function getEditorSelection(editor: Editor | null): { text: string; from: number; to: number } | null {
  if (!editor) return null;
  const { from, to } = editor.state.selection;
  if (from === to) return null;
  const text = editor.state.doc.textBetween(from, to, '\n');
  return { text, from, to };
}

export function replaceEditorSelection(editor: Editor | null, text: string) {
  if (!editor) return;
  const { from, to } = editor.state.selection;
  editor.chain().focus().command(({ tr }) => {
    tr.delete(from, to);
    tr.insertText(text, from);
    return true;
  }).run();
}
