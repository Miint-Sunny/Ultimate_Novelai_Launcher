import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const promptResource = path.join(root, 'server', 'agent_router', 'resources', 'prompts.yaml');
// 方法层(nai5-prompting)也必须进包:agent 写 V5 提示词靠它,缺了 skills.py 会硬失败
// ——那是有意的,不要改成静默降级,降级的结果就是 agent 退回拼 tag。
const skillResources = path.join(root, 'server', 'agent_router', 'resources', 'skills');
try {
  execFileSync(process.execPath, [path.join(root, 'scripts', 'preflight-agent-prompts.mjs')], {
    cwd: root,
    stdio: 'inherit',
  });
} catch {
  process.exit(1);
}

const extension = process.platform === 'win32' ? '.exe' : '';

const buildRoot = path.join(root, 'build', 'sidecar');
const distDir = path.join(buildRoot, 'dist');
const workDir = path.join(buildRoot, 'work');
const specDir = path.join(buildRoot, 'spec');
const configDir = path.join(buildRoot, 'config');
for (const directory of [distDir, workDir, specDir, configDir]) {
  mkdirSync(directory, { recursive: true });
}

// onedir,不是 onefile:onefile 每次启动都把原生模块解到一个新的临时目录,系统逐个重新校验签名,
// 冷启动 4–12 秒(壳原先 15 秒超时,超了就崩);onedir 的文件路径固定,只有首次启动要校验,之后 0.4 秒。
// 整个目录作为 Tauri 资源打进包(tauri.conf.json 的 bundle.resources),壳从资源目录启动它。
execFileSync('uv', [
  'run', '--frozen', '--group', 'dev', 'pyinstaller',
  '--noconfirm',
  '--clean',
  '--onedir',
  '--name', 'ultimate-novelai-sidecar',
  '--distpath', distDir,
  '--workpath', workDir,
  '--specpath', specDir,
  '--paths', root,
  '--collect-all', 'curl_cffi',
  '--add-data', `${promptResource}${path.delimiter}server/agent_router/resources`,
  '--add-data', `${skillResources}${path.delimiter}server/agent_router/resources/skills`,
  path.join(root, 'scripts', 'sidecar-entry.py'),
], {
  cwd: root,
  env: { ...process.env, PYINSTALLER_CONFIG_DIR: configDir },
  stdio: 'inherit',
});

const executable = path.join(distDir, 'ultimate-novelai-sidecar', `ultimate-novelai-sidecar${extension}`);
if (!existsSync(executable)) throw new Error(`PyInstaller did not produce ${executable}`);
console.log(`Bundled sidecar: ${path.relative(root, path.dirname(executable))}${path.sep}`);
