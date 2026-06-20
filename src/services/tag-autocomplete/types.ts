// 标签自动补全共享类型

export interface TagWikiPreviewExample {
  type: 'post' | 'asset';
  id: number;
  previewUrl?: string;
  pageUrl: string;
  width?: number;
  height?: number;
}

export interface TagWikiPreview {
  hasWiki: boolean;
  title: string;
  otherNames: string[];
  summary: string;
  summaryZh?: string;
  body: string;
  example?: TagWikiPreviewExample | null;
  examples?: TagWikiPreviewExample[];
}

export interface TagSuggestion {
  value: string;        // 英文tag（用于插入）
  label: string;        // 显示的主标签名
  chineseName?: string; // 中文翻译（显示在第二行）
  postCount?: number;   // 引用数
  category?: string;    // 分类/出处
  source?: 'danbooru' | 'local';
  isOrigin?: boolean;   // 是否为出处（作品）匹配
  originCharCount?: number; // 该出处下的角色数量
  originCharacters?: string[]; // 该出处下的所有角色英文名
  isNaturalLanguage?: boolean; // 是否为"转换自然语言"特殊选项
  verified?: boolean;   // D站验证是否完成（true=已验证，undefined=未验证/验证中）
  // 画师串相关
  isArtist?: boolean;   // 是否为画师串
  artistContent?: string; // 画师串的实际内容（用于插入）
  // OC相关
  isOC?: boolean;       // 是否为OC
  ocContent?: string;   // OC的tag_group内容（用于插入）
  // AI加载占位
  isAiLoading?: boolean; // AI推荐加载中占位项
  // AI 来源标签（用于按来源分类与排序）
  isAiDirect?: boolean;  // AI 直译结果（中文整句→单 tag）
  isAiRecommend?: boolean; // AI 推荐结果（中文查询→多 tag）
  hasWiki?: boolean;
}
