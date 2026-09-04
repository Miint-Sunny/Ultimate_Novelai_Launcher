#!/usr/bin/env node
// 提示词片段(官方 Prompt Chunks)文本契约的校验。
//
// 运行: node --experimental-strip-types scripts/check-prompt-chunks.mjs
//
// 契约抄自官方前端 module 37400(2026-09-04 线上 bundle),这里逐条钉死:
//   1. `!macro:label!` 按名字找、区分大小写、两端 trim;`⌜macro:id⌟` 按 id 找;
//   2. 递归展开没有深度上限,只有循环检测;循环与缺失都变空串并被记下来;
//   3. 反向折叠按展开后长度从长到短做纯子串替换;
//   4. 只有真的展开过才动逗号——没有引用的提示词逐字节不变,别的校验钉着字面串。

import assert from 'node:assert/strict';

const M = await import('../src/services/promptChunkMacros.ts');
const {
  PROMPT_CHUNK_TRIGGER, chunkReference, chunkIdReference, parseChunkReference,
  expandPromptChunks, expandPromptChunksForSend, collapseDuplicateCommas, collapsePromptChunks,
  findPromptChunkQuery, filterPromptChunks, lintPromptChunk,
} = M;

let checks = 0;
const check = (name, fn) => {
  checks += 1;
  try { fn(); console.log(`ok ${checks} - ${name}`); }
  catch (error) { console.error(`not ok ${checks} - ${name}`); throw error; }
};

const chunks = [
  { id: 'c-face', label: 'Face', expansion: 'red eyes, long hair' },
  { id: 'c-outfit', label: 'Outfit', expansion: 'school uniform, !macro:Face!' },
  { id: 'c-loop-a', label: 'LoopA', expansion: 'a, !macro:LoopB!' },
  { id: 'c-loop-b', label: 'LoopB', expansion: 'b, !macro:LoopA!' },
  { id: 'c-deep1', label: 'D1', expansion: '!macro:D2!' },
  { id: 'c-deep2', label: 'D2', expansion: '!macro:D3!' },
  { id: 'c-deep3', label: 'D3', expansion: 'bottom' },
  { id: 'c-empty', label: 'Empty', expansion: '' },
];

check('引用写法: 用户形式与编辑器 id 形式,解析只认整枚芯片', () => {
  assert.equal(PROMPT_CHUNK_TRIGGER, '@');
  assert.equal(chunkReference('Face'), '!macro:Face!');
  assert.equal(chunkIdReference('c-face'), '⌜macro:c-face⌟');
  assert.equal(parseChunkReference('!macro:Face!'), 'Face');
  assert.equal(parseChunkReference('  !macro: Face !  '), 'Face');
  assert.equal(parseChunkReference('1girl, !macro:Face!'), null);
  assert.equal(parseChunkReference('face'), null);
});

check('展开: label 引用按名字换正文,区分大小写,两端 trim', () => {
  assert.equal(expandPromptChunks('1girl, !macro:Face!', chunks).text, '1girl, red eyes, long hair');
  assert.equal(expandPromptChunks('!macro: Face !', chunks).text, 'red eyes, long hair');
  const wrongCase = expandPromptChunks('!macro:face!', chunks);
  assert.equal(wrongCase.text, '');
  assert.deepEqual(wrongCase.missing, ['face']);
});

check('展开: id 引用按 id 换,认不出的 id 原样保留(官方如此)', () => {
  assert.equal(expandPromptChunks('⌜macro:c-face⌟, x', chunks).text, 'red eyes, long hair, x');
  assert.equal(expandPromptChunks('⌜macro:nope⌟', chunks).text, '⌜macro:nope⌟');
});

check('展开: 嵌套递归且没有深度上限', () => {
  assert.equal(expandPromptChunks('!macro:Outfit!', chunks).text, 'school uniform, red eyes, long hair');
  assert.equal(expandPromptChunks('!macro:D1!', chunks).text, 'bottom');
});

check('展开: 循环引用在再次遇到时变空串并被记下,不会死循环', () => {
  const out = expandPromptChunks('!macro:LoopA!', chunks);
  assert.equal(out.text, 'a, b, ');
  assert.deepEqual(out.circular, ['LoopA']);
  assert.deepEqual(out.missing, []);
});

check('展开: 缺失的名字变空串并被记下', () => {
  const out = expandPromptChunks('1girl, !macro:Nope!, smile', chunks);
  assert.equal(out.text, '1girl, , smile');
  assert.deepEqual(out.missing, ['Nope']);
});

check('展开: 没有引用的文本逐字节不变,也不产生记录', () => {
  const text = '1girl,  solo , text: hi';
  const out = expandPromptChunks(text, chunks);
  assert.equal(out.text, text);
  assert.deepEqual(out, { text, missing: [], circular: [] });
});

check('发送前: 只有展开过才去重复逗号;没引用的一个字节都不碰', () => {
  const untouched = '1girl,, solo';
  assert.equal(expandPromptChunksForSend(untouched, chunks).text, untouched);
  assert.equal(expandPromptChunksForSend('1girl, !macro:Nope!, smile', chunks).text, '1girl, smile');
  assert.equal(expandPromptChunksForSend('!macro:Empty!, 1girl', chunks).text, '1girl');
  assert.equal(expandPromptChunksForSend('!macro:LoopA!', chunks).text, 'a, b');
});

check('逗号: 连着的并成一个,首尾的去掉', () => {
  assert.equal(collapseDuplicateCommas('a,, b , , c'), 'a, b, c');
  assert.equal(collapseDuplicateCommas(', a, '), 'a');
  assert.equal(collapseDuplicateCommas('a, b'), 'a, b');
});

check('反向折叠: 从长到短做子串替换,默认折成 label 引用', () => {
  const text = '1girl, school uniform, red eyes, long hair, smile, red eyes, long hair';
  assert.equal(
    collapsePromptChunks(text, chunks),
    '1girl, !macro:Outfit!, smile, !macro:Face!',
  );
  assert.equal(collapsePromptChunks('red eyes, long hair', chunks, 'id'), '⌜macro:c-face⌟');
  assert.equal(collapsePromptChunks('nothing here', chunks), 'nothing here');
  assert.equal(collapsePromptChunks('x', []), 'x');
});

check('折叠/展开往返: 折叠再展开回到原文', () => {
  const text = '1girl, school uniform, red eyes, long hair, smile';
  assert.equal(expandPromptChunks(collapsePromptChunks(text, chunks), chunks).text, text);
});

check('@ 查询: 只在段首/分隔符后触发,给出位置与查询串', () => {
  assert.deepEqual(findPromptChunkQuery('@'), { start: 0, query: '' });
  assert.deepEqual(findPromptChunkQuery('@Fa'), { start: 0, query: 'Fa' });
  assert.deepEqual(findPromptChunkQuery('1girl, @out'), { start: 7, query: 'out' });
  assert.deepEqual(findPromptChunkQuery('a|@x'), { start: 2, query: 'x' });
  assert.equal(findPromptChunkQuery('mail@x'), null);
  assert.equal(findPromptChunkQuery('@x,'), null);
  assert.equal(findPromptChunkQuery('1girl'), null);
});

check('@ 列表: 空查询给全部;前缀命中排在包含命中前;不分大小写', () => {
  assert.equal(filterPromptChunks(chunks, '').length, chunks.length);
  const out = filterPromptChunks(chunks, 'fa').map((c) => c.label);
  assert.equal(out[0], 'Face');
  const byBody = filterPromptChunks(chunks, 'uniform').map((c) => c.label);
  assert.deepEqual(byBody, ['Outfit']);
});

check('lint: 空名/名字带 ! 是硬错;单竖线与未闭合权重是警告', () => {
  assert.equal(lintPromptChunk('Face', 'red eyes').length, 0);
  assert.ok(lintPromptChunk('', 'x').some((l) => l.level === 'error'));
  assert.ok(lintPromptChunk('a!b', 'x').some((l) => l.level === 'error'));
  assert.ok(lintPromptChunk('a', 'left | right').some((l) => l.level === 'warning'));
  assert.equal(lintPromptChunk('a', 'left || right').length, 0);
  assert.ok(lintPromptChunk('a', '1.3::red eyes').some((l) => l.level === 'warning'));
  assert.equal(lintPromptChunk('a', '1.3::red eyes::').length, 0);
});

console.log(`\n${checks} 项提示词片段校验全部通过。`);
