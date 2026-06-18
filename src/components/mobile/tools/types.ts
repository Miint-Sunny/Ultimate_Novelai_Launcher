import type { ImageMetadata } from '../../../utils/imageMetadata';

// Mobile tools 共享类型。从父页面 MobileToolsPage 迁出，避免子模块 MobileMetadataDetail
// 反向依赖父页面（结构上的循环依赖隐患）。

export interface MetadataFile {
  name: string;
  dataUrl: string;
  metadata: ImageMetadata | null;
  isSelected: boolean;
  fileSize: number;
}
