// OC管理器 - 类型定义

export interface OCFile {
  id: string;
  name: string;
  preview: string;
  positive: string;
  negative: string;
  aliases?: string[];  // 别名列表
  user?: string;
  created_by?: string;
  created_at?: number;
  /** 本地副本对应的公共 OC id (仅 origin='favorited' 时填) - 用于精确链接,对齐 ArtistFile */
  publicId?: string;
  /** 本地 OC 的来源标记 - 决定编辑/保存路径 */
  origin?: 'local' | 'favorited' | 'created';
}

// useOCManager hook 的返回类型
export interface UseOCManagerReturn {
  // 状态
  ocTab: 'public' | 'local';
  setOcTab: (tab: 'public' | 'local') => void;
  selectedOCs: string[];
  setSelectedOCs: React.Dispatch<React.SetStateAction<string[]>>;
  justSelectedOCId: string | null;
  setJustSelectedOCId: (id: string | null) => void;
  ocPublicFiles: OCFile[];
  setOcPublicFiles: React.Dispatch<React.SetStateAction<OCFile[]>>;
  ocLocalFiles: OCFile[];
  setOcLocalFiles: React.Dispatch<React.SetStateAction<OCFile[]>>;
  isLoadingPublicOCs: boolean;
  setIsLoadingPublicOCs: React.Dispatch<React.SetStateAction<boolean>>;

  // 创建/编辑
  isCreatingOC: boolean;
  setIsCreatingOC: (v: boolean) => void;
  editingOCId: string | null;
  newOCName: string;
  setNewOCName: (v: string) => void;
  newOCPositive: string;
  setNewOCPositive: (v: string) => void;
  newOCAliases: string;
  setNewOCAliases: (v: string) => void;
  newOCPreview: string | null;
  newOCCreatedBy: string;
  setNewOCCreatedBy: (v: string) => void;
  newOCCreatedAt: string;
  setNewOCCreatedAt: (v: string) => void;
  isGeneratingOCPreview: boolean;
  isSavingOC: boolean;
  copiedOCId: string | null;
  setCopiedOCId: (v: string | null) => void;
  savedToLocalOCId: string | null;

  // 操作
  openOCDetail: (oc: OCFile) => void;
  openCreateOC: () => void;
  handleGenerateOCPreview: () => Promise<void>;
  generatePreviewBase64: (positive: string, onProgress?: (step: number, total: number) => void) => Promise<string | null>;
  handleSaveOC: (target?: 'public' | 'local') => Promise<void>;
  saveOCFromPayload: (
    payload: {
      name: string;
      positive: string;
      negative?: string;
      aliases?: string[];
      previews: string[];
    },
    target: 'public' | 'local',
  ) => Promise<{ success: boolean; message?: string; id?: string }>;
  updateOCFromPayload: (
    id: string,
    payload: {
      name: string;
      positive: string;
      negative?: string;
      aliases?: string[];
      previews: string[];
    },
    origin: 'local' | 'favorited' | 'created',
  ) => Promise<{ success: boolean; message?: string }>;
  /** 把公共 OC 另存为本地副本 (改了 prompt/name/preview 后保存走这里);同名冲突自动加「(副本)」后缀
   *  mode='favorited' (默认): 收藏别人 OC 的 fork,保留 publicId 链接;mode='detached': 自己发布的 OC fork 一份脱钩本地版 */
  forkOCToLocal: (
    sourcePublicId: string,
    payload: {
      name: string;
      positive: string;
      negative?: string;
      aliases?: string[];
      previews: string[];
    },
    mode?: 'favorited' | 'detached',
  ) => Promise<{ success: boolean; message?: string; localId?: string; finalName?: string }>;
  handleDeleteOC: (id: string, e: React.MouseEvent) => Promise<void>;
  /** 仅删本地副本(按 local id),不动公共条目 - 用于"删公共时连带清本地副本"场景 */
  deleteOCLocalCopy: (localId: string) => Promise<void>;
  /** 撤回发布: 删公共,把对应 created 本地副本转为纯本地保留 (id 重新分配,origin/publicId 清掉) */
  unpublishOC: (publicId: string) => Promise<{ success: boolean; message?: string }>;
  /** 彻底删除: 删公共 + 删 origin='created' 本地副本 (fork 副本不动) */
  deletePublicOCTotally: (publicId: string) => Promise<{ success: boolean; message?: string }>;
  toggleOCSelection: (id: string) => void;
  handleRandomOC: () => void;
  handleSaveOCToLocal: (file: OCFile, e: React.MouseEvent) => Promise<void>;
  refreshPublicOCs: () => Promise<void>;
}
