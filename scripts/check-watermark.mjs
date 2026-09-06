#!/usr/bin/env node
// 水印引擎的校验(移植自 Novelai-harness,MIT)。
//
// 运行: node --experimental-strip-types scripts/check-watermark.mjs
//
// 为什么单独钉:这一层的错法全是「导出照样成功,只是图不对」——
//   1. 水印落错位置、尺寸算漂、透明底 logo 盖成一块方板;
//   2. 自动对比度 / 智能选位反了(白底上提亮、往细节最多的地方放);
//   3. 盲水印嵌进去了却提不出来,或者提出来是别人的文本(PRNG / 系数对 / CRC 任一处不一致);
//   4. 盲水印把画质搞花(平坦区没有降档),或者动了 alpha 把隐写元数据抹了。
// 全部在裸 RGBA 上算,不需要浏览器。

import assert from 'node:assert/strict';

const W = await import('../src/services/watermark/index.ts');
const {
  DEFAULT_WATERMARK_CONFIG, WATERMARK_LIMITS, normalizeWatermarkConfig, isWatermarkActive,
  hasVisibleWatermark, hasBlindWatermark,
  resizeRgbaCubicAlphaAware, applyVisibleWatermark, applyAutoContrast,
  findLowInformationPosition, resolveWatermarkPlacement,
  BlindRng, BLIND_PAIRS, blindStep, crc16, buildBlindPayload, decodeBlindPayload,
  embedBlindWatermark, extractBlindWatermark, blindCapacityBlocks, dct8x8, idct8x8,
} = W;

let checks = 0;
const check = (name, fn) => {
  checks += 1;
  try { fn(); console.log(`ok ${checks} - ${name}`); }
  catch (error) { console.error(`not ok ${checks} - ${name}`); throw error; }
};

// ---- 夹具 ----

function solid(width, height, r, g, b, a = 255) {
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < rgba.length; i += 4) { rgba[i] = r; rgba[i + 1] = g; rgba[i + 2] = b; rgba[i + 3] = a; }
  return { rgba, width, height };
}
function pixel(img, x, y) {
  const i = (y * img.width + x) * 4;
  return [img.rgba[i], img.rgba[i + 1], img.rgba[i + 2], img.rgba[i + 3]];
}
const luma = ([r, g, b]) => 0.299 * r + 0.587 * g + 0.114 * b;
function mulberry32(seed) {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6D2B79F5) >>> 0;
    let x = Math.imul(t ^ (t >>> 15), 1 | t);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}
function gradient(width, height) {
  const img = solid(width, height, 0, 0, 0);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      img.rgba[i] = 100 + Math.floor(x / 8);
      img.rgba[i + 1] = 120 + Math.floor(y / 8);
      img.rgba[i + 2] = 160;
    }
  }
  return img;
}
function redChannelMse(a, b, step = 2) {
  let sum = 0; let n = 0;
  for (let y = 0; y < a.height; y += step) {
    for (let x = 0; x < a.width; x += step) {
      const i = (y * a.width + x) * 4;
      const d = a.rgba[i] - b.rgba[i];
      sum += d * d; n += 1;
    }
  }
  return sum / n;
}
const clone = (img) => ({ rgba: new Uint8Array(img.rgba), width: img.width, height: img.height });
const LOGO_URL = 'data:image/png;base64,iVBORw0KGgo=';
const cfg = (overrides = {}) => ({ ...DEFAULT_WATERMARK_CONFIG, enabled: true, imageDataUrl: LOGO_URL, ...overrides });

const white200 = solid(200, 200, 255, 255, 255);
const redWm40 = solid(40, 40, 255, 0, 0, 200);

// ---- 1. 配置 ----

check('配置归一化: 缺键补默认、越界钳制、坏类型回默认、非 data:image 的 logo 丢弃', () => {
  assert.deepEqual(normalizeWatermarkConfig(undefined), DEFAULT_WATERMARK_CONFIG);
  assert.deepEqual(normalizeWatermarkConfig('junk'), DEFAULT_WATERMARK_CONFIG);
  const n = normalizeWatermarkConfig({
    enabled: 'yes', posX: 7, posY: -1, scalePercent: -3, opacity: 2, marginPercent: 99,
    blindStrength: '9', blindText: 42, imageDataUrl: 'https://evil/logo.png', autoPosition: true,
  });
  assert.equal(n.enabled, false);
  assert.equal(n.posX, 1);
  assert.equal(n.posY, 0);
  assert.equal(n.scalePercent, WATERMARK_LIMITS.scalePercent.min);
  assert.equal(n.opacity, 1);
  assert.equal(n.marginPercent, WATERMARK_LIMITS.marginPercent.max);
  assert.equal(n.blindStrength, 5);
  assert.equal(n.blindText, '');
  assert.equal(n.imageDataUrl, null);
  assert.equal(n.autoPosition, true);
  // 超大 logo 不进设置(localStorage 会爆)
  assert.equal(normalizeWatermarkConfig({ imageDataUrl: 'data:image/png;base64,' + 'A'.repeat(WATERMARK_LIMITS.imageDataUrlChars) }).imageDataUrl, null);
});

check('配置: 与 harness 的 JSON 键同名,他导出的配置能直接读', () => {
  const his = { enabled: true, imagePath: 'C:\\wm.png', posX: 0.9, posY: 0.8, scalePercent: 20, opacity: 0.75, marginPercent: 3, autoContrast: true, blindEnabled: true, blindText: 'sig', blindStrength: 4 };
  const n = normalizeWatermarkConfig(his);
  assert.equal(n.posX, 0.9); assert.equal(n.scalePercent, 20); assert.equal(n.opacity, 0.75);
  assert.equal(n.marginPercent, 3); assert.equal(n.blindStrength, 4); assert.equal(n.blindText, 'sig');
  assert.equal(n.imageDataUrl, null, '他的 imagePath 在浏览器里没意义');
});

check('生效判定: 可见要开关 + logo,盲要开关 + 非空文本,两者任一即走管道', () => {
  assert.equal(isWatermarkActive(DEFAULT_WATERMARK_CONFIG), false);
  assert.equal(hasVisibleWatermark({ ...DEFAULT_WATERMARK_CONFIG, enabled: true }), false, '没 logo 不算');
  assert.equal(hasVisibleWatermark(cfg()), true);
  assert.equal(hasBlindWatermark({ ...DEFAULT_WATERMARK_CONFIG, blindEnabled: true, blindText: '   ' }), false);
  assert.equal(isWatermarkActive({ ...DEFAULT_WATERMARK_CONFIG, blindEnabled: true, blindText: 'x' }), true);
});

// ---- 2. 可见水印 ----

check('可见水印: 右下角落位,水印区变红,别处不动,底图 alpha 保持不透明', () => {
  const { image, placement } = applyVisibleWatermark(white200, redWm40, cfg({ posX: 1, posY: 1, scalePercent: 20, opacity: 1, marginPercent: 0 }));
  assert.deepEqual([placement.x, placement.y, placement.width, placement.height], [160, 160, 40, 40]);
  const br = pixel(image, 195, 195);
  assert.equal(br[0], 255); assert.ok(br[1] < 100, `g=${br[1]}`); assert.equal(br[3], 255);
  assert.deepEqual(pixel(image, 5, 5), [255, 255, 255, 255]);
  assert.deepEqual(pixel(white200, 195, 195), [255, 255, 255, 255], '底图不能被原地改');
});

check('可见水印: 透明底 logo 是混合不是盖章', () => {
  const wm = solid(40, 40, 255, 0, 0, 0);
  for (let y = 10; y < 30; y += 1) for (let x = 10; x < 30; x += 1) wm.rgba[(y * 40 + x) * 4 + 3] = 255;
  const { image } = applyVisibleWatermark(white200, wm, cfg({ posX: 0, posY: 0, scalePercent: 20, opacity: 1, marginPercent: 0 }));
  assert.deepEqual(pixel(image, 0, 0), [255, 255, 255, 255], '透明处底图原样');
  assert.deepEqual(pixel(image, 20, 20), [255, 0, 0, 255], '不透明处盖住');
});

check('可见水印: 不透明度 0.5 得到一半的红', () => {
  const wm = solid(40, 40, 255, 0, 0, 255);
  const { image } = applyVisibleWatermark(white200, wm, cfg({ posX: 1, posY: 1, scalePercent: 20, opacity: 0.5, marginPercent: 0 }));
  const p = pixel(image, 180, 180);
  assert.equal(p[0], 255);
  assert.ok(Math.abs(p[1] - 128) <= 2 && Math.abs(p[2] - 128) <= 2, `got ${p}`);
  assert.equal(p[3], 255);
});

check('可见水印: 边距与缩放按短边算,超高 logo 按高度 contain', () => {
  const base = solid(300, 200, 0, 0, 0);
  const p1 = resolveWatermarkPlacement(base, 40, 40, cfg({ posX: 1, posY: 1, scalePercent: 10, marginPercent: 5 }));
  assert.equal(p1.width, 20); assert.equal(p1.marginPx, 10);
  assert.deepEqual([p1.x, p1.y], [300 - 10 - 20, 200 - 10 - 20]);
  const tall = resolveWatermarkPlacement(base, 10, 400, cfg({ scalePercent: 100, marginPercent: 0 }));
  assert.equal(tall.height, 200);
  assert.equal(tall.width, 5);
});

check('自动对比度: 白底压暗、黑底提亮', () => {
  const on = applyVisibleWatermark(white200, redWm40, cfg({ posX: 0.5, posY: 0.5, scalePercent: 20, opacity: 1, marginPercent: 0, autoContrast: true })).image;
  const off = applyVisibleWatermark(white200, redWm40, cfg({ posX: 0.5, posY: 0.5, scalePercent: 20, opacity: 1, marginPercent: 0 })).image;
  assert.ok(luma(pixel(on, 100, 100)) < luma(pixel(off, 100, 100)));
  const dark = solid(200, 200, 10, 10, 10);
  const lit = applyVisibleWatermark(dark, redWm40, cfg({ posX: 0.5, posY: 0.5, scalePercent: 20, opacity: 1, marginPercent: 0, autoContrast: true })).image;
  assert.ok(luma(pixel(lit, 100, 100)) > 60);
  // 直接调也要只动不透明像素
  const wm = solid(4, 4, 255, 0, 0, 255); wm.rgba[3] = 0;
  applyAutoContrast(white200, wm.rgba, 4, 4, 0, 0);
  assert.deepEqual([wm.rgba[0], wm.rgba[1], wm.rgba[2]], [255, 0, 0], '透明像素不变');
  assert.ok(wm.rgba[4] < 255, '不透明像素被压暗');
});

check('智能选位: 左半噪声右半平坦 → 选到右半', () => {
  const img = solid(400, 400, 128, 128, 128);
  const rnd = mulberry32(42);
  for (let y = 0; y < 400; y += 1) for (let x = 0; x < 200; x += 1) {
    const v = Math.floor(rnd() * 256); const i = (y * 400 + x) * 4;
    img.rgba[i] = v; img.rgba[i + 1] = v; img.rgba[i + 2] = v;
  }
  const pos = findLowInformationPosition(img, 40, 40, 4);
  assert.ok(pos.x > 0.5, `x=${pos.x}`);
  const { image, placement } = applyVisibleWatermark(img, redWm40, cfg({ posX: 0, posY: 0, scalePercent: 10, opacity: 1, marginPercent: 1, autoPosition: true }));
  assert.ok(placement.x >= 200, `落点 x=${placement.x} 应在平坦的右半`);
  assert.ok(pixel(image, placement.x + 5, placement.y + 5)[1] < 200, '落点处被红色覆盖');
  assert.deepEqual(findLowInformationPosition(solid(4, 4, 0, 0, 0), 2, 2, 0), { x: 1, y: 1 }, '太小的图回右下');
});

check('可见水印保留 alpha 最低位: 原图模式导出不抹隐写元数据', () => {
  const base = solid(200, 200, 255, 255, 255, 254);
  const { image } = applyVisibleWatermark(base, redWm40, cfg({ posX: 1, posY: 1, scalePercent: 20, opacity: 1, marginPercent: 0 }));
  for (let y = 0; y < 200; y += 7) for (let x = 0; x < 200; x += 7) assert.equal(pixel(image, x, y)[3], 254, `(${x},${y})`);
  const translucent = solid(50, 50, 0, 0, 0, 128);
  const out = applyVisibleWatermark(translucent, solid(10, 10, 255, 255, 255, 255), cfg({ posX: 0, posY: 0, scalePercent: 20, opacity: 1, marginPercent: 0 })).image;
  assert.equal(pixel(out, 2, 2)[3], 255, '半透明底上按 src-over 变不透明');
});

check('alpha 感知缩放: 透明外圈的黑不会渗成暗边', () => {
  const wm = solid(40, 40, 0, 0, 0, 0);
  for (let y = 8; y < 32; y += 1) for (let x = 8; x < 32; x += 1) { const i = (y * 40 + x) * 4; wm.rgba[i] = 255; wm.rgba[i + 3] = 255; }
  const small = resizeRgbaCubicAlphaAware(wm.rgba, 40, 40, 20, 20);
  for (let i = 0; i < small.length; i += 4) {
    if (small[i + 3] > 40) assert.ok(small[i] > 200, `alpha=${small[i + 3]} r=${small[i]}`);
  }
});

// ---- 3. 盲水印 ----

check('DCT: 正逆变换互逆(误差 < 1e-9)', () => {
  const rnd = mulberry32(7);
  const src = new Float64Array(64); for (let i = 0; i < 64; i += 1) src[i] = rnd() * 255;
  const dct = new Float64Array(64); const back = new Float64Array(64); const tmp = new Float64Array(64);
  dct8x8(src, dct, tmp); idct8x8(dct, back, tmp);
  for (let i = 0; i < 64; i += 1) assert.ok(Math.abs(src[i] - back[i]) < 1e-9);
  // 常数块只有 DC
  src.fill(100); dct8x8(src, dct, tmp);
  assert.ok(Math.abs(dct[0] - 800) < 1e-9); for (let i = 1; i < 64; i += 1) assert.ok(Math.abs(dct[i]) < 1e-9);
});

check('PRNG: xorshift32 与 Dart 的 64 位整数语义逐个一致', () => {
  // 参考实现:按他 Dart 代码用 BigInt 逐步算
  let s = 0x4E48574Dn;
  const ref = [];
  for (let i = 0; i < 2000; i += 1) {
    let x = s;
    x ^= (x << 13n) & 0xFFFFFFFFn;
    x ^= x >> 17n;
    x ^= (x << 5n) & 0xFFFFFFFFn;
    s = x;
    ref.push(Number((x & 0x7FFFFFFFn) % BigInt(BLIND_PAIRS.length)));
  }
  const rng = new BlindRng();
  for (let i = 0; i < 2000; i += 1) assert.equal(rng.nextInt(BLIND_PAIRS.length), ref[i], `第 ${i} 个`);
  assert.equal(BLIND_PAIRS.length, 15);
});

check('载荷: NHWM + 长度 + CRC16 + UTF-8;CRC 不对或 magic 不对都提不出', () => {
  assert.equal(crc16(new TextEncoder().encode('123456789')), 0x29B1, 'CRC16-CCITT 标准向量');
  const payload = buildBlindPayload('签名 sig');
  assert.deepEqual([...payload.subarray(0, 4)], [0x4E, 0x48, 0x57, 0x4D]);
  const bits = new Uint8Array(payload.length * 8);
  for (let i = 0; i < bits.length; i += 1) bits[i] = (payload[i >> 3] >> (7 - (i % 8))) & 1;
  assert.equal(decodeBlindPayload(bits), '签名 sig');
  bits[bits.length - 1] ^= 1;
  assert.equal(decodeBlindPayload(bits), null, '数据翻一位 → CRC 不对');
  assert.equal(buildBlindPayload(''), null);
  assert.equal(buildBlindPayload('x'.repeat(0x10000)), null);
  assert.deepEqual([blindStep(1), blindStep(3), blindStep(5), blindStep(0), blindStep(9)], [22, 46, 70, 22, 70]);
});

check('盲水印: 渐变图往返,文本原样提回,红通道 MSE < 20,alpha 不动', () => {
  const orig = gradient(256, 256);
  const img = clone(orig);
  const text = '测试版权签名 NovelAI-Harness 2026';
  assert.equal(embedBlindWatermark(img, text, 3), true);
  assert.equal(extractBlindWatermark(img), text);
  const m = redChannelMse(orig, img);
  assert.ok(m < 20, `mse=${m}`);
  for (let i = 3; i < img.rgba.length; i += 4) assert.equal(img.rgba[i], 255);
  assert.equal(extractBlindWatermark(orig), null, '没嵌过的图提不出东西');
});

check('盲水印: 纯色图(全平坦块)往返,MSE < 15', () => {
  const orig = solid(512, 512, 150, 170, 190);
  const img = clone(orig);
  assert.equal(embedBlindWatermark(img, 'flat-test', 3), true);
  assert.equal(extractBlindWatermark(img), 'flat-test');
  const m = redChannelMse(orig, img);
  assert.ok(m < 15, `mse=${m}`);
});

check('盲水印: 容量不足不动图、返回 false;capacity 算得出', () => {
  const tiny = gradient(64, 64); // 64 块
  const before = new Uint8Array(tiny.rgba);
  assert.equal(embedBlindWatermark(tiny, 'x', 3), false);
  assert.deepEqual(tiny.rgba, before);
  assert.equal(blindCapacityBlocks('x'), (8 + 1) * 8 * 2);
  assert.equal(blindCapacityBlocks(''), null);
  assert.equal(extractBlindWatermark(solid(16, 16, 0, 0, 0)), null, '不到 64 块直接 null');
});

check('盲水印: 色相保持(三通道同增量),极亮像素不偏色', () => {
  const orig = solid(256, 256, 250, 250, 250);
  const rnd = mulberry32(3);
  for (let i = 0; i < orig.rgba.length; i += 4) { const v = 200 + Math.floor(rnd() * 55); orig.rgba[i] = v; orig.rgba[i + 1] = v; orig.rgba[i + 2] = v; }
  const img = clone(orig);
  assert.equal(embedBlindWatermark(img, 'hue', 5), true);
  for (let i = 0; i < img.rgba.length; i += 4) {
    assert.equal(img.rgba[i] - orig.rgba[i], img.rgba[i + 1] - orig.rgba[i + 1]);
    assert.equal(img.rgba[i] - orig.rgba[i], img.rgba[i + 2] - orig.rgba[i + 2]);
  }
  assert.equal(extractBlindWatermark(img), 'hue');
});

check('盲水印: 可见水印之后再嵌,两者共存且都能读', () => {
  const base = gradient(256, 256);
  const { image } = applyVisibleWatermark(base, redWm40, cfg({ posX: 1, posY: 1, scalePercent: 20, opacity: 1, marginPercent: 0 }));
  const img = clone(image);
  assert.equal(embedBlindWatermark(img, 'both', 3), true);
  assert.equal(extractBlindWatermark(img), 'both');
  assert.ok(pixel(img, 250, 250)[1] < 100, '可见水印还在');
});

check('盲水印: 前 64 块被毁(左上角一条被裁 / 压平)仍能靠投票恢复头部提出来', () => {
  const img = gradient(512, 512);
  assert.equal(embedBlindWatermark(img, '头部恢复测试', 3), true);
  const rnd = mulberry32(99);
  // 第一行块(y < 8)整条替换成噪声:裸读的头部必坏
  for (let y = 0; y < 8; y += 1) for (let x = 0; x < 512; x += 1) {
    const i = (y * 512 + x) * 4; const v = Math.floor(rnd() * 256);
    img.rgba[i] = v; img.rgba[i + 1] = v; img.rgba[i + 2] = v;
  }
  assert.equal(extractBlindWatermark(img), '头部恢复测试');
});

check('盲水印: 纯噪声图不会误报', () => {
  const rnd = mulberry32(5);
  const img = solid(256, 256, 0, 0, 0);
  for (let i = 0; i < img.rgba.length; i += 4) { const v = Math.floor(rnd() * 256); img.rgba[i] = v; img.rgba[i + 1] = v; img.rgba[i + 2] = v; }
  assert.equal(extractBlindWatermark(img), null);
});

check('性能: 832×1216 嵌入 + 提取在合理时间内', () => {
  const img = gradient(832, 1216);
  const rnd = mulberry32(11);
  for (let i = 0; i < img.rgba.length; i += 4) { const n = Math.floor(rnd() * 40); img.rgba[i] += n; img.rgba[i + 1] += n; }
  const t0 = performance.now();
  assert.equal(embedBlindWatermark(img, 'perf', 3), true);
  const t1 = performance.now();
  assert.equal(extractBlindWatermark(img), 'perf');
  const t2 = performance.now();
  console.log(`   嵌入 ${(t1 - t0).toFixed(0)} ms,提取 ${(t2 - t1).toFixed(0)} ms`);
  assert.ok(t2 - t0 < 5000, '一张 NAI 尺寸的图不该超过 5 秒');
});

console.log(`\n${checks} 项水印引擎校验全部通过。`);
