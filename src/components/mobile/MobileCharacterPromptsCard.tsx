import {
  ArrowDown,
  ArrowUp,
  Ban,
  ChevronDown,
  Grid,
  Plus,
  Power,
  Sparkles,
  Trash2,
  User,
  Users,
  X,
} from 'lucide-react';
import { countTokens } from '../../services/tokenizer';
import type { useMobileCharacterPrompts } from './generate/useMobileCharacterPrompts';

type MobileCharacterPrompts = ReturnType<typeof useMobileCharacterPrompts>;

interface MobileCharacterPromptsCardProps {
  manager: MobileCharacterPrompts;
}

export function MobileCharacterPromptsCard({ manager }: MobileCharacterPromptsCardProps) {
  const {
    characterPrompts,
    isCharacterExpanded,
    setIsCharacterExpanded,
    setEditingCharacterId,
    setEditingPositionId,
    addCharacterPrompt,
    removeCharacterPrompt,
    updateCharacterPrompt,
    moveCharacterPrompt,
    clearAllCharacterPrompts,
  } = manager;

  return (
    <div className="bg-nai-input rounded-xl border border-gray-700/50 overflow-hidden shadow-lg">
      <div
        className="flex items-center justify-between p-3 active:bg-gray-800/50 transition-colors cursor-pointer"
        onClick={() => {
          if (characterPrompts.length > 0) {
            setIsCharacterExpanded(!isCharacterExpanded);
          }
        }}
      >
        <div className="flex items-center gap-2">
          {characterPrompts.length > 0 && (
            <ChevronDown
              className={`w-5 h-5 text-gray-400 transition-transform ${isCharacterExpanded ? '' : '-rotate-90'}`}
            />
          )}
          <Users className="w-5 h-5 text-green-400" />
          <span className="text-sm font-bold text-gray-200">角色提示词</span>
          {characterPrompts.length > 0 && (
            <span className="text-xs text-green-400 bg-green-500/20 px-1.5 py-0.5 rounded">
              {characterPrompts.length}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {characterPrompts.length > 0 && (
            <button
              onClick={(event) => {
                event.stopPropagation();
                clearAllCharacterPrompts();
              }}
              className="px-3 py-2 bg-red-500/20 text-red-400 text-sm font-medium rounded-lg active:scale-95 transition-all flex items-center gap-1.5"
            >
              <Trash2 className="w-4 h-4" />
              清空
            </button>
          )}
          <button
            onClick={(event) => {
              event.stopPropagation();
              if (characterPrompts.length < 6) {
                addCharacterPrompt();
                setIsCharacterExpanded(true);
              }
            }}
            disabled={characterPrompts.length >= 6}
            className={`px-3 py-2 text-sm font-medium rounded-lg active:scale-95 transition-all flex items-center gap-1.5 ${characterPrompts.length >= 6
              ? 'bg-gray-700/50 text-gray-500'
              : 'bg-green-500/20 text-green-400'
              }`}
          >
            <Plus className="w-4 h-4" />
            添加
          </button>
        </div>
      </div>

      {characterPrompts.length > 0 && isCharacterExpanded && (
        <div className="border-t border-gray-700/30">
          {characterPrompts.map((characterPrompt, index) => (
            <div
              key={characterPrompt.id}
              className={`p-3 ${index > 0 ? 'border-t border-gray-700/30' : ''} ${!characterPrompt.enabled ? 'opacity-60' : ''}`}
            >
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => updateCharacterPrompt(characterPrompt.id, 'enabled', !characterPrompt.enabled)}
                    className={`w-8 h-8 rounded-lg flex items-center justify-center transition-colors ${characterPrompt.enabled
                      ? 'bg-green-500/20 text-green-400'
                      : 'bg-gray-700/50 text-gray-500'
                      }`}
                  >
                    <Power className="w-4 h-4" />
                  </button>
                  <div className="flex items-center gap-1 min-w-0 overflow-hidden">
                    <User className="w-4 h-4 text-gray-500 shrink-0" />
                    <span
                      className="text-sm font-bold text-gray-300 truncate max-w-[6rem]"
                      title={characterPrompt.name || `角色 ${index + 1}`}
                    >
                      {characterPrompt.name || `角色 ${index + 1}`}
                    </span>
                  </div>
                  <div
                    className="flex items-center bg-black/40 rounded-full p-1 border border-gray-700/50 cursor-pointer"
                    onClick={() =>
                      updateCharacterPrompt(
                        characterPrompt.id,
                        'activeTab',
                        characterPrompt.activeTab === 'prompt' ? 'undesired' : 'prompt'
                      )
                    }
                  >
                    <div className={`px-2.5 py-1 rounded-full transition-colors ${characterPrompt.activeTab === 'prompt'
                      ? 'bg-nai-accent text-black'
                      : 'text-gray-500'
                      }`}
                    >
                      <Sparkles className="w-4 h-4" />
                    </div>
                    <div className={`px-2.5 py-1 rounded-full transition-colors ${characterPrompt.activeTab === 'undesired'
                      ? 'bg-red-500 text-white'
                      : 'text-gray-500'
                      }`}
                    >
                      <Ban className="w-4 h-4" />
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => moveCharacterPrompt(index, -1)}
                    disabled={index === 0}
                    className="w-8 h-8 rounded-lg flex items-center justify-center text-gray-500 disabled:opacity-30 active:scale-95 bg-gray-700/30"
                  >
                    <ArrowUp className="w-4 h-4" />
                  </button>
                  <button
                    onClick={() => moveCharacterPrompt(index, 1)}
                    disabled={index === characterPrompts.length - 1}
                    className="w-8 h-8 rounded-lg flex items-center justify-center text-gray-500 disabled:opacity-30 active:scale-95 bg-gray-700/30"
                  >
                    <ArrowDown className="w-4 h-4" />
                  </button>
                  <button
                    onClick={() => removeCharacterPrompt(characterPrompt.id)}
                    className="w-8 h-8 rounded-lg flex items-center justify-center text-gray-500 hover:text-red-400 active:scale-95 bg-gray-700/30"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
              </div>

              <div
                onClick={() => setEditingCharacterId(characterPrompt.id)}
                className={`relative w-full min-h-[84px] p-3 pb-11 rounded-lg border text-sm cursor-pointer transition-colors ${characterPrompt.activeTab === 'prompt'
                  ? 'bg-nai-accent/5 border-nai-accent/30'
                  : 'bg-red-500/5 border-red-500/30'
                  } ${!characterPrompt.enabled ? 'opacity-50' : ''}`}
              >
                <div className="text-gray-300 line-clamp-2 whitespace-pre-wrap">
                  {(characterPrompt.activeTab === 'prompt' ? characterPrompt.positive : characterPrompt.negative) || (
                    <span className="text-gray-600">
                      {characterPrompt.activeTab === 'prompt' ? '点击输入角色提示词...' : '点击输入角色排除内容...'}
                    </span>
                  )}
                </div>
                <div className="absolute bottom-2 left-2 right-2 flex items-center justify-between pointer-events-none">
                  <button
                    onClick={(event) => {
                      event.stopPropagation();
                      setEditingPositionId(characterPrompt.id);
                    }}
                    className="pointer-events-auto flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-sm font-mono border bg-black/30 border-gray-600/40 text-gray-300 active:bg-black/50 active:text-white transition-colors"
                    title="设置位置"
                  >
                    <Grid className="w-4 h-4" />
                    {characterPrompt.position || 'AUTO'}
                  </button>
                  <span className="text-sm text-gray-400 font-mono">
                    {countTokens(characterPrompt.activeTab === 'prompt' ? characterPrompt.positive : characterPrompt.negative)}
                  </span>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
