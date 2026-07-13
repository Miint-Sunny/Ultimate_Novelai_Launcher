import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import openapiTS, { astToString, COMMENT_HEADER } from 'openapi-typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const snapshotPath = path.join(root, 'openapi', 'sidecar-v1.openapi.json');
const typesPath = path.join(root, 'src', 'api', 'generated', 'sidecar-v1.ts');
const check = process.argv.slice(2).includes('--check');
const unknownArguments = process.argv.slice(2).filter(argument => argument !== '--check');
if (unknownArguments.length > 0) {
  throw new Error(`Unknown arguments: ${unknownArguments.join(', ')}`);
}

async function readExisting(filePath) {
  try {
    return await readFile(filePath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function assertCurrent(filePath, expected) {
  const actual = await readExisting(filePath);
  if (actual === expected) return true;
  const relativePath = path.relative(root, filePath);
  console.error(`${relativePath} is missing or out of date.`);
  return false;
}

const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'ultimate-novelai-openapi-'));
try {
  const temporarySnapshot = path.join(temporaryDirectory, 'sidecar-v1.openapi.json');
  execFileSync('uv', [
    'run',
    '--frozen',
    'python',
    path.join(root, 'scripts', 'export_sidecar_openapi.py'),
    '--output',
    temporarySnapshot,
  ], {
    cwd: root,
    stdio: 'inherit',
  });

  const snapshot = await readFile(temporarySnapshot, 'utf8');
  const syntaxTree = await openapiTS(pathToFileURL(temporarySnapshot), {
    alphabetize: true,
    immutable: true,
  });
  const types = COMMENT_HEADER + astToString(syntaxTree);

  if (check) {
    const results = await Promise.all([
      assertCurrent(snapshotPath, snapshot),
      assertCurrent(typesPath, types),
    ]);
    if (results.includes(false)) {
      console.error('Run `npm run generate:api-types` and commit both generated files.');
      process.exitCode = 1;
    } else {
      console.log('Sidecar v1 OpenAPI snapshot and TypeScript types are current.');
    }
  } else {
    await mkdir(path.dirname(snapshotPath), { recursive: true });
    await mkdir(path.dirname(typesPath), { recursive: true });
    await Promise.all([
      writeFile(snapshotPath, snapshot, 'utf8'),
      writeFile(typesPath, types, 'utf8'),
    ]);
    console.log(`Generated ${path.relative(root, snapshotPath)}.`);
    console.log(`Generated ${path.relative(root, typesPath)}.`);
  }
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}
