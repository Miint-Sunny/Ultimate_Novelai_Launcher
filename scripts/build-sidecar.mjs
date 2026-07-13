import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const promptResource = path.join(root, 'server', 'agent_router', 'resources', 'prompts.yaml');
try {
  execFileSync(process.execPath, [path.join(root, 'scripts', 'preflight-agent-prompts.mjs')], {
    cwd: root,
    stdio: 'inherit',
  });
} catch {
  process.exit(1);
}

const extension = process.platform === 'win32' ? '.exe' : '';
const targetTriple = execFileSync('rustc', ['--print', 'host-tuple'], { encoding: 'utf8' }).trim();
if (!targetTriple) throw new Error('Failed to determine Rust host target triple');

const buildRoot = path.join(root, 'build', 'sidecar');
const distDir = path.join(buildRoot, 'dist');
const workDir = path.join(buildRoot, 'work');
const specDir = path.join(buildRoot, 'spec');
const configDir = path.join(buildRoot, 'config');
const binariesDir = path.join(root, 'src-tauri', 'binaries');
for (const directory of [distDir, workDir, specDir, configDir, binariesDir]) {
  mkdirSync(directory, { recursive: true });
}

execFileSync('uv', [
  'run', '--frozen', '--group', 'dev', 'pyinstaller',
  '--noconfirm',
  '--clean',
  '--onefile',
  '--name', 'ultimate-novelai-sidecar',
  '--distpath', distDir,
  '--workpath', workDir,
  '--specpath', specDir,
  '--paths', root,
  '--collect-all', 'curl_cffi',
  '--add-data', `${promptResource}${path.delimiter}server/agent_router/resources`,
  path.join(root, 'scripts', 'sidecar-entry.py'),
], {
  cwd: root,
  env: { ...process.env, PYINSTALLER_CONFIG_DIR: configDir },
  stdio: 'inherit',
});

const built = path.join(distDir, `ultimate-novelai-sidecar${extension}`);
const target = path.join(binariesDir, `ultimate-novelai-sidecar-${targetTriple}${extension}`);
copyFileSync(built, target);
if (process.platform !== 'win32') chmodSync(target, 0o755);
console.log(`Bundled sidecar: ${path.relative(root, target)}`);
