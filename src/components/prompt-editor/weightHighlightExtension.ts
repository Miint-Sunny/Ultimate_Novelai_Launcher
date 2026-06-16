import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

const getWeightDecoStyle = (weight: number): string => {
  if (weight >= 1) {
    const intensity = Math.min(1, (weight - 1) / 1.5);
    const alpha = 0.15 + intensity * 0.50;
    return `background-color: rgba(116, 39, 13, ${alpha.toFixed(2)});`;
  } else if (weight >= 0) {
    const intensity = Math.min(1, (1 - weight) / 0.7);
    const alpha = 0.10 + intensity * 0.40;
    return `background-color: rgba(59, 130, 246, ${alpha.toFixed(2)});`;
  } else {
    const intensity = Math.min(1, Math.abs(weight) / 1.5);
    const alpha = 0.15 + intensity * 0.45;
    return `background-color: rgba(59, 130, 246, ${alpha.toFixed(2)});`;
  }
};

export const WeightHighlightExtension = Extension.create({
  name: 'weightHighlight',

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey('weightHighlight'),
        props: {
          decorations(state) {
            const decorations: Decoration[] = [];
            const doc = state.doc;

            let fullText = '';
            const segments: { from: number; to: number; start: number }[] = [];
            doc.descendants((node, pos) => {
              if (node.isText && node.text) {
                segments.push({ from: pos, to: pos + node.nodeSize, start: fullText.length });
                fullText += node.text;
              } else if (node.type.name === 'paragraph' || node.type.name === 'hardBreak') {
                if (fullText.length > 0 && !fullText.endsWith('\n')) {
                  fullText += '\n';
                }
              }
            });

            const addDeco = (fromOff: number, toOff: number, style: string) => {
              for (const seg of segments) {
                const segEnd = seg.start + (seg.to - seg.from);
                if (toOff <= seg.start) break;
                if (fromOff >= segEnd) continue;
                const clampFrom = Math.max(fromOff, seg.start);
                const clampTo = Math.min(toOff, segEnd);
                if (clampFrom < clampTo) {
                  decorations.push(
                    Decoration.inline(
                      seg.from + (clampFrom - seg.start),
                      seg.from + (clampTo - seg.start),
                      { style },
                    ),
                  );
                }
              }
            };

            const braceRegex = /(\{+[^{}]+\}+)|(\[+[^\[\]]+\]+)/g;
            let match;
            while ((match = braceRegex.exec(fullText)) !== null) {
              if (match[1]) {
                const level = (match[1].match(/^\{+/) || [''])[0].length;
                const weight = Math.pow(1.05, level);
                addDeco(match.index, match.index + match[0].length, getWeightDecoStyle(weight));
              } else if (match[2]) {
                const level = (match[2].match(/^\[+/) || [''])[0].length;
                const weight = Math.pow(0.95, level);
                addDeco(match.index, match.index + match[0].length, getWeightDecoStyle(weight));
              }
            }

            const numPrefixRe = /-?\d+(?:\.\d+)?::/g;
            let pm;
            const prefixes: { idx: number; len: number; weight: number }[] = [];
            while ((pm = numPrefixRe.exec(fullText)) !== null) {
              prefixes.push({ idx: pm.index, len: pm[0].length, weight: parseFloat(pm[0]) });
            }
            for (let i = 0; i < prefixes.length; i++) {
              const { idx: pIdx, len: pLen, weight } = prefixes[i];
              const contentStart = pIdx + pLen;
              const nextPrefixStart = i + 1 < prefixes.length ? prefixes[i + 1].idx : fullText.length;
              let groupEnd = nextPrefixStart;
              const closeIdx = fullText.indexOf('::', contentStart);
              if (closeIdx !== -1 && closeIdx + 2 <= nextPrefixStart) {
                groupEnd = closeIdx + 2;
              }
              addDeco(pIdx, groupEnd, getWeightDecoStyle(weight));
            }

            const tags = fullText.split(/[,，]/);
            let tagOffset = 0;
            for (const tag of tags) {
              const trimmed = tag.trim();
              if (trimmed.startsWith('~') && trimmed.length > 1) {
                const tildePos = tagOffset + tag.indexOf('~');
                const tagEnd = tagOffset + tag.length;
                addDeco(tildePos, tagEnd, 'opacity: 0.25; text-decoration: line-through; text-decoration-color: rgba(255,255,255,0.4)');
              }
              tagOffset += tag.length + 1;
            }

            return DecorationSet.create(doc, decorations);
          },
        },
      }),
    ];
  },
});
