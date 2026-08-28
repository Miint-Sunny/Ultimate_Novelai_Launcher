import { useEffect, useState } from 'react';
import { qwenTokenizerReady, subscribeQwenTokenizer } from '../services/qwenTokenizer';

/**
 * Qwen 计数资产是否已就绪。token 进度条这类「先给近似值、就绪后重算」的消费方
 * 把它放进 useMemo 依赖,资产加载完成时读数自动升级成 Qwen 精确口径。
 */
export function useQwenTokenizerReady(): boolean {
  const [ready, setReady] = useState<boolean>(qwenTokenizerReady);
  useEffect(
    () => subscribeQwenTokenizer(() => setReady(qwenTokenizerReady())),
    []
  );
  return ready;
}
