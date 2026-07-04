import { mergeAttributes, Node as TiptapNode } from '@tiptap/core';
import type { Node } from '@tiptap/pm/model';
import { findSubtypeByTagType, getRegistrySnapshot } from '../tag-manager/registry';
import { getIconSvg } from '../tag-manager/iconSvgCache';

// The node view is built with innerHTML, so any value interpolated into markup must
// be HTML-escaped. label/content originate from tag and OC/CR data (some of it from
// the shared/public library), i.e. across a trust boundary.
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

interface ResolvedTagConfig {
  bg: string;
  border: string;
  hoverBg: string;
  iconSvg: string;
  name: string;
}

const LEGACY_TYPE_CONFIG: Record<string, { iconName: string; name: string }> = {
  artist: { iconName: 'Palette', name: '画师串' },
  codex: { iconName: 'BookOpen', name: '法典' },
  oc: { iconName: 'User', name: 'OC 典' },
};

const UNIFIED_BG = 'bg-nai-accent/25';
const UNIFIED_BORDER = 'border-nai-accent/60';
const UNIFIED_HOVER = 'hover:bg-nai-accent/35';

function resolveTagConfig(type: string): ResolvedTagConfig {
  const subtype = findSubtypeByTagType(getRegistrySnapshot(), type);
  if (subtype) {
    return {
      bg: UNIFIED_BG,
      border: UNIFIED_BORDER,
      hoverBg: UNIFIED_HOVER,
      iconSvg: getIconSvg(subtype.iconName, 13),
      name: subtype.label,
    };
  }
  const legacy = LEGACY_TYPE_CONFIG[type] || LEGACY_TYPE_CONFIG.artist;
  return {
    bg: UNIFIED_BG,
    border: UNIFIED_BORDER,
    hoverBg: UNIFIED_HOVER,
    iconSvg: getIconSvg(legacy.iconName, 13),
    name: legacy.name,
  };
}

export const CollapsibleTagNode = TiptapNode.create({
  name: 'collapsibleTag',
  group: 'inline',
  inline: true,
  atom: true,
  draggable: true,

  addAttributes() {
    return {
      id: { default: '' },
      type: { default: 'artist' },
      label: { default: '' },
      content: { default: '' },
      collapsed: { default: true },
    };
  },

  parseHTML() {
    return [{ tag: 'span[data-collapsible-tag]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['span', mergeAttributes(HTMLAttributes, { 'data-collapsible-tag': '' })];
  },

  addNodeView() {
    return ({ node, getPos, editor }) => {
      const dom = document.createElement('span');
      dom.className = 'collapsible-tag-wrapper';
      dom.style.display = 'inline-block';
      dom.style.verticalAlign = 'middle';
      dom.style.transform = 'translateY(-1px)';
      dom.style.marginLeft = '0.1px';
      dom.style.marginRight = '0.1px';

      const updateView = () => {
        const { type, label, content } = node.attrs;
        const config = resolveTagConfig(type);
        const preview = content.length > 80 ? content.substring(0, 80) + '...' : content;

        dom.innerHTML = `
          <span class="inline-flex items-center gap-1.5 px-2 rounded-md ${config.bg} border ${config.border} text-sm select-none cursor-grab active:cursor-grabbing ${config.hoverBg} transition-colors" style="line-height: 16px; padding-top: 1px; padding-bottom: 1px;" title="${escapeHtml(preview)}">
            <span data-action="expand" class="inline-flex items-center gap-1.5 cursor-pointer">
              <span class="inline-flex items-center text-white/90" style="line-height:0">${config.iconSvg}</span>
              <span class="font-medium text-white/90">${escapeHtml(label || config.name)}</span>
            </span>
            <span data-action="delete" class="text-white/40 hover:text-red-400 transition-colors cursor-pointer" title="删除">✕</span>
          </span>
        `;
      };

      updateView();

      const expandToText = () => {
        const pos = typeof getPos === 'function' ? getPos() : null;
        if (pos !== null && pos !== undefined) {
          const { content } = node.attrs;
          editor.chain().focus().command(({ tr }) => {
            tr.delete(pos, pos + node.nodeSize);
            tr.insertText(content, pos);
            return true;
          }).run();
        }
      };

      const deleteTag = () => {
        const pos = typeof getPos === 'function' ? getPos() : null;
        if (pos !== null && pos !== undefined) {
          editor.chain().focus().command(({ tr }) => {
            tr.delete(pos, pos + node.nodeSize);
            return true;
          }).run();
        }
      };

      const handleClick = (e: MouseEvent) => {
        const target = e.target as HTMLElement;
        const action = target.closest('[data-action]')?.getAttribute('data-action');

        if (action === 'delete') {
          deleteTag();
        } else if (action === 'expand') {
          expandToText();
        }
      };

      dom.addEventListener('click', handleClick);

      return {
        dom,
        update: (updatedNode: Node) => {
          if (updatedNode.type.name !== 'collapsibleTag') return false;
          Object.assign(node.attrs, updatedNode.attrs);
          updateView();
          return true;
        },
        destroy: () => {
          dom.removeEventListener('click', handleClick);
        },
      };
    };
  },
});
