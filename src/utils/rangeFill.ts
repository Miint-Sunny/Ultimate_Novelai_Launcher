/**
 * 全局 <input type="range"> 进度填充
 *
 * Chromium 没有 ::-moz-range-progress 这种 thumb 左侧填充伪元素，
 * 所以通过 JS 把当前进度百分比写到元素的 --range-pct CSS 变量上，
 * 再由 index.css 中的 linear-gradient 渲染填充色。
 */

function setRangePct(el: HTMLInputElement) {
  const min = parseFloat(el.min) || 0;
  const max = parseFloat(el.max) || 100;
  const val = parseFloat(el.value);
  const pct = max > min ? ((val - min) / (max - min)) * 100 : 0;
  el.style.setProperty('--range-pct', `${pct}%`);
}

function syncAll(root: ParentNode) {
  root.querySelectorAll<HTMLInputElement>('input[type="range"]').forEach(setRangePct);
}

export function installRangeFillSync() {
  // 1) 用户拖动 / 改值时同步
  document.addEventListener(
    'input',
    (e) => {
      const t = e.target;
      if (t instanceof HTMLInputElement && t.type === 'range') {
        setRangePct(t);
      }
    },
    true,
  );

  // 2) React 挂载新节点时初始化（包括 modal 弹窗、动态列表等）
  const obs = new MutationObserver((mutations) => {
    for (const m of mutations) {
      m.addedNodes.forEach((n) => {
        if (!(n instanceof HTMLElement)) return;
        if (n.matches('input[type="range"]')) {
          setRangePct(n as HTMLInputElement);
        }
        syncAll(n);
      });
      // 属性变更（React 改 value/min/max）时也同步
      if (m.type === 'attributes' && m.target instanceof HTMLInputElement && m.target.type === 'range') {
        setRangePct(m.target);
      }
    }
  });

  obs.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['value', 'min', 'max'],
  });

  // 3) 首次启动时同步现有节点
  syncAll(document.body);
}
