import { once } from 'node:events';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
const binariesDirectory = path.join(root, 'src-tauri', 'binaries');
const targetTriple = execFileSync('rustc', ['--print', 'host-tuple'], { encoding: 'utf8' }).trim();
const extension = process.platform === 'win32' ? '.exe' : '';
const expectedBinary = `ultimate-novelai-sidecar-${targetTriple}${extension}`;
const candidates = (await readdir(binariesDirectory)).filter(name => name === expectedBinary);
if (candidates.length !== 1) {
  throw new Error(`Expected one bundled sidecar, found: ${candidates.join(', ')}`);
}

const dataDirectory = await mkdtemp(path.join(os.tmpdir(), 'ultimate-novelai-sidecar-'));
const token = 'smoke-test-process-token';
const instanceId = 'smoke-test-instance';
const child = spawn(path.join(binariesDirectory, candidates[0]), [], {
  cwd: root,
  env: {
    ...process.env,
    ULTIMATE_NOVELAI_LAUNCHER_DATA_DIR: dataDirectory,
    ULTIMATE_NOVELAI_LAUNCHER_INSTANCE_ID: instanceId,
    ULTIMATE_NOVELAI_LAUNCHER_MOCK_GENERATION: '1',
    // Hold mock jobs briefly in a running state so the cancellation smoke can
    // catch a cancellable job instead of racing instant mock output.
    ULTIMATE_NOVELAI_LAUNCHER_MOCK_GENERATION_DELAY_MS: '750',
    ULTIMATE_NOVELAI_LAUNCHER_PROTOCOL: '1',
    ULTIMATE_NOVELAI_LAUNCHER_SIDECAR_AUTH: token,
    ULTIMATE_NOVELAI_LAUNCHER_SIDECAR_HOST: '127.0.0.1',
    ULTIMATE_NOVELAI_LAUNCHER_SIDECAR_PORT: '0',
  },
  stdio: ['ignore', 'pipe', 'inherit'],
});

const timeout = AbortSignal.timeout(30_000);
try {
  const line = await new Promise((resolve, reject) => {
    let buffer = '';
    const onAbort = () => reject(new Error('Timed out waiting for sidecar handshake'));
    timeout.addEventListener('abort', onAbort, { once: true });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      buffer += chunk;
      const newline = buffer.indexOf('\n');
      if (newline >= 0) {
        timeout.removeEventListener('abort', onAbort);
        resolve(buffer.slice(0, newline));
      }
    });
    child.once('exit', code => reject(new Error(`Sidecar exited before ready: ${code}`)));
  });
  const ready = JSON.parse(line);
  if (ready.instance_id !== instanceId || ready.protocol !== 1 || !ready.port) {
    throw new Error(`Invalid sidecar handshake: ${line}`);
  }
  const base = `http://127.0.0.1:${ready.port}`;
  const live = await fetch(`${base}/livez`, { signal: timeout });
  if (!live.ok || (await live.json()).instance_id !== instanceId) {
    throw new Error('Bundled sidecar liveness smoke failed');
  }
  const readiness = await fetch(`${base}/api/v1/system/ready`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: timeout,
  });
  if (!readiness.ok || !(await readiness.json()).ready) {
    throw new Error('Bundled sidecar readiness smoke failed');
  }

  const authorization = { Authorization: `Bearer ${token}` };
  const submitted = await fetch(`${base}/api/v1/generation/jobs`, {
    method: 'POST',
    headers: {
      ...authorization,
      'Content-Type': 'application/json',
      'Idempotency-Key': 'bundled-smoke-generation',
    },
    body: JSON.stringify({
      payload: {
        input: 'smoke test',
        mode: 'tags',
        tags: 'smoke test',
        negative: '',
        params: {},
      },
    }),
    signal: timeout,
  });
  if (submitted.status !== 202) {
    throw new Error(`Bundled generation submit failed: ${submitted.status}`);
  }
  const submittedJob = await submitted.json();
  let completedJob = submittedJob;
  for (let attempt = 0; attempt < 100 && !['succeeded', 'failed'].includes(completedJob.status); attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 50));
    const fetched = await fetch(`${base}/api/v1/generation/jobs/${submittedJob.id}`, {
      headers: authorization,
      signal: timeout,
    });
    if (!fetched.ok) throw new Error(`Bundled generation lookup failed: ${fetched.status}`);
    completedJob = await fetched.json();
  }
  if (completedJob.status !== 'succeeded' || !completedJob.result?.asset_id) {
    throw new Error(`Bundled fake generation failed: ${JSON.stringify(completedJob)}`);
  }
  const generatedAsset = await fetch(
    `${base}/api/v1/assets/${encodeURIComponent(completedJob.result.asset_id)}/content`,
    { headers: authorization, signal: timeout },
  );
  if (!generatedAsset.ok || (await generatedAsset.arrayBuffer()).byteLength === 0) {
    throw new Error('Bundled generated asset smoke failed');
  }

  let cancelledJob = null;
  for (let attempt = 0; attempt < 8 && cancelledJob === null; attempt += 1) {
    const cancelCandidate = await fetch(`${base}/api/v1/generation/jobs`, {
      method: 'POST',
      headers: { ...authorization, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        payload: {
          input: `cancel smoke ${attempt}`,
          mode: 'tags',
          tags: `cancel smoke ${attempt}`,
          negative: '',
          params: {},
        },
      }),
      signal: timeout,
    });
    if (cancelCandidate.status !== 202) {
      throw new Error(`Bundled cancellation submit failed: ${cancelCandidate.status}`);
    }
    const candidate = await cancelCandidate.json();
    const cancellation = await fetch(
      `${base}/api/v1/generation/jobs/${encodeURIComponent(candidate.id)}/cancel`,
      {
        method: 'POST',
        headers: { ...authorization, 'Content-Type': 'application/json' },
        body: '{}',
        signal: timeout,
      },
    );
    if (cancellation.ok) {
      const state = await cancellation.json();
      if (['cancelling', 'cancelled'].includes(state.status)) cancelledJob = state;
    }
  }
  if (cancelledJob === null) {
    throw new Error('Bundled generation cancellation never reached a cancellable job');
  }
  for (let attempt = 0; attempt < 100 && cancelledJob.status !== 'cancelled'; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 25));
    const fetched = await fetch(
      `${base}/api/v1/generation/jobs/${encodeURIComponent(cancelledJob.id)}`,
      { headers: authorization, signal: timeout },
    );
    if (!fetched.ok) throw new Error(`Bundled cancelled job lookup failed: ${fetched.status}`);
    cancelledJob = await fetched.json();
  }
  if (cancelledJob.status !== 'cancelled') {
    throw new Error(`Bundled cancellation did not settle: ${JSON.stringify(cancelledJob)}`);
  }

  const drained = await fetch(`${base}/api/v1/system/drain`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: '{}',
    signal: timeout,
  });
  if (!drained.ok) throw new Error(`Bundled graceful drain failed: ${drained.status}`);
  if (child.exitCode === null) await once(child, 'exit', { signal: timeout });
} finally {
  if (child.exitCode === null) child.kill();
  await rm(dataDirectory, { recursive: true, force: true });
}
