#!/usr/bin/env node
// 左栏分 tab 状态机的校验(src/utils/sidebarTabs.ts)。
//
// 运行: node --experimental-strip-types scripts/check-sidebar-tabs.mjs
//
// 钉的都是「不报错但用起来别扭」的错法:
//   1. 读档落在库里(来路丢了,关不回去);
//   2. 从库切到别处再关库,回到的是库自己;
//   3. 助手改了当前 tab 的字段也亮点、或点亮了就再也灭不掉;
//   4. 快捷键把 Cmd+数字(浏览器切标签页)也吃掉。

import assert from 'node:assert/strict';
import {
  DEFAULT_SIDEBAR_TAB,
  LIBRARY_PANES,
  SIDEBAR_TABS,
  initialTabState,
  leaveLibrary,
  normalizeLibraryPane,
  normalizePromptLayout,
  noteWrites,
  restoreSidebarTab,
  switchTab,
  tabForField,
  tabForShortcut,
} from '../src/utils/sidebarTabs.ts';

let passed = 0;
const failures = [];
function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`ok ${passed} - ${name}`);
  } catch (error) {
    failures.push(name);
    console.log(`not ok - ${name}\n${error && error.stack ? error.stack : error}`);
  }
}

check('tab 表: 四个 tab 顺序固定,库三个子页', () => {
  assert.deepEqual(SIDEBAR_TABS.map((t) => t.id), ['prompt', 'params', 'reference', 'library']);
  assert.deepEqual(LIBRARY_PANES.map((p) => p.id), ['tags', 'chunks', 'presets']);
  assert.equal(DEFAULT_SIDEBAR_TAB, 'prompt');
});

check('读档: 合法值原样,库和坏值都回提示词;排法与子页各自回默认', () => {
  assert.equal(restoreSidebarTab('params'), 'params');
  assert.equal(restoreSidebarTab('reference'), 'reference');
  assert.equal(restoreSidebarTab('library'), 'prompt');
  assert.equal(restoreSidebarTab('nope'), 'prompt');
  assert.equal(restoreSidebarTab(undefined), 'prompt');
  assert.equal(normalizePromptLayout('stacked'), 'stacked');
  assert.equal(normalizePromptLayout('tabbed'), 'tabbed');
  assert.equal(normalizePromptLayout(3), 'tabbed');
  assert.equal(normalizeLibraryPane('presets'), 'presets');
  assert.equal(normalizeLibraryPane('chunks'), 'chunks');
  assert.equal(normalizeLibraryPane('x'), 'tags');
});

check('切换: 记来路;从库切走不把库记成来路;关库回来路;不在库里关库是 no-op', () => {
  let s = initialTabState();
  assert.deepEqual(s, { active: 'prompt', previous: 'prompt', attention: [] });
  assert.equal(switchTab(s, 'prompt'), s, '切到当前 tab 返回同一对象');
  s = switchTab(s, 'params');
  assert.equal(s.previous, 'prompt');
  s = switchTab(s, 'library');
  assert.equal(s.previous, 'params');
  s = switchTab(s, 'reference');
  assert.equal(s.previous, 'params', '从库切到参考,来路仍是进库前的参数');
  s = switchTab(s, 'library');
  assert.equal(s.previous, 'reference');
  s = leaveLibrary(s);
  assert.equal(s.active, 'reference');
  assert.equal(leaveLibrary(s), s, '不在库里关库返回同一对象');
  assert.deepEqual(initialTabState('library'), { active: 'library', previous: 'prompt', attention: [] });
});

check('亮点: 当前 tab 不亮;按 tab 顺序去重;没新点返回同一对象;切过去就灭', () => {
  let s = initialTabState('prompt');
  s = noteWrites(s, ['steps', 'prompt']);
  assert.deepEqual(s.attention, ['params'], 'prompt 是当前 tab,不亮');
  const same = noteWrites(s, ['scale', 'negative_prompt']);
  assert.equal(same, s, '没有新的 tab 要亮,返回同一对象');
  s = noteWrites(s, ['quality_preset', 'seed']);
  assert.deepEqual(s.attention, ['params', 'library']);
  s = noteWrites(s, ['width', 'height', 'model']);
  assert.deepEqual(s.attention, ['params', 'library'], '常驻控件的字段不亮');
  s = switchTab(s, 'params');
  assert.deepEqual(s.attention, ['library']);
  s = switchTab(s, 'library');
  assert.deepEqual(s.attention, []);
  s = noteWrites(s, ['character']);
  assert.deepEqual(s.attention, ['prompt']);
});

check('字段表: update_studio_parameters 会写的每个键要么有归属要么是常驻控件', () => {
  const fields = ['prompt', 'negative_prompt', 'model', 'width', 'height', 'resolution', 'steps', 'scale', 'cfg_rescale', 'sampler', 'noise_schedule', 'quality_preset', 'seed', 'character_ai_position'];
  const resident = new Set(['model', 'width', 'height', 'resolution']);
  for (const field of fields) {
    if (resident.has(field)) assert.equal(tabForField(field), null, field);
    else assert.notEqual(tabForField(field), null, field);
  }
  assert.equal(tabForField('character'), 'prompt');
  assert.equal(tabForField('bogus'), null);
});

check('快捷键: 只认 Alt+1–4 的 code;带 Cmd/Ctrl/Shift 或别的键都不吃', () => {
  const ev = (over) => ({ altKey: true, ctrlKey: false, metaKey: false, shiftKey: false, code: 'Digit1', ...over });
  assert.equal(tabForShortcut(ev({ code: 'Digit1' })), 'prompt');
  assert.equal(tabForShortcut(ev({ code: 'Digit2' })), 'params');
  assert.equal(tabForShortcut(ev({ code: 'Digit3' })), 'reference');
  assert.equal(tabForShortcut(ev({ code: 'Digit4' })), 'library');
  assert.equal(tabForShortcut(ev({ code: 'Digit5' })), null);
  assert.equal(tabForShortcut(ev({ code: 'KeyA' })), null);
  assert.equal(tabForShortcut(ev({ metaKey: true })), null, 'Cmd+1 是浏览器的');
  assert.equal(tabForShortcut(ev({ ctrlKey: true })), null);
  assert.equal(tabForShortcut(ev({ shiftKey: true })), null);
  assert.equal(tabForShortcut(ev({ altKey: false })), null);
});

if (failures.length > 0) {
  console.error(`\n${failures.length} 项左栏 tab 校验失败: ${failures.join('; ')}`);
  process.exit(1);
}
console.log(`\n${passed} 项左栏 tab 校验全部通过。`);
