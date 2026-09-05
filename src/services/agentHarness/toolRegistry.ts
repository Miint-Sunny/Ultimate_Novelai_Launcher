import type { CostEstimate, PermissionClass, ToolResult } from './types';

/** 工具执行时能拿到的上下文。具体字段由工作台适配层填。 */
export interface ToolContext {
  /** 当前发送轮次(imageEpoch 用)。 */
  sendEpoch: number;
  /** 用户锁定的工作台字段(参数锁,契约 §5.3)。 */
  lockedFields: ReadonlySet<string>;
}

/**
 * Agent 工具。`name` / `description` / `parameters` 逐字抄他的(MIT),
 * 因为他的技能文本里点名了这些工具名。`permissionClass` 是我们加的(契约 §5.1)。
 */
export interface AgentTool {
  name: string;
  label: string;
  description: string;
  parameters: Record<string, unknown>;
  permissionClass: PermissionClass;
  /** 生成类工具:计入「每条消息最多 N 次生成」。 */
  countsAsGeneration?: boolean;
  /** 付费类工具的估价(闸据此决定问不问)。 */
  estimateCost?: (args: Record<string, unknown>, ctx: ToolContext) => CostEstimate | Promise<CostEstimate>;
  /** 写类工具:这次调用会改哪些字段(参数锁据此拦)。 */
  writesFields?: (args: Record<string, unknown>) => string[];
  /** 给确认卡片看的摘要(W:字段 diff;D:将删除的对象)。 */
  describeChange?: (args: Record<string, unknown>, ctx: ToolContext) => string | Promise<string>;
  execute: (toolCallId: string, args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>;
}

export function toolToOpenAiFunction(tool: AgentTool) {
  return {
    type: 'function' as const,
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  };
}

export class ToolRegistry {
  private readonly tools = new Map<string, AgentTool>();

  register(tool: AgentTool): void {
    this.tools.set(tool.name, tool);
  }

  registerAll(tools: readonly AgentTool[]): void {
    for (const tool of tools) this.register(tool);
  }

  get(name: string): AgentTool | undefined {
    return this.tools.get(name);
  }

  getAll(): AgentTool[] {
    return [...this.tools.values()];
  }

  get names(): string[] {
    return [...this.tools.keys()];
  }
}

/** 统一的工具错误结果。 */
export function toolError(toolCallId: string, toolName: string, content: string): ToolResult {
  return { toolCallId, toolName, content, isError: true };
}
