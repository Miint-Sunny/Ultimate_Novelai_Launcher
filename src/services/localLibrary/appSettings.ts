import { DEFAULT_WATERMARK_CONFIG, normalizeWatermarkConfig, type WatermarkConfig } from '../watermark/types.ts';
import { normalizeLibraryPane, normalizePromptLayout, restoreSidebarTab, type LibraryPane, type PromptLayout, type SidebarTab } from '../../utils/sidebarTabs';

const APP_SETTINGS_KEY = 'novelai_app_settings';
export const APP_SETTINGS_CHANGED_EVENT = 'app-settings-changed';

export const THEME_OPTIONS = [
  { id: 'default', name: '石墨', color: '#26282a' },
  { id: 'classic', name: '经典蓝', color: '#232736' },
  { id: 'obsidian', name: '曜黑', color: '#1c1c1e' },
];

export type AutocompleteSourceId = 'artists' | 'ocs' | 'characters' | 'origins' | 'danbooru' | 'aiRecommend' | 'nl';

/**
 * 补全里「标签」一栏的来源。用户要三个来源并存、能切着比:
 * danbooru = 原来的 Danbooru 补全;official = NovelAI 官方联想;dictionary = 离线词典(带中文释义)。
 * 后两个走 sidecar 的 GET /api/v1/tags/suggest。
 */
export type TagSuggestSource = 'danbooru' | 'official' | 'dictionary';

export interface AutocompleteSourceConfig {
  id: AutocompleteSourceId;
  enabled: boolean;
  maxCount?: number;
  scope?: 'mine' | 'all';
}

export const DEFAULT_AUTOCOMPLETE_SOURCES: AutocompleteSourceConfig[] = [
  { id: 'nl', enabled: true },
  { id: 'artists', enabled: true, maxCount: 20, scope: 'all' },
  { id: 'ocs', enabled: true, maxCount: 20, scope: 'all' },
  { id: 'characters', enabled: true, maxCount: 20 },
  { id: 'origins', enabled: false, maxCount: 20 },
  { id: 'danbooru', enabled: true, maxCount: 20 },
  { id: 'aiRecommend', enabled: true, maxCount: 20 },
];

export interface AppSettings {
  theme: string;
  aiMode: 'public' | 'custom';
  aiBaseUrl: string;
  aiApiKey: string;
  translateModel: string;
  autocompleteModel: string;
  backendUrl: string;
  serverMode: 'public' | 'custom';
  queueEnabled: boolean;
  queueServerUrl: string;
  loginMode: 'token' | 'bot';
  autocompleteEnabled: boolean;
  autocompleteChineseEnabled: boolean;
  autocompleteShowWiki: boolean;
  autocompleteSortOrder: 'count' | 'prefix-first';
  autocompleteSources: AutocompleteSourceConfig[];
  tagSuggestSource: TagSuggestSource;
  upscaleModelPrecision: 'fp16' | 'fp32';
  aiMaxContextLength: number;
  aiPrisonBreakEnabled: boolean;
  kktServerMode: 'public' | 'custom';
  kktServerUrl: string;
  enterBehavior: 'default' | 'generate';
  /**
   * 浏览器模式下 sidecar 的地址。空 = 用构建期的 VITE_SIDECAR_URL 或默认端口。
   *
   * 桌面壳不看这一项 —— 它从 Tauri 握手拿到真实端点。这一项只服务浏览器:
   * sidecar 跑在**临时端口**上,而浏览器没有握手通道,不填就只能撞默认端口。
   * 填了也仍然要走配对码,鉴权闸没有被绕开。
   */
  sidecarUrl: string;
  weightPresets: number[];
  /**
   * Agent 权限模式(契约 §5.2):manual 逐项确认 / auto 自动应用写类 / yolo 硬上限内放行。
   * 新键,默认 auto;不动旧键。
   */
  agentPermissionMode: 'manual' | 'auto' | 'yolo';
  /** 单条用户消息的 Anlas 预算;0 = 只放行免费生成(契约 §5.3)。 */
  agentAnlasBudget: number;
  /** 单条用户消息内的生成次数上限。 */
  agentMaxGenerations: number;
  /** 左栏当前 tab(提示词 / 参数 / 参考 / 库);读档时库不还原。方案见 docs_and_plan/2026-09-20-left-sidebar-tabs-proposal.md。 */
  leftSidebarTab: SidebarTab;
  /** 库 tab 里上次看的子页。 */
  leftSidebarLibraryPane: LibraryPane;
  /** 提示词排法:分页(提示 / 排除切换)或堆叠(两栏同时可见)。和芯片 / 文本编辑器正交,合起来四种。 */
  promptLayout: PromptLayout;
  /**
   * 导出水印(可见 logo + DCT 盲水印),照 Novelai-harness 的导出管道:保存 / 复制 / 打包时
   * 在 `processImageForSave` 里应用。默认全关;logo 存 data URL。
   */
  watermark: WatermarkConfig;
}

export const DEFAULT_APP_SETTINGS: AppSettings = {
  theme: 'default',
  aiMode: 'public',
  aiBaseUrl: '',
  aiApiKey: '',
  translateModel: 'gemini-2.5-flash-lite',
  autocompleteModel: 'gemini-2.5-flash-lite',
  backendUrl: '',
  serverMode: 'public',
  queueEnabled: false,
  queueServerUrl: '',
  loginMode: 'token',
  autocompleteEnabled: true,
  autocompleteChineseEnabled: true,
  autocompleteShowWiki: true,
  autocompleteSortOrder: 'prefix-first',
  autocompleteSources: DEFAULT_AUTOCOMPLETE_SOURCES,
  tagSuggestSource: 'danbooru',
  upscaleModelPrecision: 'fp16',
  agentPermissionMode: 'auto',
  agentAnlasBudget: 0,
  agentMaxGenerations: 3,
  leftSidebarTab: 'prompt',
  leftSidebarLibraryPane: 'tags',
  promptLayout: 'tabbed',
  aiMaxContextLength: 30,
  aiPrisonBreakEnabled: true,
  kktServerMode: 'public',
  kktServerUrl: 'https://nai.sora214.top',
  enterBehavior: 'default',
  sidecarUrl: '',
  weightPresets: [-1, 0.5, 0.8, 1.5, 2.0],
  watermark: DEFAULT_WATERMARK_CONFIG,
};

const sanitizeAppSettings = (settings: AppSettings): AppSettings => ({
  ...settings,
  aiApiKey: '',
});

export const saveAppSettings = (settings: AppSettings): void => {
  localStorage.setItem(APP_SETTINGS_KEY, JSON.stringify(sanitizeAppSettings(settings)));
  window.dispatchEvent(new Event(APP_SETTINGS_CHANGED_EVENT));
};

export const getAppSettings = (): AppSettings => {
  const stored = localStorage.getItem(APP_SETTINGS_KEY);
  let settings: AppSettings;
  let shouldRewriteSettings = false;

  if (stored) {
    try {
      const parsed = JSON.parse(stored);
      shouldRewriteSettings = Boolean(parsed.aiApiKey);
      settings = sanitizeAppSettings({ ...DEFAULT_APP_SETTINGS, ...parsed });
    } catch {
      settings = sanitizeAppSettings(DEFAULT_APP_SETTINGS);
      shouldRewriteSettings = true;
    }
  } else {
    settings = sanitizeAppSettings(DEFAULT_APP_SETTINGS);
  }

  if (stored && shouldRewriteSettings) {
    localStorage.setItem(APP_SETTINGS_KEY, JSON.stringify(settings));
  }

  const oldDefaultWeightPresets = [0.5, 0.8, 1.2, 1.5, 2.0];
  if (JSON.stringify(settings.weightPresets) === JSON.stringify(oldDefaultWeightPresets)) {
    settings = { ...settings, weightPresets: DEFAULT_APP_SETTINGS.weightPresets };
    localStorage.setItem(APP_SETTINGS_KEY, JSON.stringify(settings));
  }

  settings.autocompleteSources = DEFAULT_AUTOCOMPLETE_SOURCES;
  // 旧设置没有这一键,或者存了半截:一律整理成合法配置,坏值回默认而不是让导出炸掉
  settings.watermark = normalizeWatermarkConfig(settings.watermark);
  settings.leftSidebarTab = restoreSidebarTab(settings.leftSidebarTab);
  settings.leftSidebarLibraryPane = normalizeLibraryPane(settings.leftSidebarLibraryPane);
  settings.promptLayout = normalizePromptLayout(settings.promptLayout);
  return settings;
};
