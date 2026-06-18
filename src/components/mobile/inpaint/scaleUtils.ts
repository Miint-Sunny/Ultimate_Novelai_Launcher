// Mobile inpaint 画布缩放计算：根据容器/图片尺寸与扩图模式计算 baseScale。
// 纯函数，无副作用。

export interface ContainerSize {
  width: number;
  height: number;
}

export interface ExpandPadding {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

// 计算 baseScale：在容器可用区域内，让完整图（含扩图 padding）尽量大但不超过 1。
// 扩图模式额外留出按钮边距。容器未测量时返回 0。
export function calculateBaseScale(
  containerSize: ContainerSize,
  imageWidth: number,
  imageHeight: number,
  expandPadding: ExpandPadding,
  isExpandMode: boolean,
): number {
  const { width, height } = containerSize;
  if (width === 0 || height === 0) return 0;
  const maxWidth = width - 16;
  const maxHeight = height - 180;
  // 扩图模式需要更大的边距，留出按钮空间
  const expandModeMargin = isExpandMode ? 80 : 0;
  const availableWidth = maxWidth - expandModeMargin * 2;
  const availableHeight = maxHeight - expandModeMargin * 2;
  const totalW = imageWidth + expandPadding.left + expandPadding.right;
  const totalH = imageHeight + expandPadding.top + expandPadding.bottom;
  return Math.min(availableWidth / totalW, availableHeight / totalH, 1);
}
