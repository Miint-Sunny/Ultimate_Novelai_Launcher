/** ask_user:结构化提问。参数校验规则照抄他的 parseQuestions。 */

import { toolError, type AgentTool } from '../toolRegistry';
import type { AgentQuestion } from '../workbench';
import type { ToolDeps } from './deps';

export function parseQuestions(args: Record<string, unknown>): AgentQuestion[] | null {
  const raw = args.questions;
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 4) return null;
  const questions: AgentQuestion[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') return null;
    const q = item as Record<string, unknown>;
    if (typeof q.question !== 'string' || !q.question.trim()) return null;
    const rawOptions = q.options;
    if (!Array.isArray(rawOptions) || rawOptions.length < 2 || rawOptions.length > 4) return null;
    const options = [];
    for (const rawOption of rawOptions) {
      // Models often send bare strings for options; treat them as label-only entries.
      const o: Record<string, unknown> = typeof rawOption === 'string' ? { label: rawOption } : (rawOption as Record<string, unknown>);
      if (!o || typeof o !== 'object') return null;
      if (typeof o.label !== 'string' || !o.label.trim()) return null;
      options.push({ label: o.label.trim(), description: typeof o.description === 'string' ? o.description : undefined });
    }
    questions.push({
      question: q.question.trim(),
      header: typeof q.header === 'string' && q.header.trim() ? q.header.trim() : undefined,
      multiSelect: q.multiSelect === true,
      allowCustomInput: q.allowCustomInput !== false,
      options,
    });
  }
  return questions;
}

export function createAskUserTool(deps: ToolDeps): AgentTool {
  const tool: AgentTool = {
    name: 'ask_user',
    label: '向用户提问',
    description: '向用户提出结构化问题以澄清需求或收集偏好。适合在关键决策点使用,例如确认画面主题、风格方向、构图取舍等。一次最多 4 个问题,每个问题提供 2-4 个互斥选项 (multiSelect 为 true 时可多选),用户也可以输入自定义回答。不要在每轮对话都用,只在信息不足以继续时使用。',
    parameters: {
      type: 'object',
      properties: {
        questions: {
          type: 'array', minItems: 1, maxItems: 4, description: '要提出的问题列表',
          items: {
            type: 'object',
            properties: {
              question: { type: 'string', description: '完整的问题描述,以问号结尾' },
              header: { type: 'string', description: '问题的简短标签,最多 16 个字符' },
              multiSelect: { type: 'boolean', description: '是否允许多选,默认 false' },
              options: {
                type: 'array', minItems: 2, maxItems: 4, description: '问题的候选项',
                items: {
                  type: 'object',
                  properties: {
                    label: { type: 'string', description: '选项名称,简洁明确 (1-5 个词)' },
                    description: { type: 'string', description: '选项的补充说明或取舍提示' },
                  },
                  required: ['label'],
                },
              },
            },
            required: ['question', 'options'],
          },
        },
      },
      required: ['questions'],
    },
    permissionClass: 'A',
    execute: async (toolCallId, args) => {
      const questions = parseQuestions(args);
      if (!questions) return toolError(toolCallId, tool.name, '参数不合法: questions 必须是 1-4 个问题,每个问题包含 question 字段和 2-4 个带 label 的选项。');
      const answers = await deps.adapter.askUser(questions);
      if (!answers) return toolError(toolCallId, tool.name, '用户取消了本次问询,未提供回答。请基于现有信息继续,或稍后重新询问。');
      return { toolCallId, toolName: tool.name, content: questions.map((q, i) => `问题: ${q.question}\n回答: ${answers[i] ?? ''}`).join('\n\n') };
    },
  };
  return tool;
}
