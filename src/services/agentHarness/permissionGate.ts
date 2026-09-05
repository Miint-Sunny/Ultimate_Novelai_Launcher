/**
 * 权限闸(契约 §5)。两层叠加:能力(预设白名单决定工具在不在 `tools` 里——那是
 * harness 组装时的事,闸不管)与模式(做之前要不要问)。
 *
 * 任何模式都绕不过的硬上限在这里:每条消息的生成次数、Anlas 预算、体力条耗尽时
 * P 类一律确认、用户锁定字段一律拒绝。
 */

import type { AgentTool, ToolContext } from './toolRegistry';
import type { CostEstimate, PermissionClass, PermissionMode } from './types';

export interface PermissionLimits {
  /** 单条用户消息内的生成次数上限(默认 3;yolo 也算)。 */
  maxGenerationsPerMessage: number;
  /** 单条用户消息的 Anlas 预算(默认 0 = 只放行免费的生成)。 */
  anlasBudget: number;
}

export const DEFAULT_PERMISSION_LIMITS: PermissionLimits = {
  maxGenerationsPerMessage: 3,
  anlasBudget: 0,
};

export interface GateContext extends ToolContext {
  mode: PermissionMode;
  limits: PermissionLimits;
  /** 宿主体力条耗尽(钱包闸):P 类一律确认。 */
  opusExhausted: boolean;
}

export type GateVerdict =
  | { kind: 'allow' }
  | { kind: 'ask'; summary: string; cost?: CostEstimate }
  | { kind: 'deny'; reason: string };

/** 拒绝回给模型的固定文案(契约 §5.4)。 */
export function denialToolText(toolName: string, reason?: string): string {
  return `用户拒绝了 ${toolName}:${reason?.trim() || '未说明'}。不要重复尝试同一操作,先向用户确认。`;
}

export function lockedFieldsToolText(fields: readonly string[]): string {
  return `以下字段被用户锁定,任何模式下都不能修改:${fields.join('、')}。请保留这些字段,只改其余部分,或先向用户确认。`;
}

/** 每条用户消息内的计数与「本轮同类放行」记录;每次 send 重建。 */
export class MessageBudget {
  generations = 0;
  private readonly classAllowed = new Set<PermissionClass>();

  allowClass(cls: PermissionClass): void {
    this.classAllowed.add(cls);
  }

  isClassAllowed(cls: PermissionClass): boolean {
    return this.classAllowed.has(cls);
  }
}

function modeAllows(mode: PermissionMode, cls: PermissionClass): 'allow' | 'ask' {
  if (cls === 'R' || cls === 'A') return 'allow';
  if (mode === 'yolo') return 'allow';
  if (mode === 'auto') return cls === 'W' ? 'allow' : 'ask';
  return 'ask';
}

export async function checkPermission(
  tool: AgentTool,
  args: Record<string, unknown>,
  ctx: GateContext,
  budget: MessageBudget,
): Promise<GateVerdict> {
  // 参数锁:任何模式都拒绝,不问。
  if (tool.writesFields) {
    const locked = tool.writesFields(args).filter((field) => ctx.lockedFields.has(field));
    if (locked.length > 0) return { kind: 'deny', reason: lockedFieldsToolText(locked) };
  }
  // 生成次数上限:到顶就拒绝,yolo 也一样。
  if (tool.countsAsGeneration && budget.generations >= ctx.limits.maxGenerationsPerMessage) {
    return {
      kind: 'deny',
      reason: `本条消息的生成次数已达上限(${ctx.limits.maxGenerationsPerMessage} 次)。请把结果交给用户,等用户再发一条消息。`,
    };
  }

  const cls = tool.permissionClass;
  let cost: CostEstimate | undefined;
  if (cls === 'P' && tool.estimateCost) cost = await tool.estimateCost(args, ctx);

  let verdict = modeAllows(ctx.mode, cls);
  if (cls === 'P') {
    // 钱包闸:体力条耗尽,或估价超出预算,任何模式都要问。
    const overBudget = cost ? !cost.free && cost.anlas > ctx.limits.anlasBudget : true;
    if (ctx.opusExhausted || overBudget) verdict = 'ask';
  }
  if (verdict === 'ask' && budget.isClassAllowed(cls)) verdict = 'allow';
  if (verdict === 'allow') return { kind: 'allow' };

  const summary = tool.describeChange
    ? await tool.describeChange(args, ctx)
    : cost
      ? `${tool.label}:${cost.free ? '免费' : `约 ${cost.anlas} Anlas`}${cost.note ? `(${cost.note})` : ''}`
      : `${tool.label}`;
  return { kind: 'ask', summary, cost };
}
