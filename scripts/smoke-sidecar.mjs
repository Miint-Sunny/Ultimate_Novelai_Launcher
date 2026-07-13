import { once } from 'node:events';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
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

let fakeLlmRequests = 0;
const fakeLlm = createServer(async (request, response) => {
  try {
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
      response.writeHead(404).end();
      return;
    }
    if (request.headers.authorization !== 'Bearer smoke-llm-credential') {
      response.writeHead(401).end();
      return;
    }
    const chunks = [];
    let received = 0;
    for await (const chunk of request) {
      received += chunk.length;
      if (received > 4 * 1024 * 1024) throw new Error('Fake LLM request exceeded 4 MiB');
      chunks.push(chunk);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (body.model !== 'smoke-model') throw new Error('Unexpected fake LLM model');
    fakeLlmRequests += 1;

    const hasFinalResultTool = Array.isArray(body.tools)
      && body.tools.some(tool => tool?.function?.name === 'final_result');
    const message = hasFinalResultTool
      ? {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'smoke-lite-final',
            type: 'function',
            function: {
              name: 'final_result',
              arguments: JSON.stringify({
                reply_text: 'smoke ready',
                should_draw: true,
                refined_resources: '',
              }),
            },
          }],
        }
      : {
          role: 'assistant',
          content: JSON.stringify({
            positive: '1girl, smoke test',
            negative: '',
            characters: [],
            size: 'Square',
          }),
        };
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({
      id: `smoke-${fakeLlmRequests}`,
      choices: [{ index: 0, message, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }));
  } catch (error) {
    response.writeHead(500, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ error: { message: error.message } }));
  }
});
fakeLlm.listen(0, '127.0.0.1');
await once(fakeLlm, 'listening');
const fakeLlmAddress = fakeLlm.address();
if (!fakeLlmAddress || typeof fakeLlmAddress === 'string') {
  throw new Error('Fake LLM did not bind a TCP port');
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
    ULTIMATE_NOVELAI_LAUNCHER_PROTOCOL: '1',
    ULTIMATE_NOVELAI_LAUNCHER_SIDECAR_AUTH: token,
    ULTIMATE_NOVELAI_LAUNCHER_SIDECAR_HOST: '127.0.0.1',
    ULTIMATE_NOVELAI_LAUNCHER_SIDECAR_PORT: '0',
    LLM_PROVIDER: 'openai',
    LLM_BASE_URL: `http://127.0.0.1:${fakeLlmAddress.port}/v1`,
    LLM_API_KEY: 'smoke-llm-credential',
    LLM_MODEL: 'smoke-model',
    LLM_NETWORK_SCOPE: 'loopback',
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
  const readinessBody = await readiness.json();
  if (!readiness.ok || !readinessBody.ready) {
    throw new Error('Bundled sidecar readiness smoke failed');
  }
  if (
    readinessBody.capabilities?.agent_prompt_resources !== 'available'
    || readinessBody.capabilities?.desktop_agent_available !== true
  ) {
    throw new Error(`Bundled Agent resource smoke failed: ${JSON.stringify(readinessBody)}`);
  }

  const authorization = { Authorization: `Bearer ${token}` };
  const agent = await fetch(`${base}/api/agent/web/generate-prompt`, {
    method: 'POST',
    headers: { ...authorization, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      user_request: 'draw a smoke test girl',
      model: '',
      history: [{ role: 'user', content: 'previous smoke turn' }],
      knowledge_sources: [],
      current_positive: 'smoke base',
      current_negative: '',
      current_characters: [],
    }),
    signal: timeout,
  });
  const agentEvents = await agent.text();
  if (
    !agent.ok
    || agentEvents.includes('event: error')
    || !agentEvents.includes('event: final')
    || !agentEvents.includes('1girl, smoke test')
    || fakeLlmRequests !== 2
  ) {
    throw new Error(`Bundled fake Agent smoke failed: ${agent.status} ${agentEvents}`);
  }

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
  const fakeLlmClosed = once(fakeLlm, 'close');
  fakeLlm.close();
  await fakeLlmClosed;
  await rm(dataDirectory, { recursive: true, force: true });
}
