import type { MutableRefObject, MouseEvent } from 'react';
import { ArrowDown, ArrowUp, Ban, ChevronDown, MapPin, Plus, Power, Sparkles, Trash2, User, X } from 'lucide-react';
import PromptEditor from '../PromptEditor';
import { DesktopChipEditor } from '../DesktopChipEditor';
import { countTokens } from '../../services/tokenizer';
import { usePromptChunkLibrary } from '../../hooks/usePromptChunkLibrary';
import { expandPromptChunksForSend } from '../../services/promptChunkMacros';
import type { CharacterPrompt } from './types';
import { placedCenter } from '../../services/characterPosition';

type CharacterPromptField = 'positive' | 'negative' | 'activeTab' | 'enabled' | 'position' | 'center';

interface CharacterPromptsSectionProps {
  characterPrompts: CharacterPrompt[];
  /** 官方位置区块的全局二选一:false = AI's Choice(坐标照发但模型不理会),true = Custom。 */
  useCoords: boolean;
  onSetUseCoords: (useCoords: boolean) => void;
  /** 当前模型的同框角色上限(V4 系 6,V5 为 32)。 */
  maxCharacters: number;
  isCharacterSectionOpen: boolean;
  setIsCharacterSectionOpen: (open: boolean) => void;
  isClearConfirming: boolean;
  clearAllCharacterPrompts: () => void;
  addCharacterPrompt: () => void;
  removeCharacterPrompt: (id: string) => void;
  updateCharacterPrompt: <K extends CharacterPromptField>(
    id: string,
    field: K,
    value: CharacterPrompt[K],
  ) => void;
  moveCharacterPrompt: (index: number, direction: -1 | 1) => void;
  setEditingPositionId: (id: string) => void;
  chipMode: boolean;
  charHeights: Record<string, number>;
  isDraggingChar: MutableRefObject<string | null>;
  handleCharMouseDown: (event: MouseEvent, charId: string) => void;
  handleCharContentHeightChange: (charId: string, contentHeight: number) => void;
}

export function CharacterPromptsSection({
  characterPrompts,
  useCoords,
  onSetUseCoords,
  maxCharacters,
  isCharacterSectionOpen,
  setIsCharacterSectionOpen,
  isClearConfirming,
  clearAllCharacterPrompts,
  addCharacterPrompt,
  removeCharacterPrompt,
  updateCharacterPrompt,
  moveCharacterPrompt,
  setEditingPositionId,
  chipMode,
  charHeights,
  isDraggingChar,
  handleCharMouseDown,
  handleCharContentHeightChange,
}: CharacterPromptsSectionProps) {
  return (
    <div>
      <div
        className="flex items-center justify-between mb-2 cursor-pointer select-none group"
        onClick={() => setIsCharacterSectionOpen(!isCharacterSectionOpen)}
      >
        <div className="flex items-center gap-2">
          {characterPrompts.length > 0 && (
            <ChevronDown className={`w-4 h-4 text-gray-400 transition-transform duration-200 ${isCharacterSectionOpen ? 'rotate-0' : '-rotate-90'}`} />
          )}
          <div>
            <div className="text-sm font-medium text-gray-300 group-hover:text-white transition-colors">Character Prompts</div>
            <div className="text-xs text-gray-500">为角色设置独立提示词</div>
          </div>
        </div>
        <div className="flex items-center gap-1">
          {characterPrompts.length > 0 && (
            <div
              role="radiogroup"
              className="flex items-center p-0.5 mr-1 rounded-full border border-gray-700 bg-black/20"
              onClick={(event) => event.stopPropagation()}
              title="官方位置区块的全局开关:AI 排版 = 坐标照发但交给模型构图(use_coords false);用我摆的 = 按每个角色的坐标出图"
            >
              {[{ value: false, label: 'AI 排版' }, { value: true, label: '用我摆的' }].map((option) => {
                const on = useCoords === option.value;
                return (
                  <button
                    key={option.label}
                    role="radio"
                    aria-checked={on}
                    onClick={() => onSetUseCoords(option.value)}
                    className={`px-2 py-0.5 rounded-full text-[11px] font-bold transition-colors ${on ? 'bg-nai-accent text-black' : 'text-gray-400 hover:text-white'}`}
                  >
                    {option.label}
                  </button>
                );
              })}
            </div>
          )}
          {characterPrompts.length > 0 && (
            <button
              className="flex items-center gap-1 px-1.5 py-1 rounded text-xs font-bold border transition-all duration-200 bg-red-500/20 text-red-400 border-red-500/50 hover:bg-red-500/30 hover:text-red-300"
              onClick={(event) => {
                event.stopPropagation();
                clearAllCharacterPrompts();
              }}
              title={isClearConfirming ? '点击确认清空' : '清空所有角色'}
            >
              <Trash2 className="w-3 h-3" />
              {isClearConfirming ? '确认' : '清空'}
            </button>
          )}
          <button
            className={`flex items-center gap-1 px-1.5 py-1 rounded text-xs font-bold border transition-colors ${characterPrompts.length >= maxCharacters
              ? 'bg-gray-800 text-gray-500 border-gray-800 cursor-not-allowed'
              : 'bg-nai-input hover:bg-gray-700 text-white border-gray-700'
            }`}
            onClick={(event) => {
              event.stopPropagation();
              if (characterPrompts.length < maxCharacters) {
                addCharacterPrompt();
                if (!isCharacterSectionOpen) setIsCharacterSectionOpen(true);
              }
            }}
            disabled={characterPrompts.length >= maxCharacters}
            title={characterPrompts.length >= maxCharacters ? `已达到最大角色数量 (${maxCharacters})` : '添加角色'}
          >
            <Plus className="w-3 h-3" />
            添加角色
          </button>
        </div>
      </div>

      {isCharacterSectionOpen && (
        <div className="space-y-2">
          {characterPrompts.map((char, index) => (
            <div key={char.id} className={`group bg-nai-input/50 rounded-lg border border-gray-800 hover:border-gray-700 transition-all duration-200 ${!char.enabled ? 'opacity-60' : ''}`}>
              <div className="relative flex items-center justify-between px-2 py-1.5 bg-black/20 border-b border-gray-800/50">
                <div className="flex items-center gap-1 flex-1 min-w-0">
                  <button
                    onClick={(event) => {
                      event.stopPropagation();
                      updateCharacterPrompt(char.id, 'enabled', !char.enabled);
                    }}
                    className={`p-1 transition-colors rounded hover:bg-white/10 shrink-0 ${char.enabled ? 'text-nai-accent hover:text-[#ebd576]' : 'text-gray-600 hover:text-gray-400'}`}
                    title={char.enabled ? '禁用角色' : '启用角色'}
                  >
                    <Power className="w-4 h-4" />
                  </button>
                  <div className="flex items-center gap-1 select-none min-w-0 overflow-hidden">
                    <User className="w-3.5 h-3.5 text-gray-500 shrink-0" />
                    <span className="text-xs font-bold text-gray-300 truncate max-w-[5rem]" title={char.name || `Char ${index + 1}`}>
                      {char.name || `Char ${index + 1}`}
                    </span>
                  </div>

                  <div
                    className="relative flex items-center bg-black/40 rounded-full p-0.5 border border-gray-700/50 w-28 h-6 select-none ml-auto shrink-0 cursor-pointer group/toggle"
                    onClick={(event) => {
                      event.stopPropagation();
                      updateCharacterPrompt(char.id, 'activeTab', char.activeTab === 'prompt' ? 'undesired' : 'prompt');
                    }}
                  >
                    <div
                      className={`absolute top-0.5 bottom-0.5 rounded-full transition-all duration-300 ease-out shadow-sm ${char.activeTab === 'prompt'
                        ? 'left-0.5 w-[calc(50%-2px)] bg-nai-accent shadow-[0_0_8px_rgba(235,213,118,0.4)]'
                        : 'left-[calc(50%+1px)] w-[calc(50%-3px)] bg-red-500 shadow-[0_0_8px_rgba(239,68,68,0.4)]'
                      }`}
                    />
                    <div className={`relative z-10 flex-1 flex items-center justify-center transition-colors duration-200 pb-0.5 ${char.activeTab === 'prompt' ? 'text-black' : 'text-gray-500 group-hover/toggle:text-gray-400'}`}>
                      <Sparkles className="w-3.5 h-3.5" />
                    </div>
                    <div className={`relative z-10 flex-1 flex items-center justify-center transition-colors duration-200 pb-0.5 ${char.activeTab === 'undesired' ? 'text-white' : 'text-gray-500 group-hover/toggle:text-gray-400'}`}>
                      <Ban className="w-3.5 h-3.5" />
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-0.5 ml-2 shrink-0" onClick={(event) => event.stopPropagation()}>
                  <button
                    onClick={() => moveCharacterPrompt(index, -1)}
                    disabled={index === 0}
                    className="p-1.5 text-gray-500 hover:text-white disabled:opacity-30 disabled:hover:text-gray-500 transition-colors rounded hover:bg-white/5"
                    title="上移"
                  >
                    <ArrowUp className="w-4 h-4" />
                  </button>
                  <button
                    onClick={() => moveCharacterPrompt(index, 1)}
                    disabled={index === characterPrompts.length - 1}
                    className="p-1.5 text-gray-500 hover:text-white disabled:opacity-30 disabled:hover:text-gray-500 transition-colors rounded hover:bg-white/5"
                    title="下移"
                  >
                    <ArrowDown className="w-4 h-4" />
                  </button>
                  <div className="w-px h-4 bg-gray-700 mx-0.5" />
                  <button
                    onClick={() => removeCharacterPrompt(char.id)}
                    className="p-1.5 text-gray-500 hover:text-red-400 transition-colors rounded hover:bg-white/5"
                    title="删除角色"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
              </div>

              <div className="w-full relative overflow-hidden flex flex-col" style={{ height: charHeights[char.id] ? `${charHeights[char.id]}px` : '150px', transition: isDraggingChar.current === char.id ? 'none' : 'height 0.25s ease-out' }}>
                {chipMode ? (
                  <div className="relative flex-1 min-h-0">
                    <DesktopChipEditor
                      value={char.activeTab === 'prompt' ? char.positive : char.negative}
                      onChange={(value) => updateCharacterPrompt(char.id, char.activeTab === 'prompt' ? 'positive' : 'negative', value)}
                      placeholder={char.activeTab === 'prompt' ? '在此输入角色提示词...' : '在此输入角色排除内容...'}
                      className={`absolute inset-0 ${!char.enabled ? 'opacity-50 pointer-events-none' : ''}`}
                      type={char.activeTab === 'prompt' ? 'prompt' : 'undesired'}
                      onContentHeightChange={(height) => handleCharContentHeightChange(char.id, height)}
                    />
                    <PositionButton char={char} dimmed={!useCoords} onEdit={setEditingPositionId} />
                    <TokenCount value={char.activeTab === 'prompt' ? char.positive : char.negative} />
                  </div>
                ) : (
                  <div className="relative flex-1 min-h-0">
                    <PromptEditor
                      disableCollapsibleTags
                      containerClassName="w-full h-full"
                      className={`w-full h-full bg-transparent text-white text-sm font-mono outline-none p-2 pb-7 transition-colors placeholder:text-gray-600 focus:bg-black/20 ${!char.enabled ? 'text-gray-500 cursor-not-allowed' : ''}`}
                      value={char.activeTab === 'prompt' ? char.positive : char.negative}
                      onChange={(value) => updateCharacterPrompt(char.id, char.activeTab === 'prompt' ? 'positive' : 'negative', value)}
                      placeholder={char.activeTab === 'prompt' ? '在此输入角色提示词...' : '在此输入角色排除内容...'}
                      onContentHeightChange={(height) => handleCharContentHeightChange(char.id, height)}
                    />
                    <PositionButton char={char} dimmed={!useCoords} onEdit={setEditingPositionId} />
                    <TokenCount value={char.activeTab === 'prompt' ? char.positive : char.negative} emphasisOnHover />
                  </div>
                )}
                <div
                  className="absolute bottom-0 left-0 right-0 h-1 cursor-ns-resize z-50 hover:bg-white/10 transition-colors rounded-b-lg"
                  onMouseDown={(event) => handleCharMouseDown(event, char.id)}
                  title="拖动调整高度"
                />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * 按钮上写落点的百分比。每个角色一建出来就有坐标(官方出生序),所以不再有 AUTO;
 * 不写最近的格子名——两个不同的点会显示成同一个 `C3`,那比不写更糟。
 */
function positionLabel(char: CharacterPrompt): string {
  const center = placedCenter(char);
  if (!center) return '…';
  return `${Math.round(center.x * 100)}·${Math.round(center.y * 100)}`;
}

function PositionButton({ char, dimmed, onEdit }: { char: CharacterPrompt; dimmed: boolean; onEdit: (id: string) => void }) {
  return (
    <button
      onClick={(event) => {
        event.stopPropagation();
        onEdit(char.id);
      }}
      className={`absolute bottom-1 left-2 z-10 flex items-center gap-1.5 px-2 py-1 rounded text-xs font-mono border bg-black/15 border-gray-600/30 text-gray-500 hover:bg-black/40 hover:text-white hover:border-gray-500 transition-colors ${dimmed ? 'opacity-50' : ''}`}
      title={dimmed ? '当前是 AI 排版,坐标不生效;点开摆位会自动切到「用我摆的」' : '设置位置'}
    >
      <MapPin className="w-3.5 h-3.5" />
      {positionLabel(char)}
    </button>
  );
}

function TokenCount({ value, emphasisOnHover = false }: { value: string; emphasisOnHover?: boolean }) {
  // 与主提示词同口径:片段引用按展开后的正文计数。
  const chunks = usePromptChunkLibrary();
  const counted = expandPromptChunksForSend(value, chunks).text;
  return (
    <div className={`absolute bottom-1 right-2 pointer-events-none opacity-60 z-10 ${emphasisOnHover ? 'group-hover:opacity-100 group-focus-within/input:opacity-100 transition-opacity' : ''}`}>
      <span className="text-xs font-bold text-gray-500 font-mono">
        {countTokens(counted)}
      </span>
    </div>
  );
}
