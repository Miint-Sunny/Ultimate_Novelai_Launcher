import { execFileSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const promptResource = path.join(
  root,
  'server',
  'agent_router',
  'resources',
  'prompts.yaml',
);

function fail(detail) {
  console.error('Desktop Agent prompt preflight failed.');
  console.error(detail);
  console.error(`Required formal resource: ${path.relative(root, promptResource)}`);
  console.error('Do not create a placeholder prompt file; supply the Bot-approved prompts.yaml.');
  process.exit(1);
}

const python = [
  'import json, pathlib, sys',
  'from server.agent_router.prompts import preflight_prompt_resource',
  'result = preflight_prompt_resource(pathlib.Path(sys.argv[1]))',
  'print(json.dumps(result, ensure_ascii=False, default=str))',
].join('; ');

let output;
try {
  output = execFileSync(
    'uv',
    ['run', '--frozen', 'python', '-c', python, promptResource],
    {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      // Force UTF-8 stdio in the child so the (Chinese) validator output never
      // hits Windows' cp1252 console encoder and dies with UnicodeEncodeError,
      // masking the real validation result.
      env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
    },
  );
} catch (error) {
  const stderr = typeof error?.stderr === 'string' ? error.stderr.trim() : '';
  fail(stderr || 'The packaged prompt validator could not run.');
}

const resultLine = output.trim().split(/\r?\n/).filter(Boolean).at(-1);
let result;
try {
  result = JSON.parse(resultLine || '');
} catch {
  fail('The packaged prompt validator returned an invalid result.');
}

if (!result || result.ok !== true) {
  const detail = result?.error || result?.detail || 'Required prompt sections are missing or invalid.';
  fail(String(detail));
}

console.log(`Desktop Agent prompt resource validated: ${path.relative(root, promptResource)}`);
