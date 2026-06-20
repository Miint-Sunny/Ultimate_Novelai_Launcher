// Precise Reference (CR) 管理器 - 类型定义

export interface CRFile {
  id: string;
  name: string;
  preview: string;
}

// 激活的 Precise Reference 项（包含参数配置）
export interface ActivePreciseRef {
  id: string;
  name: string;
  preview: string;
  mode: 'character&style' | 'character' | 'style';
  informationExtracted: number;
  strength: number;
  enabled: boolean;
}

export interface UseCRManagerReturn {
  // Tab & Selection
  crTab: 'public' | 'local';
  setCrTab: (tab: 'public' | 'local') => void;
  selectedCRs: string[];
  setSelectedCRs: React.Dispatch<React.SetStateAction<string[]>>;

  // Data
  crPublicFiles: CRFile[];
  setCrPublicFiles: React.Dispatch<React.SetStateAction<CRFile[]>>;
  crLocalFiles: CRFile[];
  setCrLocalFiles: React.Dispatch<React.SetStateAction<CRFile[]>>;

  // Active Precise Refs
  activePreciseRefs: ActivePreciseRef[];
  setActivePreciseRefs: React.Dispatch<React.SetStateAction<ActivePreciseRef[]>>;

  // Upload / Delete state
  uploadingCRId: string | null;
  deletingCRId: string | null;
  uploadedCRIds: Set<string>;
  crInputRef: React.RefObject<HTMLInputElement | null>;
  quickCRInputRef: React.RefObject<HTMLInputElement | null>;

  // Edit modal state
  crEditModalOpen: boolean;
  setCrEditModalOpen: (v: boolean) => void;
  crEditTarget: CRFile | null;
  setCrEditTarget: (v: CRFile | null) => void;
  crEditName: string;
  setCrEditName: (v: string) => void;
  crEditZhNames: string;
  setCrEditZhNames: (v: string) => void;
  isSavingCREdit: boolean;
  setIsSavingCREdit: (v: boolean) => void;
  crEditIsUpload: boolean;

  // Compat
  activeCR: (CRFile & { fidelity: number; styleAware: boolean }) | null;
  setActiveCR: (cr: (CRFile & { fidelity: number; styleAware: boolean }) | null) => void;

  // Actions
  handleCRUpload: (event: React.ChangeEvent<HTMLInputElement>) => Promise<void>;
  handleToggleCRSelection: (id: string) => void;
  updatePreciseRefParam: (id: string, updates: Partial<ActivePreciseRef>) => void;
  removePreciseRef: (id: string) => void;
  handleDeleteCR: (id: string, e: React.MouseEvent) => Promise<void>;
  handleSaveCREdit: () => Promise<void>;
  handleUploadCRToPublic: (file: CRFile, e: React.MouseEvent) => Promise<void>;
}
