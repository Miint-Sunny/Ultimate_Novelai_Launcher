/**
 * Koch-Zhao DCT 盲水印:肉眼不可见,能从导出图里把签名文本提回来。
 *
 * 逐位移植自 Novelai-harness(MIT)`WatermarkService` 的盲水印部分,魔数、密钥、
 * 系数对表、步长公式、平坦块阈值全部相同,所以两边嵌的水印能互相提取。
 *
 * 算法:8×8 亮度块做正交 DCT,每块由固定种子的 xorshift32 选一对中频系数,用 QIM
 * 奇偶格点把两系数之差量化到 bit 对应的格点上(提取只看差值符号)。平坦块(中高频
 * 能量低)步长降到 0.35 倍,视觉接近无损;写回时 RGB 三通道加同一增量并按像素公共
 * 区间钳制,色相严格保持,alpha 不动。载荷 = 'NHWM' + 长度(2 BE) + CRC16(2 BE) + UTF-8,
 * 在所有块上循环重复嵌入,提取时按位多数投票。
 */

import type { RawRgbaImage, RgbaBytes } from './types.ts';

const MAGIC = [0x4e, 0x48, 0x57, 0x4d]; // 'NHWM'
const KEY_SEED = 0x4e48574d;
/** 平坦块判定阈值:块内中高频 DCT 系数绝对值之和(u+v >= 2)。他按真实 NAI 图校准。 */
export const TEXTURED_BLOCK_ENERGY = 200;
/** 平坦块嵌入步长缩放。 */
export const FLAT_STEP_SCALE = 0.35;
/** Koch-Zhao 中频系数对候选 (u1, v1, u2, v2)。 */
export const BLIND_PAIRS: ReadonlyArray<readonly [number, number, number, number]> = [
  [1, 5, 5, 1],
  [3, 3, 4, 2],
  [2, 4, 4, 3],
  [1, 6, 6, 1],
  [2, 5, 5, 2],
  [2, 6, 6, 2],
  [3, 5, 5, 3],
  [1, 4, 4, 1],
  [2, 3, 3, 2],
  [3, 4, 4, 3],
  [1, 3, 3, 1],
  [2, 2, 3, 3],
  [1, 2, 2, 1],
  [1, 5, 2, 6],
  [4, 4, 5, 5],
];

/** 强度 1–5 → QIM 步长 22–70(正交 DCT 中频系数量级,像素扰动约 step/8)。 */
export function blindStep(strength: number): number {
  const s = Math.min(5, Math.max(1, Math.round(strength)));
  return 10 + s * 12;
}

/** CRC16-CCITT(poly 0x1021,初值 0xFFFF)。 */
export function crc16(data: Uint8Array): number {
  let crc = 0xffff;
  for (let i = 0; i < data.length; i += 1) {
    crc ^= data[i] << 8;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 0x8000) !== 0 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc;
}

/** 载荷:magic(4) + 长度(2 BE) + CRC16(2 BE) + UTF-8;空文本或超长返回 null。 */
export function buildBlindPayload(text: string): Uint8Array | null {
  const data = new TextEncoder().encode(text);
  if (data.length === 0 || data.length > 0xffff) return null;
  const payload = new Uint8Array(8 + data.length);
  payload.set(MAGIC, 0);
  payload[4] = (data.length >> 8) & 0xff;
  payload[5] = data.length & 0xff;
  const crc = crc16(data);
  payload[6] = (crc >> 8) & 0xff;
  payload[7] = crc & 0xff;
  payload.set(data, 8);
  return payload;
}

export function decodeBlindPayload(bits: Uint8Array): string | null {
  const byteLen = Math.floor(bits.length / 8);
  if (byteLen < 8) return null;
  const bytes = new Uint8Array(byteLen);
  for (let i = 0; i < bits.length; i += 1) {
    if (bits[i] === 1) bytes[i >> 3] |= 1 << (7 - (i % 8));
  }
  for (let i = 0; i < MAGIC.length; i += 1) {
    if (bytes[i] !== MAGIC[i]) return null;
  }
  const dataLen = (bytes[4] << 8) | bytes[5];
  if (dataLen === 0 || 8 + dataLen > byteLen) return null;
  const data = bytes.subarray(8, 8 + dataLen);
  const crc = (bytes[6] << 8) | bytes[7];
  if (crc16(data) !== crc) return null;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(data);
  } catch {
    return null;
  }
}

/** 系数对选择用的确定性 PRNG(xorshift32),与他的种子和步进完全一致。 */
export class BlindRng {
  private state: number;

  constructor(seed: number = KEY_SEED) {
    this.state = (seed >>> 0) === 0 ? 0x9e3779b9 : seed >>> 0;
  }

  nextInt(max: number): number {
    let x = this.state >>> 0;
    x = (x ^ ((x << 13) >>> 0)) >>> 0;
    x = (x ^ (x >>> 17)) >>> 0;
    x = (x ^ ((x << 5) >>> 0)) >>> 0;
    this.state = x;
    return (x & 0x7fffffff) % max;
  }
}

// ---- 8×8 正交 DCT-II / DCT-III(查表 + 行列两趟) ----

const COS_TABLE = new Float64Array(64);
for (let k = 0; k < 8; k += 1) {
  for (let n = 0; n < 8; n += 1) {
    COS_TABLE[k * 8 + n] = Math.cos(((2 * n + 1) * k * Math.PI) / 16);
  }
}
const S0 = Math.sqrt(1 / 8);
const S1 = Math.sqrt(2 / 8);
const dctScale = (k: number): number => (k === 0 ? S0 : S1);

/** 正交 2D DCT-II:先行后列。 */
export function dct8x8(src: Float64Array, dst: Float64Array, tmp: Float64Array): void {
  for (let y = 0; y < 8; y += 1) {
    for (let k = 0; k < 8; k += 1) {
      let sum = 0;
      for (let n = 0; n < 8; n += 1) sum += src[y * 8 + n] * COS_TABLE[k * 8 + n];
      tmp[y * 8 + k] = sum * dctScale(k);
    }
  }
  for (let x = 0; x < 8; x += 1) {
    for (let k = 0; k < 8; k += 1) {
      let sum = 0;
      for (let n = 0; n < 8; n += 1) sum += tmp[n * 8 + x] * COS_TABLE[k * 8 + n];
      dst[k * 8 + x] = sum * dctScale(k);
    }
  }
}

/** 正交 2D DCT-III(逆变换):先列后行。 */
export function idct8x8(src: Float64Array, dst: Float64Array, tmp: Float64Array): void {
  for (let x = 0; x < 8; x += 1) {
    for (let n = 0; n < 8; n += 1) {
      let sum = 0;
      for (let k = 0; k < 8; k += 1) sum += dctScale(k) * src[k * 8 + x] * COS_TABLE[k * 8 + n];
      tmp[n * 8 + x] = sum;
    }
  }
  for (let y = 0; y < 8; y += 1) {
    for (let n = 0; n < 8; n += 1) {
      let sum = 0;
      for (let k = 0; k < 8; k += 1) sum += dctScale(k) * tmp[y * 8 + k] * COS_TABLE[k * 8 + n];
      dst[y * 8 + n] = sum;
    }
  }
}

/** Dart 的 round():四舍五入远离零;JS 的 Math.round 对负数的 .5 往正方向进。 */
function roundHalfAwayFromZero(v: number): number {
  return v < 0 ? -Math.round(-v) : Math.round(v);
}

function loadLumaBlock(rgba: RgbaBytes, imgWidth: number, px: number, py: number, block: Float64Array): void {
  for (let y = 0; y < 8; y += 1) {
    for (let x = 0; x < 8; x += 1) {
      const i = ((py + y) * imgWidth + (px + x)) * 4;
      block[y * 8 + x] = 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2];
    }
  }
}

interface BlockScratch {
  block: Float64Array;
  dct: Float64Array;
  tmp: Float64Array;
}

function newScratch(): BlockScratch {
  return { block: new Float64Array(64), dct: new Float64Array(64), tmp: new Float64Array(64) };
}

function embedBlock(
  rgba: RgbaBytes,
  imgWidth: number,
  px: number,
  py: number,
  bit: number,
  pair: readonly [number, number, number, number],
  baseStep: number,
  scratch: BlockScratch,
): void {
  const { block, dct, tmp } = scratch;
  loadLumaBlock(rgba, imgWidth, px, py, block);
  dct8x8(block, dct, tmp);

  let energy = 0;
  for (let i = 0; i < 64; i += 1) {
    const u = i % 8;
    const v = Math.floor(i / 8);
    if (u + v < 2) continue;
    energy += Math.abs(dct[i]);
  }
  const step = baseStep * (energy >= TEXTURED_BLOCK_ENERGY ? 1 : FLAT_STEP_SCALE);

  const [u1, v1, u2, v2] = pair;
  const i1 = v1 * 8 + u1;
  const i2 = v2 * 8 + u2;
  const d = dct[i1] - dct[i2];
  const half = step / 2;
  const newD = bit === 1
    ? half + step * Math.max(0, Math.round((d - half) / step))
    : -half - step * Math.max(0, Math.round((-d - half) / step));
  const adjust = (newD - d) / 2;
  dct[i1] += adjust;
  dct[i2] -= adjust;

  idct8x8(dct, block, tmp);
  for (let y = 0; y < 8; y += 1) {
    for (let x = 0; x < 8; x += 1) {
      const i = ((py + y) * imgWidth + (px + x)) * 4;
      const r = rgba[i];
      const g = rgba[i + 1];
      const b = rgba[i + 2];
      const oldLuma = 0.299 * r + 0.587 * g + 0.114 * b;
      const delta = roundHalfAwayFromZero(block[y * 8 + x] - oldLuma);
      if (delta === 0) continue;
      const lo = -Math.min(r, g, b);
      const hi = 255 - Math.max(r, g, b);
      const shift = delta < lo ? lo : delta > hi ? hi : delta;
      if (shift === 0) continue;
      rgba[i] = r + shift;
      rgba[i + 1] = g + shift;
      rgba[i + 2] = b + shift;
    }
  }
}

function extractBlockBit(
  rgba: RgbaBytes,
  imgWidth: number,
  px: number,
  py: number,
  pair: readonly [number, number, number, number],
  scratch: BlockScratch,
): number {
  const { block, dct, tmp } = scratch;
  loadLumaBlock(rgba, imgWidth, px, py, block);
  dct8x8(block, dct, tmp);
  const [u1, v1, u2, v2] = pair;
  const d = dct[v1 * 8 + u1] - dct[v2 * 8 + u2];
  return d > 0 ? 1 : 0;
}

/** 能容纳这段文本的最小块数(2 倍冗余)。 */
export function blindCapacityBlocks(text: string): number | null {
  const payload = buildBlindPayload(text);
  return payload ? payload.length * 8 * 2 : null;
}

/**
 * 原地嵌入盲水印。容量不足(块数 < 载荷比特 × 2)或载荷非法时不动图像并返回 false。
 */
export function embedBlindWatermark(image: RawRgbaImage, text: string, strength: number): boolean {
  const payload = buildBlindPayload(text);
  if (!payload) return false;
  const blocksX = Math.floor(image.width / 8);
  const blocksY = Math.floor(image.height / 8);
  const totalBlocks = blocksX * blocksY;
  const payloadBits = payload.length * 8;
  if (totalBlocks < payloadBits * 2) return false;

  const step = blindStep(strength);
  const rng = new BlindRng();
  const scratch = newScratch();
  let blockIndex = 0;
  for (let by = 0; by < blocksY; by += 1) {
    for (let bx = 0; bx < blocksX; bx += 1) {
      const bitIndex = blockIndex % payloadBits;
      const bit = (payload[bitIndex >> 3] >> (7 - (bitIndex % 8))) & 1;
      const pair = BLIND_PAIRS[rng.nextInt(BLIND_PAIRS.length)];
      embedBlock(image.rgba, image.width, bx * 8, by * 8, bit, pair, step, scratch);
      blockIndex += 1;
    }
  }
  return true;
}

/** 按周期 `period` 对前 `count` 位做多数投票(冗余重复嵌入的解码)。 */
function voteBits(rawBits: Uint8Array, period: number, count: number): Uint8Array {
  const bits = new Uint8Array(count);
  for (let i = 0; i < count; i += 1) {
    let ones = 0;
    let zeros = 0;
    for (let b = i; b < rawBits.length; b += period) {
      if (rawBits[b] === 1) ones += 1;
      else zeros += 1;
    }
    bits[i] = ones >= zeros ? 1 : 0;
  }
  return bits;
}

function headerLength(headerBits: Uint8Array): number | null {
  const header = new Uint8Array(8);
  for (let i = 0; i < 64; i += 1) {
    if (headerBits[i] === 1) header[i >> 3] |= 1 << (7 - (i % 8));
  }
  for (let i = 0; i < MAGIC.length; i += 1) {
    if (header[i] !== MAGIC[i]) return null;
  }
  const dataLen = (header[4] << 8) | header[5];
  return dataLen === 0 || dataLen > 0xffff ? null : dataLen;
}

/** 头部投票恢复时尝试的最大载荷字节数(候选周期数 × 块数的代价要可控)。 */
const HEADER_RECOVERY_MAX_BYTES = 512;

/**
 * 提取盲水印文本;没有水印、头部不合法或 CRC 不对时返回 null。
 *
 * 与他一样先从前 64 个块裸读载荷头定长度;不同的是头部读坏(左上角被裁、被 JPEG 压平)
 * 时不放弃,而是按候选载荷长度逐个用多数投票恢复头部,magic 与长度域自洽才算。
 * 这是他算法的超集:他能提出来的这里都能,反之亦然。
 */
export function extractBlindWatermark(image: RawRgbaImage): string | null {
  const blocksX = Math.floor(image.width / 8);
  const blocksY = Math.floor(image.height / 8);
  const totalBlocks = blocksX * blocksY;
  if (totalBlocks < 64) return null;

  const rawBits = new Uint8Array(totalBlocks);
  const rng = new BlindRng();
  const scratch = newScratch();
  let idx = 0;
  for (let by = 0; by < blocksY; by += 1) {
    for (let bx = 0; bx < blocksX; bx += 1) {
      const pair = BLIND_PAIRS[rng.nextInt(BLIND_PAIRS.length)];
      rawBits[idx] = extractBlockBit(image.rgba, image.width, bx * 8, by * 8, pair, scratch);
      idx += 1;
    }
  }

  const decodeWithLength = (dataLen: number): string | null => {
    const payloadBits = (8 + dataLen) * 8;
    if (payloadBits > totalBlocks) return null;
    return decodeBlindPayload(voteBits(rawBits, payloadBits, payloadBits));
  };

  // 1. 载荷头(magic + 长度 = 8 字节)固定映射在前 64 个块
  const rawLen = headerLength(rawBits.subarray(0, 64));
  if (rawLen !== null) {
    const text = decodeWithLength(rawLen);
    if (text !== null) return text;
  }

  // 2. 头部坏了:按候选长度投票恢复,头部自洽(magic 对、长度域等于候选)才继续
  const maxLen = Math.min(HEADER_RECOVERY_MAX_BYTES, Math.floor(totalBlocks / 16) - 8);
  for (let dataLen = 1; dataLen <= maxLen; dataLen += 1) {
    if (dataLen === rawLen) continue;
    const period = (8 + dataLen) * 8;
    if (headerLength(voteBits(rawBits, period, 64)) !== dataLen) continue;
    const text = decodeWithLength(dataLen);
    if (text !== null) return text;
  }
  return null;
}
