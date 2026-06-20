/**
 * 蒙板裁切工具 - 计算遮罩区域的裁切矩形
 * 用于减少大图局部重绘的点数消耗
 */

export interface CropRect {
  x: number;      // 裁切区域左上角 x（任意整数，无需 64 对齐）
  y: number;      // 裁切区域左上角 y（任意整数，无需 64 对齐）
  width: number;  // 裁切宽度（任意整数，即用户关心的 tight 区域尺寸）
  height: number; // 裁切高度（任意整数，即用户关心的 tight 区域尺寸）
}

/**
 * 从遮罩画布的 ImageData 中计算裁切矩形（tight 版，不做 64 对齐）
 * - 找到遮罩像素的 bounding box
 * - 添加 padding 以提供上下文
 * - 夹在图像范围内
 *
 * 返回的 CropRect 是"用户想要被重绘并贴回去的精确区域"。
 * 发送给 API 前需要再用 alignSendRect() 扩展成 64 的倍数。
 */
export function calculateCropRect(
  maskImageData: ImageData,
  fullWidth: number,
  fullHeight: number,
  padding: number = 128,
): CropRect | null {
  const { width, height, data } = maskImageData;

  // 扫描遮罩像素的 bounding box
  let minX = width;
  let minY = height;
  let maxX = 0;
  let maxY = 0;
  let found = false;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      if (data[idx] > 0 || data[idx + 1] > 0 || data[idx + 2] > 0 || data[idx + 3] > 0) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        found = true;
      }
    }
  }

  if (!found) return null;

  // 添加 padding，夹在图像范围内
  const x0 = Math.max(0, minX - padding);
  const y0 = Math.max(0, minY - padding);
  const x1 = Math.min(fullWidth, maxX + 1 + padding);
  const y1 = Math.min(fullHeight, maxY + 1 + padding);

  let w = x1 - x0;
  let h = y1 - y0;

  // 最小尺寸 256（确保后续 64 对齐后仍有足够上下文）
  if (w < 256) w = Math.min(256, fullWidth);
  if (h < 256) h = Math.min(256, fullHeight);

  // 起点确保 tight 区域还在图像内
  const x = Math.min(x0, fullWidth - w);
  const y = Math.min(y0, fullHeight - h);

  // 如果 tight 区域和原图差不多大，就不裁切了（节省不了多少）
  if (w >= fullWidth * 0.9 && h >= fullHeight * 0.9) {
    return null;
  }

  return { x, y, width: w, height: h };
}

/**
 * 把 tight CropRect 扩展成 64 对齐（API 的硬要求）。
 * - width/height 向上取整到 64 的倍数
 * - 若右/下超出原图，则向左/上平移起点
 * - 若超大（原图本身 < 64 倍数扩展后的尺寸），尺寸向下夹回原图可用区域
 *
 * 返回的 sendRect 就是给 NovelAI 的 width/height 以及从原图/遮罩上截取的源矩形。
 */
export function alignSendRect(
  rect: CropRect,
  fullWidth: number,
  fullHeight: number,
): CropRect {
  let sendW = Math.ceil(rect.width / 64) * 64;
  let sendH = Math.ceil(rect.height / 64) * 64;

  // 超过原图上限时，夹回 floor(原图/64)*64
  if (sendW > fullWidth) sendW = Math.max(64, Math.floor(fullWidth / 64) * 64);
  if (sendH > fullHeight) sendH = Math.max(64, Math.floor(fullHeight / 64) * 64);

  // 右/下越界时把起点向左/上平移
  let x = rect.x;
  let y = rect.y;
  if (x + sendW > fullWidth) x = Math.max(0, fullWidth - sendW);
  if (y + sendH > fullHeight) y = Math.max(0, fullHeight - sendH);

  return { x, y, width: sendW, height: sendH };
}
