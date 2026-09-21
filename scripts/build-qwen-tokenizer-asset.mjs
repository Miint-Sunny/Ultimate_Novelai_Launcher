#!/usr/bin/env node
// 生成 NovelAI V5(Qwen 3.5 分词器)的提示词计数资产 src/assets/tokenizer/qwen35_bpe.txt.gz。
//
// 运行: node scripts/build-qwen-tokenizer-asset.mjs --from-def <qwen35_tokenizer.def 路径>
//    或: node scripts/build-qwen-tokenizer-asset.mjs --from-reference <参考仓路径>
//
// ── 资产格式与来源 ─────────────────────────────────────────────────────────
// 官方原始词表是 https://novelai.net/tokenizer/compressed/qwen35_tokenizer.def?v=2&static=true
// (raw deflate 压缩的 JSON,含 config/specialTokens/merges/vocab,约 17MB)。本仓库的
// 网络环境到不了 novelai.net,所以提供两条路:
//
//   --from-def        全量重建:解 raw deflate → 取 config.splitRegex /
//                     config.normalization / specialTokens / merges(丢弃 vocab,
//                     计数只需要 merge 顺序)→ gzip(level 9) 文本。与参考仓
//                     tool/tokenizer/build_qwen_tokenizer_asset.dart 的产出同构。
//   --from-reference  从 MIT 参考仓 github.com/Aaalice233/Aaalice_NAI_Launcher
//                     (本地镜像 reference_repos/Aaalice_NAI_Launcher)已提交的
//                     assets/data/tokenizers/qwen35_bpe.txt.gz 解压校验后重新压出。
//                     本仓库当前提交的资产就是这么来的(逐字节同源,见 SHA-256)。
//
// 产物格式:第一行 JSON 头 {splitRegex, normalization, specialTokens},其余每行一条
// BPE merge("left right"),行序即 rank。merges 已在 GPT-2 字节映射空间里,
// byte-level 映射后不含空格与换行,行格式才安全。
//
// 归属:参考仓 MIT 协议,资产与转换思路源自该项目(见仓库根目录 NOTICE.md §2)。

import { createWriteStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { gzipSync, gunzipSync, inflateRawSync } from 'node:zlib';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT_PATH = resolve(REPO_ROOT, 'src/assets/tokenizer/qwen35_bpe.txt.gz');
const REFERENCE_ASSET_REL =
  'assets/data/tokenizers/qwen35_bpe.txt.gz';

function usage(code = 1) {
  console.error(`用法:
  node scripts/build-qwen-tokenizer-asset.mjs --from-def <qwen35_tokenizer.def>
  node scripts/build-qwen-tokenizer-asset.mjs --from-reference <Aaalice_NAI_Launcher 仓库路径>
      (省略路径时默认找 ../reference_repos/Aaalice_NAI_Launcher 相对本仓库)`);
  process.exit(code);
}

function assertValidHeader(header) {
  if (typeof header.splitRegex !== 'string' || header.splitRegex.length === 0) {
    throw new Error('词表缺少 config.splitRegex');
  }
  if (!Array.isArray(header.specialTokens)) {
    throw new Error('词表缺少 specialTokens 列表');
  }
}

function assertValidMerges(merges) {
  if (!Array.isArray(merges) || merges.length === 0) {
    throw new Error('词表没有 merges');
  }
  for (const merge of merges) {
    if (!Array.isArray(merge) || merge.length !== 2 || merge.some((part) => typeof part !== 'string')) {
      throw new Error(`意外的 merge 结构: ${JSON.stringify(merge)}`);
    }
    // byte-level 映射后不应出现空格与换行,否则行格式不安全。
    if (merge.some((part) => part.includes(' ') || part.includes('\n'))) {
      throw new Error(`merge 中出现空白字符: ${JSON.stringify(merge)}`);
    }
  }
}

function emit(header, merges) {
  const lines = [JSON.stringify(header), ...merges.map(([left, right]) => `${left} ${right}`)];
  const text = `${lines.join('\n')}\n`;
  const compressed = gzipSync(Buffer.from(text, 'utf8'), { level: 9 });
  return { text, compressed };
}

async function buildFromDef(defPath) {
  const compressed = await readFile(defPath);
  const raw = inflateRawSync(compressed);
  const data = JSON.parse(raw.toString('utf8'));
  const config = data.config ?? {};
  const header = {
    splitRegex: config.splitRegex,
    normalization: config.normalization,
    specialTokens: data.specialTokens ?? [],
  };
  assertValidHeader(header);
  const merges = data.merges ?? [];
  assertValidMerges(merges);
  console.log(`源词表: merges=${merges.length} specialTokens=${header.specialTokens.length} normalization=${header.normalization}`);
  return emit(header, merges);
}

async function buildFromReference(referenceRoot) {
  const assetPath = resolve(referenceRoot, REFERENCE_ASSET_REL);
  await stat(assetPath);
  const text = gunzipSync(await readFile(assetPath)).toString('utf8');
  const newlineIndex = text.indexOf('\n');
  if (newlineIndex === -1) {
    throw new Error('参考资产没有内容行');
  }
  const header = JSON.parse(text.slice(0, newlineIndex));
  assertValidHeader(header);
  const merges = text
    .slice(newlineIndex + 1)
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => {
      const splitAt = line.lastIndexOf(' ');
      return [line.slice(0, splitAt), line.slice(splitAt + 1)];
    });
  assertValidMerges(merges);
  console.log(`参考仓资产: merges=${merges.length} specialTokens=${header.specialTokens.length} normalization=${header.normalization}`);
  return emit(header, merges);
}

async function main() {
  const args = process.argv.slice(2);
  let result;
  if (args[0] === '--from-def' && args[1]) {
    result = await buildFromDef(resolve(args[1]));
  } else if (args[0] === '--from-reference') {
    const root = args[1] ?? resolve(REPO_ROOT, '../reference_repos/Aaalice_NAI_Launcher');
    result = await buildFromReference(root);
  } else {
    usage();
  }

  const { text, compressed } = result;
  const stream = createWriteStream(OUTPUT_PATH);
  await new Promise((resolvePromise, rejectPromise) => {
    stream.on('error', rejectPromise);
    stream.on('finish', resolvePromise);
    stream.end(compressed);
  });
  const mb = (bytes) => (bytes / 1024 / 1024).toFixed(2);
  console.log(`写入 ${OUTPUT_PATH}`);
  console.log(`  解压 ${mb(text.length)} MB → gzip ${mb(compressed.length)} MB`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exit(1);
});
