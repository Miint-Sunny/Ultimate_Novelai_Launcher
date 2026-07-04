import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = process.cwd();
const ignoredDirs = new Set([
  '.git',
  '.venv',
  'dist',
  'node_modules',
  '__pycache__',
  '.pytest_cache',
]);
const ignoredFiles = new Set([
  'package-lock.json',
]);

const patterns = [
  { name: 'NovelAI token', re: new RegExp('p' + 'st-[A-Za-z0-9_-]{8,}') },
  { name: 'OpenAI-compatible key', re: new RegExp('s' + 'k-[A-Za-z0-9_-]{8,}') },
  { name: 'legacy NovelAI proxy host', re: new RegExp('novelai\\.' + 'sora214\\.top') },
  { name: 'Genspark cookie value', re: new RegExp("GENSPARK_" + "COOKIE\\s*=\\s*[\"'][^\"']{8,}") },
  { name: 'Cloudflare clearance cookie', re: new RegExp('cf_' + 'clearance=') },
  { name: 'AWS access key id', re: new RegExp('AK' + 'IA[0-9A-Z]{16}') },
  { name: 'Google API key', re: new RegExp('AI' + 'za[0-9A-Za-z_-]{35}') },
  { name: 'GitHub token', re: new RegExp('gh' + '[pousr]_[0-9A-Za-z]{36}') },
  { name: 'Slack token', re: new RegExp('xo' + 'x[baprs]-[0-9A-Za-z-]{10,}') },
  { name: 'private key block', re: new RegExp('-----BEGIN [A-Z ]{0,20}PRIVATE KEY-----') },
];

const textExtensions = new Set([
  '.css',
  '.html',
  '.js',
  '.json',
  '.jsx',
  '.md',
  '.mjs',
  '.py',
  '.rs',
  '.toml',
  '.ts',
  '.tsx',
  '.txt',
  '.yml',
  '.yaml',
]);

function extname(path) {
  const idx = path.lastIndexOf('.');
  return idx >= 0 ? path.slice(idx) : '';
}

function walk(dir, hits) {
  for (const entry of readdirSync(dir)) {
    if (ignoredDirs.has(entry)) continue;
    const path = join(dir, entry);
    const rel = relative(root, path);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      walk(path, hits);
      continue;
    }
    if (!stat.isFile() || ignoredFiles.has(entry) || !textExtensions.has(extname(entry))) {
      continue;
    }
    const content = readFileSync(path, 'utf8');
    for (const pattern of patterns) {
      if (pattern.re.test(content)) {
        hits.push(`${rel}: ${pattern.name}`);
      }
    }
  }
}

const hits = [];
walk(root, hits);

if (hits.length > 0) {
  console.error('Potential secrets or forbidden endpoints found:');
  for (const hit of hits) {
    console.error(`- ${hit}`);
  }
  process.exit(1);
}

console.log('Secret scan passed.');
