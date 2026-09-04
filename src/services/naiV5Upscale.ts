/**
 * V5 扩散超分的尺寸与计价(2026-09-04 真号实测 + 黑板 #8 契约)。
 *
 * - 只剩这一条超分路径:传统 `{image,width,height,scale}` 在 image. 与 api. 两个主机上
 *   都已打不通(前者只认 V5 形状,后者路由不存在)。
 * - 固定 2×:结果 = 边长先向下对齐到 16 的倍数再 ×2。**输出没有总像素上限**
 *   (实测 1400×1200 → 2784×2400),上限只卡源图一侧。
 * - 计费按**源图**像素查表扣 Anlas(实测 1024² 扣 1 点,体力条不动),超过 3,145,728
 *   官方不受理。
 */

export const V5_UPSCALE_MAX_SOURCE_PIXELS = 3_145_728;

/** 官方只允许这两个模型做 standalone upscaling;两份参考实现都硬编码 curated。 */
export const V5_UPSCALE_DEFAULT_MODEL = 'nai-diffusion-5-curated';

export function v5UpscaleTargetSize(width: number, height: number): { width: number; height: number } {
  return {
    width: Math.floor(width / 16) * 16 * 2,
    height: Math.floor(height / 16) * 16 * 2,
  };
}

/** 按源图像素查表;超过上限返回 null(不可用),不要猜一个数。 */
export function v5UpscaleCost(width: number, height: number): number | null {
  const pixels = width * height;
  if (pixels <= 0) return null;
  if (pixels <= 1_048_576) return 1;
  if (pixels <= 1_747_627) return 2;
  if (pixels <= 2_446_678) return 3;
  if (pixels <= V5_UPSCALE_MAX_SOURCE_PIXELS) return 4;
  return null;
}

export function v5UpscaleAvailable(width: number, height: number): boolean {
  return width >= 16 && height >= 16 && v5UpscaleCost(width, height) !== null;
}
