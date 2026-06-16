/**
 * Vibe 云同步首次启用引导
 *
 * 探测条件（A 或 B 任一为真就弹）：
 *   A. localStorage 没有 vibe_sync_v2_onboarded 标记 → 全新装机
 *   B. 本地有 vibe 但没有任何一个有 cloudFilename → 老用户从未启用过云同步
 *
 * 用户操作：
 *   - 跳过 → 写 'skipped'，永久不再弹（除非走"重新初始化"入口手动清除）
 *   - 完成首次同步 → 写 'done'
 */

const STORAGE_KEY = 'vibe_sync_v2_onboarded';

export type OnboardingState = 'unset' | 'skipped' | 'done';

export function getOnboardingState(): OnboardingState {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === 'skipped' || v === 'done') return v;
    return 'unset';
  } catch {
    return 'unset';
  }
}

export function setOnboardingState(state: 'skipped' | 'done'): void {
  try {
    localStorage.setItem(STORAGE_KEY, state);
  } catch { /* ignore */ }
}

/** 强制清除标记，下次进入会再弹一次（"重新初始化云同步"入口用） */
export function resetOnboarding(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch { /* ignore */ }
}

/**
 * 综合 A + B 探测：是否应该弹欢迎弹窗
 *
 * 调用方需要传入本地 vibe 数量与"已关联云端的 vibe 数量"，
 * 由调用方负责查询（避免本服务依赖 storage 层造成循环）
 */
export function shouldShowOnboarding(
  localVibeCount: number,
  cloudLinkedCount: number
): boolean {
  const state = getOnboardingState();
  if (state !== 'unset') return false;

  // 条件 A：从未做过任何 onboarding（unset 已经满足）
  // 条件 B：本地有 vibe 但完全没关联过云端 → 老用户也要弹
  // 实际上 unset 状态本身就足够触发，B 是用来避免"全新且空库"的用户也被打扰：
  //   - 如果本地一个 vibe 都没有 → 暂时不弹，等用户至少导入一个再弹
  //   - 否则就弹
  if (localVibeCount === 0 && cloudLinkedCount === 0) {
    return false;
  }
  return true;
}
