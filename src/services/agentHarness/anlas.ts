/** 与 services/novelai 的 AnlasInfo 同形,单独声明是为了让 harness 目录不反向依赖重服务。 */
export interface AnlasInfo {
  fixedTrainingStepsLeft: number;
  purchasedTrainingSteps: number;
  isOpus: boolean;
  opusUsage?: { percent: number; isNegative: boolean; timeUntilNextPercent: number };
}
