// 权重转换：实现已统一到 src/utils/weightConversion.tsx（桌面/移动共用）。
// 保留 mobileWeightConvert 命名空间作为移动端兼容入口，导出形状不变。
import {
  convertSDToNAI,
  convertNAIToSD,
  renderNAIHighlighted,
  renderSDHighlighted,
} from '../../../utils/weightConversion';

export const mobileWeightConvert = {
  convertSDToNAI,
  convertNAIToSD,
  renderNAIHighlighted,
  renderSDHighlighted,
};
