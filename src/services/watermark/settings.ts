/**
 * 导出管道读水印设置的唯一入口:设置页写 `appSettings.watermark`,这里读出来并归一化。
 * 解析失败一律回默认(关闭),导出永远不会因为一条坏配置而失败。
 */

import { getAppSettings } from '../localLibrary/appSettings.ts';
import { DEFAULT_WATERMARK_CONFIG, normalizeWatermarkConfig, type WatermarkConfig } from './types.ts';

export function resolveWatermarkExportSettings(): WatermarkConfig {
  try {
    return normalizeWatermarkConfig(getAppSettings().watermark);
  } catch {
    return { ...DEFAULT_WATERMARK_CONFIG };
  }
}
