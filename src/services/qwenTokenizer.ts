// Qwen BPE 资产的浏览器加载器:懒加载 + 就绪订阅。
// 引擎本体在 ./qwenBpe(纯逻辑);这里只负责把 gzip 资产取回、解压、解析并缓存单例。
//
// 体积取舍:T5 词表(~0.8MB)是静态 import 打进主包的;Qwen 资产 gzip 后 ~1.3MB、
// 解压 ~2.2MB,静态打进主包会让首屏 JS 白胖一圈,而计数只是 UI 提示。所以 Qwen 走
// 懒加载:资产由构建器原样产出(不进 JS bundle),首次按 Qwen 口径计数时才 fetch。
// 未就绪期间调用方拿 T5 近似值顶住,就绪后经 useQwenTokenizerReady 触发重算。

import { countQwenTokens, parseQwenBpeAsset, type QwenBpeAsset } from './qwenBpe';

const QWEN_ASSET_URL = new URL('../assets/tokenizer/qwen35_bpe.txt.gz', import.meta.url).href;

let loadPromise: Promise<QwenBpeAsset> | null = null;
let loadedAsset: QwenBpeAsset | null = null;
const listeners = new Set<() => void>();

export function qwenTokenizerReady(): boolean {
  return loadedAsset !== null;
}

/** 资产就绪状态变化时回调;返回取消订阅函数。 */
export function subscribeQwenTokenizer(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** 懒加载并缓存 Qwen 计数资产;重复调用共享同一次加载。失败后允许下次重试。 */
export function ensureQwenTokenizer(): Promise<QwenBpeAsset> {
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    const response = await fetch(QWEN_ASSET_URL);
    if (!response.ok) {
      throw new Error(`failed to load Qwen tokenizer asset: HTTP ${response.status}`);
    }
    const text = await gunzipToText(await response.arrayBuffer());
    const asset = parseQwenBpeAsset(text);
    loadedAsset = asset;
    for (const listener of listeners) listener();
    return asset;
  })();
  loadPromise.catch(() => {
    loadPromise = null;
  });
  return loadPromise;
}

async function gunzipToText(compressed: ArrayBuffer): Promise<string> {
  // DecompressionStream 是平台原生 gzip(WKWebView ≥16.4 / WebView2 / 现代浏览器都有),
  // 不为解压引第三方依赖。
  const stream = new Response(compressed)
    .body!
    .pipeThrough(new DecompressionStream('gzip'));
  return await new Response(stream).text();
}

/** 已就绪则返回精确计数,否则 null(调用方自行决定近似策略)。 */
export function countQwenTokensIfReady(text: string): number | null {
  return loadedAsset ? countQwenTokens(loadedAsset, text) : null;
}
