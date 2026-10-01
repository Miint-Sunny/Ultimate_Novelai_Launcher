#!/usr/bin/env node
// 桌面外壳宽度分配(src/components/desktop/shellLayout.ts)的校验。
//
// 运行: node --experimental-strip-types scripts/check-shell-layout.mjs
//
// 为什么单独钉:这层错了不报错,只是画布被挤没。2026-10-01 实测旧版:左栏 430 + 右栏 400
// 都写死 px、互不相让,1024 宽时画布只剩 194px,900 宽时只剩 70px;而大屏根字号放大后,
// 两栏又不跟着放大。下面每条都对应一个用户看得见的样子。

import './lib/load-frontend-module.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const {
  CANVAS_MIN_WIDTH, SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH, SIDEBAR_DEFAULT_WIDTH,
  resolveShellWidths, shellScale, designPxToRem, clampSidebarWidth,
} = await import('../src/components/desktop/shellLayout.ts');
const { DOCK_MIN_WIDTH, DOCK_DEFAULT_WIDTH } = await import('../src/components/desktop/dock/dockLayout.ts');

let checks = 0;
const check = (name, fn) => {
  checks += 1;
  try { fn(); console.log(`ok ${checks} - ${name}`); }
  catch (error) { console.error(`not ok ${checks} - ${name}`); throw error; }
};

const at = (viewportPx, extra = {}) => resolveShellWidths({
  viewportPx,
  rootFontPx: 16,
  sidebar: SIDEBAR_DEFAULT_WIDTH,
  dock: DOCK_DEFAULT_WIDTH,
  dockOpen: true,
  ...extra,
});
// 画布宽(设计 px):浮层不占位
const canvasOf = (viewportPx, w, rootFontPx = 16) =>
  viewportPx / shellScale(rootFontPx) - w.sidebar - (w.dockPlacement === 'inline' ? w.dock : 0);

check('宽屏不变:1440 下仍是 430 / 400,画布 610(和改之前一模一样)', () => {
  const w = at(1440);
  assert.deepEqual(w, { sidebar: 430, dock: 400, dockPlacement: 'inline' });
  assert.equal(canvasOf(1440, w), 610);
});

check('先收右栏:1280(Tauri 默认窗口宽)右栏收到 370,画布守住最小宽', () => {
  const w = at(1280);
  assert.equal(w.dockPlacement, 'inline');
  assert.equal(w.sidebar, 430);
  assert.equal(w.dock, 1280 - 430 - CANVAS_MIN_WIDTH);
  assert.equal(canvasOf(1280, w), CANVAS_MIN_WIDTH);
});

check('右栏到底再收左栏:1200 时右栏最小宽、左栏收到 400', () => {
  const w = at(1200);
  assert.deepEqual(w, { sidebar: SIDEBAR_MIN_WIDTH, dock: DOCK_MIN_WIDTH, dockPlacement: 'inline' });
  assert.equal(canvasOf(1200, w), CANVAS_MIN_WIDTH);
});

check('两栏最小也放不下:右栏改浮层,画布拿回整块(1024 旧版只剩 194px)', () => {
  for (const viewport of [1100, 1024, 980, 900]) {
    const w = at(viewport);
    assert.equal(w.dockPlacement, 'overlay', `${viewport} 应该浮起来`);
    assert.ok(canvasOf(viewport, w) >= CANVAS_MIN_WIDTH, `${viewport} 的画布被挤到 ${canvasOf(viewport, w)}`);
    assert.ok(w.dock >= DOCK_MIN_WIDTH);
  }
});

check('右栏没开:左栏一个人也不许把画布挤到最小以下', () => {
  const w = at(900, { dockOpen: false });
  assert.equal(w.dockPlacement, 'closed');
  assert.equal(w.dock, 0);
  assert.equal(w.sidebar, 900 - CANVAS_MIN_WIDTH);
  assert.equal(at(1440, { dockOpen: false }).sidebar, 430);
});

check('大屏等比放大:1920 下根字号 17px,两栏按设计 px 不变、渲染时随 rem 放大', () => {
  assert.equal(shellScale(17), 17 / 16);
  const w = resolveShellWidths({ viewportPx: 1920, rootFontPx: 17, sidebar: 430, dock: 400, dockOpen: true });
  assert.deepEqual(w, { sidebar: 430, dock: 400, dockPlacement: 'inline' });
  assert.equal(designPxToRem(430), '26.875rem'); // 17px 根下渲染为 456.875px
  assert.ok(canvasOf(1920, w, 17) > CANVAS_MIN_WIDTH);
});

check('4K 根字号 22px:视口按设计 px 折算后再分,不会因为放大反而挤掉画布', () => {
  const w = resolveShellWidths({ viewportPx: 3840, rootFontPx: 22, sidebar: 680, dock: 720, dockOpen: true });
  assert.equal(w.dockPlacement, 'inline');
  assert.ok(canvasOf(3840, w, 22) >= CANVAS_MIN_WIDTH);
});

check('坏输入不白屏:NaN / 越界宽度回到合法区间', () => {
  assert.equal(clampSidebarWidth(Number.NaN), SIDEBAR_DEFAULT_WIDTH);
  assert.equal(clampSidebarWidth(5000), SIDEBAR_MAX_WIDTH);
  assert.equal(clampSidebarWidth(10), SIDEBAR_MIN_WIDTH);
  const w = resolveShellWidths({ viewportPx: 1440, rootFontPx: Number.NaN, sidebar: Number.NaN, dock: Number.NaN, dockOpen: true });
  assert.equal(w.dockPlacement, 'inline');
  assert.equal(w.sidebar, SIDEBAR_DEFAULT_WIDTH);
});

const readSrc = (relative) => readFileSync(new URL(relative, import.meta.url), 'utf8');

check('结构: 两栏都从 ShellLayoutContext 取宽度,不再自己写死 px', () => {
  const sidebar = readSrc('../src/components/LeftSidebar.tsx');
  assert.equal(sidebar.includes("minWidth: '400px'"), false, '左栏又写死了 px 下限');
  assert.ok(sidebar.includes('designPxToRem(sidebarWidth)'), '左栏宽度要按 rem 渲染');
  const dock = readSrc('../src/components/desktop/dock/RightDock.tsx');
  assert.ok(dock.includes('useShellLayout()'), '右栏要读分配结果,不能直接用存着的宽度');
  assert.ok(dock.includes("'overlay'"), '右栏要有放不下时的浮层摆法');
  const shell = readSrc('../src/AppContent.tsx');
  assert.ok(shell.indexOf('<AgentDockProvider>') < shell.indexOf('<ShellLayoutProvider>'), 'ShellLayoutProvider 要挂在 AgentDockProvider 里面');
});

console.log(`\n${checks} 项外壳宽度校验全部通过。`);
