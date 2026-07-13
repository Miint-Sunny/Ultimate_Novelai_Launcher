import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const sourceRoot = path.join(root, 'src');
const clientDirectory = `${path.join('src', 'api')}${path.sep}`;

const backendFetchPatterns = [
  /\bfetch\s*\(\s*`[^`]*(?:\/api\/|\/settings\b|\/generate\b|\/history\b|\/images\/|\/upscale\b)[^`]*`/g,
  /\bfetch\s*\(\s*['"]\/(?:api\/|settings\b|generate\b|history\b|images\/|upscale\b)/g,
  /\bfetch\s*\(\s*buildApiUrl\s*\(/g,
  /\bfetch\s*\(\s*[^,\n]*(?:getBackendUrl|getQueueServerUrl)\s*\(/g,
  /\b(?:appBackendApi|localSidecarApi|sidecarApi)\.url\s*\(/g,
];

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async entry => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(absolute);
    return /\.(?:ts|tsx)$/.test(entry.name) ? [absolute] : [];
  }));
  return nested.flat();
}

function lineNumber(source, index) {
  return source.slice(0, index).split('\n').length;
}

const violations = [];
for (const absolute of await sourceFiles(sourceRoot)) {
  const relative = path.relative(root, absolute);
  if (relative.startsWith(clientDirectory)) continue;
  const source = await readFile(absolute, 'utf8');
  const matches = [];
  for (const pattern of backendFetchPatterns) {
    pattern.lastIndex = 0;
    for (const match of source.matchAll(pattern)) {
      matches.push(`${relative}:${lineNumber(source, match.index)} direct backend fetch`);
    }
  }
  violations.push(...matches);
}

const localApiPath = path.join('src', 'api', 'localSidecarApi.ts');
const cloudApiPath = path.join('src', 'api', 'cloudBackendApi.ts');
const appBackendPath = path.join('src', 'api', 'appBackendApi.ts');
const agentServicePath = path.join('src', 'services', 'agentService.ts');
const localApiSource = await readFile(path.join(root, localApiPath), 'utf8');
const cloudApiSource = await readFile(path.join(root, cloudApiPath), 'utf8');
const appBackendSource = await readFile(path.join(root, appBackendPath), 'utf8');
const agentServiceSource = await readFile(path.join(root, agentServicePath), 'utf8');

if (/export\s+function\s+imageUrl\s*\(/.test(localApiSource)) {
  violations.push(`${localApiPath}: unauthenticated image URL helpers are forbidden`);
}

if (!cloudApiSource.includes("!headers.has('X-Bot-Session')")) {
  violations.push(`${cloudApiPath}: custom backend must preserve explicit Bot session headers`);
}
if (!cloudApiSource.includes("headers.set('X-Bot-Session', sessionId)")) {
  violations.push(`${cloudApiPath}: custom backend requests are missing Bot session authentication`);
}
if (!cloudApiSource.includes("redirect: 'error'")) {
  violations.push(`${cloudApiPath}: authenticated custom backend requests must reject redirects`);
}

for (const lifecycleSignal of [
  'APP_SETTINGS_CHANGED_EVENT',
  'SIDECAR_SESSION_CHANGED_EVENT',
  "'pagehide'",
  "'beforeunload'",
]) {
  if (!appBackendSource.includes(lifecycleSignal)) {
    violations.push(`${appBackendPath}: missing object URL lifecycle signal ${lifecycleSignal}`);
  }
}

const agentGuardIndex = agentServiceSource.indexOf('desktopAgentAvailability()');
const agentRequestIndex = agentServiceSource.indexOf("appBackendApi.request('/api/agent/web/generate-prompt'");
if (agentRequestIndex >= 0 && (agentGuardIndex < 0 || agentGuardIndex > agentRequestIndex)) {
  violations.push(`${agentServicePath}: desktop Agent request is not capability-gated`);
}
if (agentRequestIndex >= 0 && !agentServiceSource.includes("headers['X-Bot-Session']")) {
  violations.push(`${agentServicePath}: private-cloud Agent request is missing Bot session authentication`);
}

if (violations.length > 0) {
  console.error('Backend requests must use appBackendApi, localSidecarApi/sidecarV1Api, or cloudBackendApi:');
  for (const violation of violations) console.error(`  ${violation}`);
  process.exitCode = 1;
} else {
  console.log('Frontend API boundary check passed.');
}
