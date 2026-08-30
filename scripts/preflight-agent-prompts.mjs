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

// ---- 方法层(nai5-prompting)---------------------------------------------
// planner 现在按这份 skill 写 V5 提示词。它缺了不会报错到用户脸上,只会让 agent
// 悄悄退回「查 tag 再拼起来」—— 正是我们要修的那个毛病。所以在打包前一起验。
const skillCheck = [
  'import json',
  'from server.agent_router import skills',
  'sections = skills.load_sections()',
  'need = ["写法/0", "写法/2", "写法/3", "写法/4", "写法/9", "构思/先分档：用户给了多少"]',
  'missing = [k for k in need if k not in sections]',
  'ok = (not missing) and bool(skills.load_mandate())',
  'print(json.dumps({"ok": ok, "count": len(sections), "missing": missing}, ensure_ascii=False))',
].join('; ');

let skillOutput;
try {
  skillOutput = execFileSync('uv', ['run', '--frozen', 'python', '-c', skillCheck], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
  });
} catch (error) {
  const stderr = typeof error?.stderr === 'string' ? error.stderr.trim() : '';
  console.error('Desktop Agent skill preflight failed.');
  console.error(stderr || 'The nai5-prompting skill loader could not run.');
  console.error('Required: server/agent_router/resources/skills/nai5-prompting/');
  console.error('Do not stub it out — without the skill the planner degrades to tag stitching.');
  process.exit(1);
}

let skillResult;
try {
  skillResult = JSON.parse((skillOutput.trim().split(/\r?\n/).filter(Boolean).at(-1)) || '');
} catch {
  skillResult = null;
}
if (!skillResult || skillResult.ok !== true) {
  console.error('Desktop Agent skill preflight failed.');
  console.error(`Missing sections: ${(skillResult?.missing || ['<unreadable>']).join(', ')}`);
  process.exit(1);
}

console.log(`Desktop Agent skill validated: nai5-prompting (${skillResult.count} sections)`);
