/**
 * AIAssistant 内部使用的视图类型。
 *
 * 注意：真正的数据源是 agentService.logs（LogEntry[]）。
 * 这里的 VMsg 是把 LogEntry 适配到原型的 user/ai/error 三态视图模型，
 * 便于 ChatBody 渲染。
 */
import type { AssistantCard, LogEntry, GenerationSnapshot } from '../../../services/agentService';

export type VMsgRole = 'user' | 'ai' | 'error' | 'card';

export interface VMsg {
  /** 在原始 logs 数组中的索引（撤回 / 复制等操作要用） */
  logIndex: number;
  role: VMsgRole;
  /** 显示内容（AI 是带 TAG[[xxx]] 的 thinking 文案；user 是用户输入；error 是错误文本） */
  content: string;
  /** 'HH:mm' 字符串 */
  ts: string;
  /** 用户上传的图片 base64（仅 user） */
  image?: string;
  /** AI 这条 reply 的快照（含 prePositive/preCharacters，用于重试） */
  snapshot?: GenerationSnapshot;
  /** AI 这条 reply 提取出的 tag 数组（来自 snapshot.positive 的逗号分隔） */
  tags?: string[];
  /** 固定指令产出的结果卡片（仅 card） */
  card?: AssistantCard;
}

/**
 * 历史会话条目（本地 localStorage 存档）。
 * 复制了一份 logs 进去，所以"打开"时能把 logs 灌回 agentService。
 */
export interface ArchivedSession {
  id: number;
  title: string;        // 第一条用户消息的前 30 字
  preview: string;      // 最后一条 AI 回复（去 TAG[[]] 后）的前 80 字
  date: string;         // 'M/d HH:mm'
  turns: number;        // user 消息条数
  tagCount: number;     // 总 tag 数（粗算）
  err: boolean;         // 是否含错误
  logs: LogEntry[];     // 原始 logs 副本（用于恢复）
  /** 当前正在进行的会话（非存档），由父组件实时构建并插到列表首位 */
  current?: boolean;
}

export interface PersistedState {
  sessions: ArchivedSession[];
  position: { x: number; y: number } | null;
}
