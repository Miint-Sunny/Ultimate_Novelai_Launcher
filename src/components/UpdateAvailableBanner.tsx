import React, { useEffect, useRef, useState } from 'react';
import { RefreshCw, Sparkles, X } from 'lucide-react';

const CHECK_INTERVAL_MS = 60_000;
const DISMISS_KEY = 'appUpdate.dismissedSignature';

// 构建签名只取入口模块脚本(<script type="module" src>):它由 index.html 声明,运行期不会多出来。
// 别把 <link> 算进去 —— 懒加载时 Vite 会往 <head> 里补 modulepreload / stylesheet,拿 DOM 去比
// index.html 永远多出几条,后端一就绪、桌面布局一挂上就误报「网站已更新」。只看入口也不会漏更新:
// 懒加载块的文件名写在入口里,入口 CSS 的文件名也并进了入口的哈希(vite:css-post 的 augmentChunkHash)。
function entrySignature(doc: Document, baseUrl: string): string | null {
  const entries = Array.from(doc.querySelectorAll('script[type="module"][src]'))
    .map((el) => {
      const src = el.getAttribute('src') || '';
      try {
        const url = new URL(src, baseUrl);
        return `${url.pathname}${url.search}`;
      } catch {
        return src;
      }
    })
    .filter(Boolean)
    .sort();

  return entries.length > 0 ? entries.join('|') : null;
}

async function fetchCurrentSignature(signal?: AbortSignal): Promise<string | null> {
  const url = new URL('./index.html', window.location.href);
  url.searchParams.set('__update_check', String(Date.now()));

  const response = await fetch(url.toString(), {
    cache: 'no-store',
    signal,
    headers: { 'Cache-Control': 'no-cache' },
  });
  if (!response.ok) return null;

  const html = await response.text();
  return entrySignature(new DOMParser().parseFromString(html, 'text/html'), url.toString());
}

// 桌面壳的前端编进了程序里,进程活着就换不了:检查只会白跑,「刷新」也拿不到新版本。
// 开发服务器有 HMR,同样用不着。
const shouldCheckForUpdates = () => !import.meta.env.DEV && !('__TAURI__' in window);

export const UpdateAvailableBanner: React.FC = () => {
  const [availableSignature, setAvailableSignature] = useState<string | null>(null);
  const initialSignatureRef = useRef<string | null>(null);
  const dismissedSignatureRef = useRef<string | null>(null);

  useEffect(() => {
    if (!shouldCheckForUpdates()) return;

    try {
      dismissedSignatureRef.current = localStorage.getItem(DISMISS_KEY);
    } catch { /* ignore */ }

    initialSignatureRef.current = entrySignature(document, document.baseURI);
    const controller = new AbortController();
    let cancelled = false;

    const check = async () => {
      try {
        const nextSignature = await fetchCurrentSignature(controller.signal);
        if (cancelled || !nextSignature) return;

        if (!initialSignatureRef.current) {
          initialSignatureRef.current = nextSignature;
          return;
        }

        if (
          nextSignature !== initialSignatureRef.current &&
          nextSignature !== dismissedSignatureRef.current
        ) {
          setAvailableSignature(nextSignature);
        }
      } catch {
        // 网络短暂失败时静默跳过，下一轮再检查。
      }
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') void check();
    };

    void check();
    const timer = window.setInterval(check, CHECK_INTERVAL_MS);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      cancelled = true;
      controller.abort();
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, []);

  if (!availableSignature) return null;

  const handleDismiss = () => {
    dismissedSignatureRef.current = availableSignature;
    try {
      localStorage.setItem(DISMISS_KEY, availableSignature);
    } catch { /* ignore */ }
    setAvailableSignature(null);
  };

  return (
    <div
      role="alert"
      className="fixed top-0 left-0 right-0 z-[120] px-3 py-2 bg-nai-accent text-black border-b border-black/20 shadow-lg pointer-events-auto"
    >
      <div className="mx-auto flex max-w-4xl items-center gap-3 text-sm">
        <Sparkles className="h-4 w-4 shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="font-bold">网站已更新</div>
          <div className="text-xs text-black/70">刷新页面即可使用最新版本。</div>
        </div>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="inline-flex items-center gap-1.5 rounded bg-black/15 px-3 py-1.5 text-xs font-bold hover:bg-black/25 transition-colors"
        >
          <RefreshCw className="h-3.5 w-3.5" />
          刷新
        </button>
        <button
          type="button"
          onClick={handleDismiss}
          className="rounded p-1 hover:bg-black/15 transition-colors"
          title="暂不提醒"
          aria-label="暂不提醒"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
};

export default UpdateAvailableBanner;
