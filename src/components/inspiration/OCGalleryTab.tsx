// 原创角色展示页 - 灵感空间子页面
import React, { useState, useMemo, useEffect, useCallback, startTransition, useRef } from 'react';
import {
  Search, X, Users, User, Loader2, Copy, Check,
  Heart, Sparkles, Plus, Info
} from 'lucide-react';
import type { OCFile } from '../oc/types';
import { botService } from '../../services/botService';
import { getPublicOCs, getOCPreviewUrl } from '../../services/publicLibrary';
import { countTokens } from '../../services/tokenizer';

// 每页显示的分组数量
const GROUPS_PER_PAGE = 3;

interface OCGalleryTabProps {
  onClose: () => void;
  onSelectPrompt: (prompt: string) => void;
  onAddCollapsibleTag?: (tag: { type: 'oc'; label: string; content: string }) => void;
  onAddToCharacter?: (tag: { type: 'oc'; label: string; content: string }) => void;
  favoriteOCIds?: string[];
  onToggleFavorite?: (id: string, e?: React.MouseEvent) => void;
}

export const OCGalleryTab: React.FC<OCGalleryTabProps> = ({
  onClose,
  onSelectPrompt,
  onAddCollapsibleTag,
  onAddToCharacter,
  favoriteOCIds: externalFavoriteOCIds,
  onToggleFavorite: externalToggleFavorite,
}) => {
  // --- 数据状态 ---
  const [ocPublicFiles, setOcPublicFiles] = useState<OCFile[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [activeSource, setActiveSource] = useState<'public' | 'mine'>('public');

  // --- 分页状态 ---
  const [displayedGroupCount, setDisplayedGroupCount] = useState(GROUPS_PER_PAGE);
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  // --- 筛选状态 ---
  const [searchQuery, setSearchQuery] = useState('');

  // --- 交互状态 ---
  const [copiedOCId, setCopiedOCId] = useState<string | null>(null);
  const [addedOCId, setAddedOCId] = useState<string | null>(null);
  const [previewOC, setPreviewOC] = useState<OCFile | null>(null);
  const [isAboutOpen, setIsAboutOpen] = useState(false);

  // --- 使用外部收藏状态（如果提供） ---
  const favoriteOCIds = externalFavoriteOCIds || [];

  // --- 获取当前用户ID ---
  const currentUserId = botService.getAuthState().botUserId;

  // --- 加载数据（延迟执行，避免阻塞UI） ---
  useEffect(() => {
    const rafId = requestAnimationFrame(() => {
      const timeoutId = setTimeout(() => {
        loadOCData();
      }, 50);
      return () => clearTimeout(timeoutId);
    });

    const loadOCData = async () => {
      try {
        const publicOCData = await getPublicOCs(true); // 每次打开都刷新
        const publicOCs: OCFile[] = publicOCData.map(oc => ({
          id: oc.id,
          name: oc.zh_name || oc.en_name,
          preview: oc.preview_url ? getOCPreviewUrl(oc.en_name) : '',
          positive: oc.tag_group,
          negative: '',
          user: 'Bot公共库',
          created_by: oc.created_by || '',
          created_at: oc.created_at || 0,
        }));
        
        startTransition(() => {
          setOcPublicFiles(publicOCs);
        });
      } catch (error) {
        console.error('Failed to load OCs:', error);
      } finally {
        setIsLoading(false);
      }
    };

    return () => cancelAnimationFrame(rafId);
  }, []);

  // --- 先按来源筛选 ---
  const sourceFilteredOCs = useMemo(() => {
    if (activeSource === 'mine' && currentUserId) {
      return ocPublicFiles.filter(oc => oc.created_by === currentUserId);
    }
    return ocPublicFiles;
  }, [ocPublicFiles, activeSource, currentUserId]);

  // --- 按创建者分组（在搜索之前） ---
  const allGroups = useMemo(() => {
    const groups: Record<string, OCFile[]> = {};
    const unclaimed: OCFile[] = [];

    sourceFilteredOCs.forEach(oc => {
      const creator = oc.created_by;
      if (creator) {
        if (!groups[creator]) groups[creator] = [];
        groups[creator].push(oc);
      } else {
        unclaimed.push(oc);
      }
    });

    const result: { key: string; label: string; files: OCFile[] }[] = [];
    Object.keys(groups).forEach(creator => {
      result.push({ key: creator, label: creator, files: groups[creator] });
    });
    // 按角色数量降序排序
    result.sort((a, b) => b.files.length - a.files.length);
    if (unclaimed.length > 0) {
      result.push({ key: '__unclaimed__', label: '未认领角色', files: unclaimed });
    }
    return result;
  }, [sourceFilteredOCs]);

  // --- 按组搜索：搜到任意角色则显示整个组 ---
  const groupedOCs = useMemo(() => {
    if (!searchQuery) return allGroups;

    const query = searchQuery.toLowerCase();
    return allGroups.filter(group => {
      // 检查组内是否有任意角色匹配搜索条件
      return group.files.some(oc => {
        const matchName = oc.name.toLowerCase().includes(query);
        const matchPrompt = oc.positive.toLowerCase().includes(query);
        const matchCreator = (oc.created_by || '').toLowerCase().includes(query);
        return matchName || matchPrompt || matchCreator;
      });
    });
  }, [allGroups, searchQuery]);

  // --- 计算筛选后的总角色数（用于显示） ---
  const filteredOCsCount = useMemo(() => {
    return groupedOCs.reduce((sum, group) => sum + group.files.length, 0);
  }, [groupedOCs]);

  const displayedGroups = useMemo(() => {
    return groupedOCs.slice(0, displayedGroupCount);
  }, [groupedOCs, displayedGroupCount]);

  useEffect(() => {
    setDisplayedGroupCount(GROUPS_PER_PAGE);
    if (scrollContainerRef.current) {
      scrollContainerRef.current.scrollTop = 0;
    }
  }, [activeSource, searchQuery]);

  const handleScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    const { scrollTop, scrollHeight, clientHeight } = e.currentTarget;
    if (scrollHeight - scrollTop - clientHeight < 200 && displayedGroupCount < groupedOCs.length) {
      startTransition(() => {
        setDisplayedGroupCount(prev => Math.min(prev + GROUPS_PER_PAGE, groupedOCs.length));
      });
    }
  }, [displayedGroupCount, groupedOCs.length]);

  const handleCopy = (id: string, prompt: string) => {
    navigator.clipboard.writeText(prompt);
    setCopiedOCId(id);
    setTimeout(() => setCopiedOCId(null), 1500);
  };

  const handleAddOC = (oc: OCFile) => {
    // 默认添加到角色提示词
    if (onAddToCharacter) {
      onAddToCharacter({
        type: 'oc',
        label: oc.name,
        content: oc.positive,
      });
      setAddedOCId(oc.id);
      setTimeout(() => setAddedOCId(null), 1500);
    } else if (onAddCollapsibleTag) {
      onAddCollapsibleTag({
        type: 'oc',
        label: oc.name,
        content: oc.positive,
      });
      setAddedOCId(oc.id);
      setTimeout(() => setAddedOCId(null), 1500);
    } else {
      onSelectPrompt(oc.positive);
      onClose();
    }
  };

  const handleRandomOC = useCallback(() => {
    if (groupedOCs.length === 0) return;
    // 从所有分组中收集所有角色，然后随机选择一个
    const allOCs = groupedOCs.flatMap(group => group.files);
    if (allOCs.length === 0) return;
    const randomOC = allOCs[Math.floor(Math.random() * allOCs.length)];
    setPreviewOC(randomOC);
  }, [groupedOCs]);

  const toggleFavorite = (id: string, e?: React.MouseEvent) => {
    e?.stopPropagation();
    if (externalToggleFavorite) {
      externalToggleFavorite(id, e);
    }
  };

  const myOCCount = useMemo(() => {
    if (!currentUserId) return 0;
    return ocPublicFiles.filter(oc => oc.created_by === currentUserId).length;
  }, [ocPublicFiles, currentUserId]);

  return (
    <div className="h-full flex flex-col animate-in slide-in-from-right-8 fade-in duration-300">
      {/* About Modal */}
      {isAboutOpen && (
        <div className="absolute inset-0 z-[110] flex items-center justify-center bg-black/50 backdrop-blur-sm animate-in fade-in duration-200" onClick={() => setIsAboutOpen(false)}>
           <div className="bg-[#1e1e2e] border border-gray-700 rounded-xl p-6 max-w-md w-full shadow-2xl relative animate-in zoom-in-95 duration-200" onClick={e => e.stopPropagation()}>
              <button 
                onClick={() => setIsAboutOpen(false)}
                className="absolute top-4 right-4 p-1 text-gray-400 hover:text-white rounded-lg hover:bg-white/10 transition-colors"
              >
                 <X className="w-5 h-5" />
              </button>
              
              <div className="flex items-center gap-3 mb-4">
                 <div className="p-3 bg-nai-accent/10 rounded-xl">
                    <Users className="w-8 h-8 text-nai-accent" />
                 </div>
                 <div>
                    <h3 className="text-xl font-bold text-white">关于原创角色</h3>
                    <p className="text-xs text-gray-400">Original Characters</p>
                 </div>
              </div>
              
              <div className="space-y-4 text-sm text-gray-300">
                 <p>
                    原创角色库收集了社区创作者们设计的各种原创角色（OC），每个角色都有独特的外观设定和提示词。
                 </p>
                 <div className="bg-black/30 rounded-lg p-3 space-y-2">
                    <div className="flex items-center gap-2">
                       <Search className="w-4 h-4 text-nai-accent" />
                       <span>支持按名称、提示词、创建者搜索</span>
                    </div>
                    <div className="flex items-center gap-2">
                       <Copy className="w-4 h-4 text-green-400" />
                       <span>一键复制或添加角色提示词</span>
                    </div>
                    <div className="flex items-center gap-2">
                       <Heart className="w-4 h-4 text-red-400" />
                       <span>收藏喜欢的角色方便下次使用</span>
                    </div>
                 </div>
                 <p className="text-xs text-gray-500 pt-2 border-t border-gray-700">
                    数据来源：Bot 公共 OC 库
                    <br />
                    当前共 {ocPublicFiles.length} 个角色
                 </p>
              </div>
           </div>
        </div>
      )}

      {previewOC && (
        <OCPreviewModal
          oc={previewOC}
          onClose={() => setPreviewOC(null)}
          onAdd={() => { handleAddOC(previewOC); setPreviewOC(null); }}
          onCopy={() => handleCopy(previewOC.id, previewOC.positive)}
          isCopied={copiedOCId === previewOC.id}
          onReroll={handleRandomOC}
        />
      )}

      {/* Header */}
      <div className="p-4 border-b border-gray-800 bg-gray-900/50 backdrop-blur-sm z-10">
        <div className="flex justify-between items-center mb-3">
          <div className="flex items-center gap-4 flex-1">
            <div className="flex items-center gap-2 shrink-0">
              <Users className="w-6 h-6 text-nai-accent" />
              <h2 className="text-xl font-bold text-white">原创角色</h2>
              <button 
                onClick={() => setIsAboutOpen(true)}
                className="text-gray-600 hover:text-nai-accent transition-colors"
                title="关于原创角色"
              >
                <Info className="w-4 h-4" />
              </button>
              {!isLoading && (
                <span className="text-xs text-gray-500 ml-2">
                  {filteredOCsCount} / {ocPublicFiles.length}
                </span>
              )}
            </div>

            <div className="relative group flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500 group-focus-within:text-nai-accent transition-colors" />
              <input
                type="text"
                placeholder="搜索角色名称、提示词、创建者ID..."
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                className="w-full bg-black/30 border border-gray-800 rounded-full pl-10 pr-4 h-10 text-sm text-white focus:border-nai-accent focus:ring-1 focus:ring-nai-accent transition-all outline-none placeholder:text-gray-600"
              />
            </div>
          </div>

          <div className="flex items-center gap-2 ml-4">
            <button
              onClick={onClose}
              className="px-4 h-11 bg-red-500/10 hover:bg-red-500/20 text-red-400 hover:text-red-300 border border-red-500/20 hover:border-red-500/50 rounded-lg transition-all flex items-center gap-2 font-bold active:scale-95"
            >
              <X className="w-5 h-5" />
              关闭
            </button>
          </div>
        </div>

        <div className="flex items-center gap-4">
          <div className="grid grid-cols-2 gap-1 bg-black/30 rounded-lg p-1 border border-gray-800 relative w-[160px] h-9">
            <div
              className="absolute inset-y-1 bg-nai-accent rounded-md shadow transition-all duration-300 ease-[cubic-bezier(0.23,1,0.32,1)]"
              style={{
                width: 'calc((100% - 12px) / 2)',
                transform: `translateX(${activeSource === 'public' ? '0' : 'calc(100% + 4px)'})`,
                left: '4px',
              }}
            />
            <button
              onClick={() => setActiveSource('public')}
              className={`relative z-10 px-3 h-full flex items-center justify-center text-xs font-bold rounded-md transition-colors ${
                activeSource === 'public' ? 'text-black' : 'text-gray-400 hover:text-gray-200'
              }`}
            >
              公共
            </button>
            <button
              onClick={() => setActiveSource('mine')}
              className={`relative z-10 px-3 h-full flex items-center justify-center text-xs font-bold rounded-md transition-colors gap-1 ${
                activeSource === 'mine' ? 'text-black' : 'text-gray-400 hover:text-gray-200'
              }`}
            >
              我的
              {myOCCount > 0 && (
                <span className={`text-[10px] px-1 rounded ${activeSource === 'mine' ? 'bg-white/20' : 'bg-nai-accent/10 text-nai-accent'}`}>
                  {myOCCount}
                </span>
              )}
            </button>
          </div>

          {activeSource === 'mine' && !currentUserId && (
            <span className="text-xs text-yellow-500">请先登录以查看您的角色</span>
          )}
        </div>
      </div>

      {/* 内容区域 */}
      <div 
        ref={scrollContainerRef}
        className="flex-1 overflow-y-auto p-4 custom-scrollbar"
        onScroll={handleScroll}
      >
        {isLoading ? (
          <div className="flex flex-col items-center justify-center py-20 text-gray-500">
            <Loader2 className="w-8 h-8 animate-spin mb-4 text-nai-accent" />
            <p>正在加载角色数据...</p>
          </div>
        ) : activeSource === 'mine' && !currentUserId ? (
          <div className="flex flex-col items-center justify-center py-20 text-gray-500">
            <User className="w-12 h-12 mb-4 opacity-30" />
            <p>请先登录以查看您创建的角色</p>
          </div>
        ) : groupedOCs.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-gray-500">
            <Users className="w-12 h-12 mb-4 opacity-30" />
            <p>{activeSource === 'mine' ? '您还没有创建任何角色' : '没有找到匹配的角色'}</p>
            {searchQuery && <p className="text-xs mt-1">尝试调整搜索条件</p>}
          </div>
        ) : (
          <div className="space-y-5">
            {displayedGroups.map(group => (
              <OCGroupCard
                key={group.key}
                group={group}
                favoriteOCIds={favoriteOCIds}
                copiedOCId={copiedOCId}
                addedOCId={addedOCId}
                onCopy={handleCopy}
                onAdd={handleAddOC}
                onFavorite={toggleFavorite}
                onPreview={setPreviewOC}
              />
            ))}
            
            {displayedGroupCount < groupedOCs.length && (
              <div className="flex justify-center py-4">
                <div className="flex items-center gap-2 text-gray-500 text-sm">
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span>滚动加载更多 ({displayedGroups.length} / {groupedOCs.length} 组)</span>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};


// --- 分组卡片组件 ---
interface OCGroupCardProps {
  group: { key: string; label: string; files: OCFile[] };
  favoriteOCIds: string[];
  copiedOCId: string | null;
  addedOCId: string | null;
  onCopy: (id: string, prompt: string) => void;
  onAdd: (oc: OCFile) => void;
  onFavorite: (id: string, e?: React.MouseEvent) => void;
  onPreview: (oc: OCFile) => void;
}

const OCGroupCard = React.memo<OCGroupCardProps>(({
  group, favoriteOCIds, copiedOCId, addedOCId,
  onCopy, onAdd, onFavorite, onPreview,
}) => {
  const ocNames = group.files.slice(0, 4).map(f => f.name);
  const hasMore = group.files.length > 4;
  const namesDisplay = hasMore 
    ? `${ocNames.join('、')} 等` 
    : ocNames.join('、');

  return (
    <div className="bg-[#1a1b26] border border-gray-800 rounded-xl overflow-hidden hover:border-gray-700 transition-colors">
      <div className="flex items-center gap-3 px-4 py-3 bg-gradient-to-r from-nai-accent/10 via-nai-accent/5 to-transparent border-b border-gray-800">
        <div className="p-2 bg-nai-accent/10 rounded-lg shrink-0">
          <User className="w-4 h-4 text-nai-accent" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <p className="text-sm font-bold text-white truncate" title={namesDisplay}>
              {namesDisplay}
            </p>
            <span className="px-2 py-0.5 bg-nai-accent/10 text-nai-accent text-[10px] font-bold rounded-full shrink-0">
              {group.files.length}
            </span>
          </div>
        </div>
      </div>

      <div className="p-3 bg-black/20">
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3">
          {group.files.map(oc => (
            <OCGalleryCard
              key={oc.id}
              oc={oc}
              isFavorite={favoriteOCIds.includes(oc.id)}
              isCopied={copiedOCId === oc.id}
              isAdded={addedOCId === oc.id}
              onCopy={() => onCopy(oc.id, oc.positive)}
              onAdd={() => onAdd(oc)}
              onFavorite={(e) => onFavorite(oc.id, e)}
              onPreview={() => onPreview(oc)}
            />
          ))}
        </div>
      </div>
    </div>
  );
});

OCGroupCard.displayName = 'OCGroupCard';

// --- OC 卡片组件 ---
interface OCGalleryCardProps {
  oc: OCFile;
  isFavorite: boolean;
  isCopied: boolean;
  isAdded: boolean;
  onCopy: () => void;
  onAdd: () => void;
  onFavorite: (e: React.MouseEvent) => void;
  onPreview: () => void;
}

const OCGalleryCard = React.memo<OCGalleryCardProps>(({
  oc, isFavorite, isCopied, isAdded,
  onCopy, onAdd, onFavorite, onPreview,
}) => {
  return (
    <div
      className="group relative aspect-[832/1216] rounded-xl overflow-hidden bg-gray-800 cursor-pointer border-2 border-gray-800 hover:border-nai-accent/40 transition-all duration-300 hover:shadow-[0_0_10px_rgba(252,237,164,0.3)] hover:scale-[1.02]"
      onClick={onPreview}
    >
      {oc.preview ? (
        <img
          src={oc.preview}
          alt={oc.name}
          loading="lazy"
          decoding="async"
          className="w-full h-full object-cover opacity-0 transition-opacity duration-500"
          onLoad={(e) => e.currentTarget.classList.remove('opacity-0')}
        />
      ) : (
        <div className="w-full h-full bg-gradient-to-br from-nai-accent/10 to-nai-accent/5 flex items-center justify-center">
          <User className="w-12 h-12 text-gray-600" />
        </div>
      )}

      {/* Token数量 - 左上角, hover显示 */}
      <span className="absolute top-2 left-2 text-[10px] text-nai-accent bg-nai-accent/10 px-1.5 py-0.5 rounded backdrop-blur-md opacity-0 group-hover:opacity-100 transition-all">
        {countTokens(oc.positive)} tokens
      </span>

      {/* 收藏按钮 - hover显示 */}
      <button
        onClick={onFavorite}
        className={`absolute top-2 right-2 p-1.5 rounded-full backdrop-blur-md transition-all opacity-0 group-hover:opacity-100 ${
          isFavorite
            ? 'bg-red-500/80 text-white'
            : 'bg-black/50 text-gray-300 hover:text-white hover:bg-black/70'
        }`}
      >
        <Heart className={`w-4 h-4 ${isFavorite ? 'fill-current' : ''}`} />
      </button>

      {/* 底部信息和操作 - hover显示 */}
      <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/90 via-black/70 to-transparent p-2.5 translate-y-full group-hover:translate-y-0 opacity-0 group-hover:opacity-100 transition-all duration-300">
        <h3 className="text-sm font-bold text-white truncate mb-1.5">{oc.name}</h3>

        {/* 操作按钮 */}
        <div className="flex gap-1.5">
          <button
            onClick={(e) => { e.stopPropagation(); onCopy(); }}
            className={`flex-1 py-1 rounded text-[10px] font-bold transition-colors flex items-center justify-center gap-1 ${
              isCopied
                ? 'bg-green-600 text-white'
                : 'bg-white/10 hover:bg-white/20 text-gray-200'
            }`}
          >
            {isCopied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
            {isCopied ? '已复制' : '复制'}
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); onAdd(); }}
            className={`flex-1 py-1 rounded text-[10px] font-bold transition-colors flex items-center justify-center gap-1 ${
              isAdded
                ? 'bg-green-600 text-white'
                : 'bg-nai-accent hover:bg-nai-accent-hover text-black'
            }`}
          >
            {isAdded ? <Check className="w-3 h-3" /> : <Plus className="w-3 h-3" />}
            {isAdded ? '已添加' : '添加'}
          </button>
        </div>
      </div>
    </div>
  );
});

OCGalleryCard.displayName = 'OCGalleryCard';

// --- 预览弹窗 ---
interface OCPreviewModalProps {
  oc: OCFile;
  onClose: () => void;
  onAdd: () => void;
  onCopy: () => void;
  isCopied: boolean;
  onReroll: () => void;
}

const OCPreviewModal: React.FC<OCPreviewModalProps> = ({
  oc, onClose, onAdd, onCopy, isCopied, onReroll,
}) => {
  return (
    <div
      className="absolute inset-0 z-[120] flex items-center justify-center bg-black/60 backdrop-blur-sm animate-in fade-in duration-200"
      onClick={onClose}
    >
      <div
        className="bg-[#1e1e2e] border border-gray-700 rounded-xl shadow-2xl w-[600px] max-h-[80vh] overflow-hidden animate-in zoom-in-95 duration-200 flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        <div className="p-4 border-b border-gray-800 flex items-center justify-between bg-gray-900/50">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-gradient-to-br from-nai-accent/10 to-nai-accent/5 rounded-xl">
              <User className="w-6 h-6 text-nai-accent" />
            </div>
            <h3 className="text-lg font-bold text-white">{oc.name}</h3>
          </div>
          <button
            onClick={onClose}
            className="p-1 text-gray-400 hover:text-white rounded-lg hover:bg-white/10 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4">
          <div className="flex gap-4">
            <div className="w-[200px] shrink-0">
              <div className="aspect-[832/1216] rounded-lg overflow-hidden bg-gray-800 border border-gray-700">
                {oc.preview ? (
                  <img src={oc.preview} alt={oc.name} className="w-full h-full object-cover" />
                ) : (
                  <div className="w-full h-full bg-gradient-to-br from-nai-accent/10 to-nai-accent/5 flex items-center justify-center">
                    <User className="w-16 h-16 text-gray-600" />
                  </div>
                )}
              </div>
            </div>

            <div className="flex-1 flex flex-col gap-4">
              <div>
                <div className="flex justify-between items-center mb-2">
                  <div className="flex items-center gap-2">
                    <label className="text-sm text-gray-400 font-bold">正向提示词</label>
                    <span className="text-xs text-nai-accent bg-nai-accent/10 px-2 py-0.5 rounded">
                      {countTokens(oc.positive)} Tokens
                    </span>
                  </div>
                  <button
                    onClick={onCopy}
                    className={`text-xs px-2 py-1 rounded flex items-center gap-1 transition-colors ${
                      isCopied ? 'bg-green-600 text-white' : 'bg-gray-800 hover:bg-gray-700 text-gray-300'
                    }`}
                  >
                    {isCopied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                    {isCopied ? '已复制' : '复制'}
                  </button>
                </div>
                <div className="bg-black/40 rounded-lg p-3 border border-gray-700 max-h-[200px] overflow-y-auto custom-scrollbar">
                  <p className="text-sm text-gray-300 leading-relaxed whitespace-pre-wrap font-mono">
                    {oc.positive}
                  </p>
                </div>
              </div>

              {oc.negative && (
                <div>
                  <label className="text-sm text-gray-400 font-bold block mb-2">负向提示词</label>
                  <div className="bg-black/40 rounded-lg p-3 border border-gray-700 max-h-[100px] overflow-y-auto custom-scrollbar">
                    <p className="text-sm text-gray-300 leading-relaxed whitespace-pre-wrap font-mono">
                      {oc.negative}
                    </p>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="p-4 border-t border-gray-800 bg-gray-900/50 flex gap-3">
          <button
            onClick={onReroll}
            className="flex-1 py-2.5 bg-gray-700 hover:bg-gray-600 text-white rounded-lg transition-all flex items-center justify-center gap-2 font-bold active:scale-95"
          >
            <Sparkles className="w-4 h-4" />
            换一个
          </button>
          <button
            onClick={onAdd}
            className="flex-1 py-2.5 bg-nai-accent hover:bg-nai-accent-hover text-black rounded-lg transition-all flex items-center justify-center gap-2 font-bold shadow-[0_0_10px_rgba(252,237,164,0.3)] active:scale-95"
          >
            <Plus className="w-4 h-4" />
            添加到提示词
          </button>
        </div>
      </div>
    </div>
  );
};

export default OCGalleryTab;
