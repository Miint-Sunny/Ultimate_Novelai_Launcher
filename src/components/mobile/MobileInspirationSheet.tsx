import { Copy, Dices, Filter, Loader2, Plus, Sparkles, X } from 'lucide-react';
import { copyToClipboard } from '../../utils/clipboard';
import type { useMobileCodexInspiration } from './generate/useMobileCodexInspiration';
import { CategoryGroup } from './inspiration/MobileInspirationCategoryGroup';

type MobileCodexInspiration = ReturnType<typeof useMobileCodexInspiration>;

interface MobileInspirationSheetProps {
  isOpen: boolean;
  onClose: () => void;
  onSelect: (prompt: string) => void;
  library: MobileCodexInspiration;
}

export function MobileInspirationSheet({ isOpen, onClose, onSelect, library }: MobileInspirationSheetProps) {
  if (!isOpen) return null;

  return (
    <>
      <div className="fixed inset-0 z-50 bg-black/70 flex items-end animate-fade-in">
        <div className="absolute inset-0" onClick={onClose} />
        <div className="relative w-full bg-nai-panel rounded-t-2xl h-[85vh] flex flex-col animate-slide-in-from-bottom safe-area-bottom">
          <div className="flex-shrink-0 flex items-center justify-between p-4 border-b border-gray-700">
            <div className="flex items-center gap-2">
              <Sparkles className="w-5 h-5 text-pink-400" />
              <h3 className="text-lg font-bold text-white">灵感空间</h3>
            </div>
            <button onClick={onClose} className="p-2 -mr-2 text-gray-400">
              <X className="w-5 h-5" />
            </button>
          </div>

          <div className="flex-shrink-0 p-3 border-b border-gray-700/50 space-y-2">
            <div className="flex gap-2">
              <div className="relative flex-1">
                <input
                  type="text"
                  value={library.codexSearchQuery}
                  onChange={(event) => library.setCodexSearchQuery(event.target.value)}
                  placeholder="搜索法典内容..."
                  className="w-full bg-gray-800 border border-gray-700 rounded-xl pl-10 pr-4 py-2.5 text-sm text-white placeholder:text-gray-500 focus:outline-none focus:border-pink-500"
                />
                <Sparkles className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
              </div>
              <button
                onClick={() => library.setShowCategoryFilter(true)}
                className={`px-3 py-2.5 rounded-xl border flex items-center gap-1.5 transition-colors ${library.codexSelectedCategories.length > 0
                  ? 'bg-pink-500/20 border-pink-500/50 text-pink-400'
                  : 'bg-gray-800 border-gray-700 text-gray-400'
                  }`}
              >
                <Filter className="w-4 h-4" />
                {library.codexSelectedCategories.length > 0 && (
                  <span className="text-xs font-bold">{library.codexSelectedCategories.length}</span>
                )}
              </button>
            </div>

            <div className="flex gap-2">
              {(['all', 'safe', 'r18'] as const).map((filter) => (
                <button
                  key={filter}
                  onClick={() => library.setCodexR18Filter(filter)}
                  className={`flex-1 py-2 rounded-lg text-xs font-medium transition-colors ${library.codexR18Filter === filter
                    ? filter === 'r18'
                      ? 'bg-pink-500/20 text-pink-400 border border-pink-500/50'
                      : filter === 'safe'
                        ? 'bg-green-500/20 text-green-400 border border-green-500/50'
                        : 'bg-gray-700 text-white border border-gray-600'
                    : 'bg-gray-800/50 text-gray-400 border border-gray-700'
                    }`}
                >
                  {filter === 'all' ? '全部' : filter === 'safe' ? '全年龄' : 'R18'}
                </button>
              ))}
            </div>

            {library.codexSelectedCategories.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {library.codexSelectedCategories.map((category) => {
                  const [type, name] = category.split(':');
                  return (
                    <span
                      key={category}
                      onClick={() => library.toggleCodexCategory(category)}
                      className={`px-2 py-1 rounded-lg text-xs font-medium cursor-pointer flex items-center gap-1 ${type === 'nsfw'
                        ? 'bg-pink-500/20 text-pink-400 border border-pink-500/30'
                        : 'bg-green-500/20 text-green-400 border border-green-500/30'
                        }`}
                    >
                      {name}
                      <X className="w-3 h-3" />
                    </span>
                  );
                })}
                <button
                  onClick={() => library.setCodexSelectedCategories([])}
                  className="px-2 py-1 rounded-lg text-xs font-medium bg-gray-700 text-gray-400 hover:text-white"
                >
                  清空
                </button>
              </div>
            )}
          </div>

          <div className="flex-shrink-0 flex border-b border-gray-700">
            <button
              className={`flex-1 py-3 text-sm font-medium transition-colors border-b-2 ${library.inspirationTab === 'codex'
                ? 'border-pink-500 text-white bg-white/5'
                : 'border-transparent text-gray-400'
                }`}
              onClick={() => library.setInspirationTab('codex')}
            >
              全部法典 ({library.filteredCodexData.length})
            </button>
            <button
              className={`flex-1 py-3 text-sm font-medium transition-colors border-b-2 ${library.inspirationTab === 'random'
                ? 'border-pink-500 text-white bg-white/5'
                : 'border-transparent text-gray-400'
                }`}
              onClick={library.showRandomTab}
            >
              随机灵感
            </button>
          </div>

          <div className="flex-1 overflow-hidden flex flex-col min-h-0">
            {library.inspirationTab === 'codex' ? (
              <div className="flex-1 overflow-y-auto" onScroll={library.handleCodexScroll}>
                {library.isLoadingCodex ? (
                  <div className="flex items-center justify-center py-12">
                    <Loader2 className="w-8 h-8 animate-spin text-gray-400" />
                  </div>
                ) : library.filteredCodexData.length === 0 ? (
                  <div className="flex flex-col items-center justify-center py-12 text-gray-500">
                    <Sparkles className="w-12 h-12 mb-3 opacity-50" />
                    <p>暂无匹配内容</p>
                  </div>
                ) : (
                  <div className="p-3 space-y-2">
                    {library.filteredCodexData.slice(0, library.codexDisplayCount).map((item) => (
                      <div
                        key={item.id}
                        className="p-3 rounded-xl border bg-gray-800/50 border-gray-700 active:bg-gray-700/50 transition-all"
                        onClick={() => onSelect(item.content)}
                      >
                        <div className="flex items-center gap-2 mb-2">
                          <span className="font-medium text-white text-sm">{item.title}</span>
                          <span className={`px-1.5 py-0.5 rounded text-xs ${item.isR18 ? 'bg-pink-500/20 text-pink-400' : 'bg-green-500/20 text-green-400'}`}>
                            {item.isR18 ? 'R18' : '全年龄'}
                          </span>
                          <span className="px-1.5 py-0.5 bg-gray-700 text-gray-400 rounded text-xs">
                            {item.category}
                          </span>
                        </div>
                        <p className="text-xs text-gray-400 line-clamp-2">{item.content}</p>
                      </div>
                    ))}
                    {library.codexDisplayCount < library.filteredCodexData.length && (
                      <div className="flex items-center justify-center py-4">
                        <Loader2 className="w-5 h-5 animate-spin text-gray-500" />
                        <span className="ml-2 text-xs text-gray-500">
                          加载中... ({library.codexDisplayCount}/{library.filteredCodexData.length})
                        </span>
                      </div>
                    )}
                  </div>
                )}
              </div>
            ) : (
              <div className="flex-1 flex flex-col p-4 min-h-0">
                {library.randomCodexItem ? (
                  <div className="flex-1 flex flex-col min-h-0">
                    <div className="flex-shrink-0 flex items-center gap-2 mb-3 overflow-hidden">
                      <span className="text-lg font-bold text-white truncate min-w-0 shrink" title={library.randomCodexItem.title}>
                        {library.randomCodexItem.title}
                      </span>
                      <span className={`px-2 py-0.5 rounded text-xs font-bold whitespace-nowrap shrink-0 ${library.randomCodexItem.isR18
                        ? 'bg-pink-500/20 text-pink-400 border border-pink-500/30'
                        : 'bg-green-500/20 text-green-400 border border-green-500/30'
                        }`}
                      >
                        {library.randomCodexItem.isR18 ? 'R18' : '全年龄'}
                      </span>
                      <span className="px-2 py-0.5 bg-indigo-500/20 text-indigo-300 rounded text-xs border border-indigo-500/30 whitespace-nowrap shrink-0">
                        {library.randomCodexItem.category}
                      </span>
                    </div>

                    <div className="flex-1 min-h-0 bg-gray-800/50 rounded-xl p-4 border border-gray-700 overflow-y-auto">
                      <p className="text-sm text-gray-300 leading-relaxed whitespace-pre-wrap">
                        {library.randomCodexItem.content}
                      </p>
                    </div>

                    <div className="flex-shrink-0 flex gap-2 mt-4">
                      <button
                        onClick={library.handleRandomCodex}
                        className="flex-1 py-3 bg-gray-700 text-white font-bold rounded-xl active:scale-[0.98] transition-all flex items-center justify-center gap-2"
                      >
                        <Dices className="w-4 h-4" />
                        换一个
                      </button>
                      <button
                        onClick={() => copyToClipboard(library.randomCodexItem?.content || '')}
                        className="py-3 px-4 bg-gray-700 text-white font-bold rounded-xl active:scale-[0.98] transition-all flex items-center justify-center"
                      >
                        <Copy className="w-4 h-4" />
                      </button>
                      <button
                        onClick={() => onSelect(library.randomCodexItem?.content || '')}
                        className="flex-1 py-3 bg-gradient-to-r from-pink-500 to-purple-500 text-white font-bold rounded-xl active:scale-[0.98] transition-all flex items-center justify-center gap-2"
                      >
                        <Plus className="w-4 h-4" />
                        添加
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="flex-1 flex flex-col items-center justify-center text-gray-500">
                    <Dices className="w-16 h-16 mb-4 opacity-50" />
                    <p className="text-lg font-medium mb-2">随机灵感</p>
                    <p className="text-sm text-gray-600 mb-6">从法典中随机抽取一条灵感</p>
                    <button
                      onClick={library.handleRandomCodex}
                      disabled={library.filteredCodexData.length === 0}
                      className="px-8 py-3 bg-gradient-to-r from-pink-500 to-purple-500 text-white font-bold rounded-xl active:scale-[0.98] transition-all flex items-center gap-2 disabled:opacity-50"
                    >
                      <Dices className="w-5 h-5" />
                      开始随机
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {library.showCategoryFilter && (
        <div className="fixed inset-0 z-[60] bg-black/70 flex items-end animate-fade-in">
          <div className="absolute inset-0" onClick={() => library.setShowCategoryFilter(false)} />
          <div className="relative w-full bg-nai-panel rounded-t-2xl max-h-[70vh] flex flex-col animate-slide-in-from-bottom safe-area-bottom">
            <div className="flex-shrink-0 flex items-center justify-between p-4 border-b border-gray-700">
              <div className="flex items-center gap-2">
                <Filter className="w-5 h-5 text-pink-400" />
                <h3 className="text-lg font-bold text-white">分类筛选</h3>
                {library.codexSelectedCategories.length > 0 && (
                  <span className="px-2 py-0.5 bg-pink-500/20 text-pink-400 rounded-full text-xs font-bold">
                    {library.codexSelectedCategories.length}
                  </span>
                )}
              </div>
              <button onClick={() => library.setShowCategoryFilter(false)} className="p-2 -mr-2 text-gray-400">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-4 space-y-4">
              {library.categoriesByType.nsfw.length > 0 && (
                <CategoryGroup
                  title="R18 分类"
                  tone="nsfw"
                  categories={library.categoriesByType.nsfw}
                  selectedCategories={library.codexSelectedCategories}
                  onToggle={library.toggleCodexCategory}
                />
              )}
              {library.categoriesByType.common.length > 0 && (
                <CategoryGroup
                  title="全年龄分类"
                  tone="common"
                  categories={library.categoriesByType.common}
                  selectedCategories={library.codexSelectedCategories}
                  onToggle={library.toggleCodexCategory}
                />
              )}
            </div>

            <div className="flex-shrink-0 p-4 border-t border-gray-700 bg-nai-panel flex gap-3">
              <button
                onClick={() => library.setCodexSelectedCategories([])}
                disabled={library.codexSelectedCategories.length === 0}
                className="flex-1 py-3 bg-gray-700 text-white font-bold rounded-xl active:scale-[0.98] transition-all disabled:opacity-50"
              >
                清空
              </button>
              <button
                onClick={() => library.setShowCategoryFilter(false)}
                className="flex-1 py-3 bg-pink-500 text-white font-bold rounded-xl active:scale-[0.98] transition-all"
              >
                确认 ({library.codexSelectedCategories.length})
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
