/**
 * AI 助手浮窗入口（V2 重设计版）。
 *
 * 真正的实现已经拆到同目录 ./AIAssistant/，这里只做 re-export，
 * 保持外部 import 路径（如 LeftSidebar.tsx）不动。
 *
 * 设计来源 / 验收 spec：
 *   原型与文档：design_handoff_ai_assistant/{README.md,prototype.jsx,ai-tokens.css}
 *   （仓库外的 handoff bundle，存档于设计师交付时）
 */
export { DraggableAIAssistant } from './AIAssistant';
export type { DraggableAIAssistantProps } from './AIAssistant';
