// 画师串管理器 - 类型定义
import React from 'react';

export type ArtistOrigin = 'local' | 'favorited' | 'created';

export interface ArtistFile {
  id: string;
  name: string;
  previews: string[];
  prompt: string;
  negative?: string;
  usageCount?: number;
  createdTime?: number;
  createdTimeStr?: string;
  addedBy?: string | null;
  isLocal?: boolean;
  origin?: ArtistOrigin;    // 本地创建 / 公共收藏 / 我发布的公共串
  publicId?: string;         // 关联的公共库 ID
  tags?: string[];           // 用户自定义标签
}

export interface ArtistPreviewProgress {
  current: number;
  total: number;
}

// useArtistManager hook 的返回类型
export interface UseArtistManagerReturn {
  // 状态
  artistTab: 'public' | 'local';
  setArtistTab: (tab: 'public' | 'local') => void;
  searchQuery: string;
  setSearchQuery: (query: string) => void;
  selectedArtistIds: string[];
  artistPublicFiles: ArtistFile[];
  artistLocalFiles: ArtistFile[];
  isLoadingPublicArtists: boolean;
  editorArtistTags: { label: string; content: string }[];
  artistUsageOrder: string[];
  updateArtistUsageOrder: (ids: string[]) => void;
  localArtistSource: 'all' | 'local' | 'favorited' | 'created';
  setLocalArtistSource: (source: 'all' | 'local' | 'favorited' | 'created') => void;
  // 标签系统
  artistTagPool: string[];
  selectedTagFilter: Set<string>;
  setSelectedTagFilter: React.Dispatch<React.SetStateAction<Set<string>>>;
  reloadArtistTagPool: () => void;
  saveArtistTags: (artistId: string, tags: string[]) => Promise<void>;
  saveArtistTagPool: (pool: string[]) => void;

  // 懒加载
  artistPublicDisplayCount: number;
  setArtistPublicDisplayCount: React.Dispatch<React.SetStateAction<number>>;
  artistLocalDisplayCount: number;
  isLoadingMoreArtists: boolean;
  artistPublicScrollRef: React.RefObject<HTMLDivElement | null>;
  artistLocalScrollRef: React.RefObject<HTMLDivElement | null>;
  artistPublicScrollTopRef: React.MutableRefObject<number>;
  artistLocalScrollTopRef: React.MutableRefObject<number>;
  handleArtistScroll: (e: React.UIEvent<HTMLDivElement>, isPublic: boolean) => void;

  // 选择
  toggleArtistSelection: (id: string) => void;
  handleClearArtistSelection: () => void;

  // 创建/编辑状态
  isCreatingArtist: boolean;
  setIsCreatingArtist: (v: boolean) => void;
  editingArtistId: string | null;
  newArtistName: string;
  setNewArtistName: (v: string) => void;
  newArtistPrompt: string;
  newArtistPreviews: string[];
  setNewArtistPreviews: React.Dispatch<React.SetStateAction<string[]>>;
  newArtistTags: Set<string>;
  setNewArtistTags: React.Dispatch<React.SetStateAction<Set<string>>>;
  selectedArtistCoverIndex: number;
  setSelectedArtistCoverIndex: (v: number) => void;
  isGeneratingArtistPreviews: boolean;
  artistPreviewProgress: ArtistPreviewProgress | null;
  copiedArtistId: string | null;
  setCopiedArtistId: (v: string | null) => void;
  savedArtistId: string | null;
  setSavedArtistId: (v: string | null) => void;
  isSavingArtist: boolean;

  // 操作
  loadPublicArtists: (forceRefresh?: boolean) => Promise<void>;
  loadLocalArtists: () => Promise<void>;
  openArtistDetail: (artist: ArtistFile) => void;
  openCreateArtist: () => void;
  handleArtistPromptChange: (value: string) => void;
  handleGenerateSingleArtistPreview: () => Promise<void>;
  handleRegenerateArtistPreviewAt: (index: number) => Promise<void>;
  handleRegenerateAllArtistPreviews: () => Promise<void>;
  handleGenerateArtistPreview: () => Promise<void>;
  handleSaveArtist: (target?: 'public' | 'local') => Promise<void>;
  saveArtistFromPayload: (
    payload: {
      name: string;
      positive: string;
      negative?: string;
      previews: string[];
      tags?: string[];
    },
    target: 'public' | 'local',
  ) => Promise<{ success: boolean; message?: string; id?: string }>;
  updateArtistFromPayload: (
    id: string,
    payload: {
      name: string;
      positive: string;
      negative?: string;
      previews: string[];
      tags?: string[];
    },
    origin: 'local' | 'favorited' | 'created',
  ) => Promise<{ success: boolean; message?: string }>;
  generatePreviewBase64: (positive: string, index: number, onProgress?: (step: number, total: number) => void) => Promise<string | null>;
  handleDeleteArtist: (id: string, e?: React.MouseEvent) => Promise<void>;

  // 标签同步
  handleTagsChange: (tags: { id: string; type: string; label: string; content: string; collapsed: boolean }[]) => void;

  // 保存到本地（公共卡片上的快捷操作）
  savePublicToLocal: (file: ArtistFile) => Promise<void>;

  // 新增操作
  unfavoriteArtist: (id: string) => Promise<void>;
  createLocalCopy: (file: ArtistFile) => Promise<void>;
  /** 从公共画师串另存为脱钩本地副本 (origin='local',无 publicId) - 编辑表单的「保存为本地副本」用 */
  forkArtistToLocal: (
    sourcePublicId: string,
    payload: { name: string; positive: string; negative?: string; previews: string[]; tags?: string[] },
  ) => Promise<{ success: boolean; message?: string; localId?: string; finalName?: string }>;
  /** 撤回发布: 删公共,把 origin='created' 本地副本转为纯本地保留 (id 重新分配) */
  unpublishArtist: (publicId: string) => Promise<{ success: boolean; message?: string }>;
  /** 彻底删除: 删公共 + 删 origin='created' 本地副本 (fork 副本不动) */
  deletePublicArtistTotally: (publicId: string) => Promise<{ success: boolean; message?: string }>;
  uploadToPublic: (file: ArtistFile) => Promise<void>;
}
