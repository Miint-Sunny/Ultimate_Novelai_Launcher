/**
 * 把 AgentHarness 装进停靠面板:组装 provider / 工具 / 权限闸,把事件流翻成面板条目,
 * 承接 ask_user 与权限卡片的回答。循环本身在 services/agentHarness,这里只有胶水。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { appBackendApi } from '../../../../api/appBackendApi';
import { localSidecarApi, sidecarV1Api } from '../../../../api/localSidecarApi';
import { useAgentDock } from '../../../../contexts/AgentDockContext';
import { AgentHarness } from '../../../../services/agentHarness/harness';
import { DEFAULT_PERMISSION_LIMITS } from '../../../../services/agentHarness/permissionGate';
import { createSidecarLlmProvider, type LlmProvider } from '../../../../services/agentHarness/provider';
import { BUILTIN_SKILLS, formatSkillsForSystemPrompt } from '../../../../services/agentHarness/skills';
import { V5_ARCHITECT_PRESET } from '../../../../services/agentHarness/presets';
import { createWorkbenchToolRegistry, type PromptLibraryEntry } from '../../../../services/agentHarness/tools/index';
import type { HarnessEvent, PermissionDecision, PermissionMode } from '../../../../services/agentHarness/types';
import type { AgentQuestion, WorkbenchAdapter } from '../../../../services/agentHarness/workbench';
import { calculateCostFromUI } from '../../../../services/costCalculator';
import { deletePromptChunk, getPromptChunks, savePromptChunk } from '../../../../services/localLibrary/promptChunks';
import { getAppSettings, saveAppSettings, APP_SETTINGS_CHANGED_EVENT } from '../../../../services/localLibrary/appSettings';
import { v5UpscaleCost, v5UpscaleTargetSize } from '../../../../services/naiV5Upscale';
import { getCachedIsOpus, isOpusUsageExhausted } from '../../../../services/novelai';
import { MODEL_MAP } from '../../../generation/modelResolutionOptions';
import { deserializeTranscript, serializeTranscript, type TranscriptItem } from './transcript';

const TRANSCRIPT_KEY = 'desktop_agent_harness_transcript';
const LOCKED_FIELDS_KEY = 'desktop_agent_locked_fields';

let seq = 0;
const nextId = (prefix: string) => `${prefix}_${Date.now().toString(36)}_${(seq += 1)}`;

function readLockedFields(): Set<string> {
  try {
    const raw = JSON.parse(localStorage.getItem(LOCKED_FIELDS_KEY) || '[]');
    return new Set(Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : []);
  } catch {
    return new Set();
  }
}

async function downscaleImage(blob: Blob, maxEdge: number | null) {
  const bitmap = await createImageBitmap(blob);
  try {
    const ratio = maxEdge ? Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height)) : 1;
    const width = Math.max(1, Math.round(bitmap.width * ratio));
    const height = Math.max(1, Math.round(bitmap.height * ratio));
    const canvas = document.createElement('canvas');
    canvas.width = width; canvas.height = height;
    canvas.getContext('2d')?.drawImage(bitmap, 0, 0, width, height);
    const dataUrl = canvas.toDataURL('image/jpeg', 0.9);
    return { base64: dataUrl.slice(dataUrl.indexOf(',') + 1), mimeType: 'image/jpeg', width, height };
  } finally {
    bitmap.close();
  }
}

function uiModelIdFor(backendId: string): string {
  return Object.entries(MODEL_MAP).find(([, id]) => id === backendId)?.[0] ?? backendId;
}

export interface AgentHarnessController {
  items: TranscriptItem[];
  busy: boolean;
  available: boolean;
  unavailableReason: string | null;
  modelLabel: string;
  mode: PermissionMode;
  setMode: (mode: PermissionMode) => void;
  lockedFields: Set<string>;
  toggleLockedField: (field: string) => void;
  send: (text: string, imageDataUrl?: string | null) => void;
  answerQuestion: (itemId: string, answers: string[] | null) => void;
  decidePermission: (itemId: string, decision: PermissionDecision) => void;
  clear: () => void;
}

export function useAgentHarness(): AgentHarnessController {
  const { handlersRef, handlersReady } = useAgentDock();
  const [items, setItems] = useState<TranscriptItem[]>(() => {
    try { return deserializeTranscript(JSON.parse(localStorage.getItem(TRANSCRIPT_KEY) || '[]')); } catch { return []; }
  });
  const [busy, setBusy] = useState(false);
  const [mode, setModeState] = useState<PermissionMode>(() => getAppSettings().agentPermissionMode);
  const [lockedFields, setLockedFields] = useState<Set<string>>(readLockedFields);
  const [llm, setLlm] = useState<{ configured: boolean; baseUrl: string; model: string; provider: string } | null>(null);

  const harnessRef = useRef<AgentHarness | null>(null);
  const providerRef = useRef<LlmProvider | null>(null);
  const askResolvers = useRef(new Map<string, (answers: string[] | null) => void>());
  const modeRef = useRef(mode); modeRef.current = mode;
  const lockedRef = useRef(lockedFields); lockedRef.current = lockedFields;

  useEffect(() => {
    try { localStorage.setItem(TRANSCRIPT_KEY, JSON.stringify(serializeTranscript(items))); } catch { /* 存不下就算了 */ }
  }, [items]);

  // 模型槽位跟着 sidecar 设置走;设置变了重读。
  useEffect(() => {
    let alive = true;
    const load = () => {
      localSidecarApi.settings().then((s) => {
        if (!alive) return;
        setLlm({ configured: s.llm_configured, baseUrl: s.llm_base_url, model: s.llm_model, provider: s.llm_provider });
      }).catch(() => { if (alive) setLlm({ configured: false, baseUrl: '', model: '', provider: '' }); });
    };
    load();
    window.addEventListener(APP_SETTINGS_CHANGED_EVENT, load);
    return () => { alive = false; window.removeEventListener(APP_SETTINGS_CHANGED_EVENT, load); };
  }, []);

  const setMode = useCallback((next: PermissionMode) => {
    setModeState(next);
    saveAppSettings({ ...getAppSettings(), agentPermissionMode: next });
  }, []);

  const toggleLockedField = useCallback((field: string) => {
    setLockedFields((prev) => {
      const next = new Set(prev);
      if (next.has(field)) next.delete(field); else next.add(field);
      try { localStorage.setItem(LOCKED_FIELDS_KEY, JSON.stringify([...next])); } catch { /* ignore */ }
      return next;
    });
  }, []);

  const patchItem = useCallback((id: string, patch: (item: TranscriptItem) => TranscriptItem) => {
    setItems((prev) => prev.map((item) => (item.id === id ? patch(item) : item)));
  }, []);

  const askUser = useCallback((questions: AgentQuestion[]) => new Promise<string[] | null>((resolve) => {
    const id = nextId('ask');
    askResolvers.current.set(id, resolve);
    setItems((prev) => [...prev, { kind: 'ask', id, questions, at: Date.now() }]);
  }), []);

  const answerQuestion = useCallback((itemId: string, answers: string[] | null) => {
    askResolvers.current.get(itemId)?.(answers);
    askResolvers.current.delete(itemId);
    patchItem(itemId, (item) => (item.kind === 'ask' ? { ...item, answers } : item));
  }, [patchItem]);

  const decidePermission = useCallback((itemId: string, decision: PermissionDecision) => {
    setItems((prev) => prev.map((item) => {
      if (item.id !== itemId || item.kind !== 'permission') return item;
      item.request.respond(decision);
      return { ...item, decision };
    }));
  }, []);

  /** 每次发送前按当前设置重建 harness 的依赖;消息历史留在 harness 实例里。 */
  const ensureHarness = useCallback((): AgentHarness | null => {
    const bridge = handlersRef.current?.workbench;
    if (!bridge || !llm?.configured) return null;
    if (!providerRef.current) {
      providerRef.current = createSidecarLlmProvider({
        fetchImpl: (path, init) => localSidecarApi.fetchSse(path, init),
        llmBaseUrl: llm.baseUrl,
        reasoning: false,
      });
    }
    if (harnessRef.current) return harnessRef.current;
    const adapter: WorkbenchAdapter = { ...bridge, askUser };
    const preset = V5_ARCHITECT_PRESET;
    const registry = createWorkbenchToolRegistry({
      adapter,
      allowedParams: () => new Set(preset.allowedModifiableParams),
      estimateGenerationCost: () => {
        const p = adapter.getParams();
        const result = calculateCostFromUI({
          width: p.width, height: p.height, steps: p.steps, modelId: uiModelIdFor(p.model), sampler: p.sampler,
          isOpus: getCachedIsOpus(), opusUsageExhausted: isOpusUsageExhausted(),
        });
        return { anlas: result.total, free: result.total === 0 };
      },
      upscaleQuote: (w, h) => ({ cost: v5UpscaleCost(w, h), target: v5UpscaleTargetSize(w, h) }),
      upscaleV5: (image) => sidecarV1Api.upscaleV5({ image, model: 'nai-diffusion-5-curated', declared_blur_sigma: 0 }),
      downscaleImage,
      postJson: (path, body) => appBackendApi.postJson(path, body),
      promptLibrary: {
        list: async () => (await getPromptChunks()).map((c): PromptLibraryEntry => ({ id: c.id, title: c.label, prompt: c.expansion, category: c.category ?? '其他', createdAt: c.createdAt })),
        save: async (e) => { await savePromptChunk({ id: e.id, label: e.title, expansion: e.prompt, category: e.category, createdAt: e.createdAt }); },
        remove: (id) => deletePromptChunk(id),
      },
      skills: BUILTIN_SKILLS,
      enabledSkillIds: () => preset.enabledSkillIds,
    });
    const settings = getAppSettings();
    harnessRef.current = new AgentHarness({
      tools: registry,
      provider: providerRef.current,
      preset,
      sessionId: `desk_${Date.now().toString(36)}`,
      providerLabel: llm.provider || 'sidecar',
      permissionMode: () => modeRef.current,
      permissionLimits: () => ({ ...DEFAULT_PERMISSION_LIMITS, anlasBudget: settings.agentAnlasBudget, maxGenerationsPerMessage: settings.agentMaxGenerations }),
      opusExhausted: () => isOpusUsageExhausted(),
      lockedFields: () => lockedRef.current,
      systemPromptSuffix: () => formatSkillsForSystemPrompt(BUILTIN_SKILLS.filter((s) => preset.enabledSkillIds.some((id) => s.id === id || s.id.startsWith(`${id}/`)))),
    });
    return harnessRef.current;
  }, [askUser, handlersRef, llm]);

  const send = useCallback((text: string, imageDataUrl?: string | null) => {
    const harness = ensureHarness();
    if (!harness || busy) return;
    const trimmed = text.trim();
    if (!trimmed && !imageDataUrl) return;
    setBusy(true);
    setItems((prev) => [...prev, { kind: 'user', id: nextId('u'), text: trimmed, imageDataUrl: imageDataUrl ?? undefined, at: Date.now() }]);
    const images = imageDataUrl
      ? [{ base64: imageDataUrl.slice(imageDataUrl.indexOf(',') + 1), mimeType: imageDataUrl.slice(5, imageDataUrl.indexOf(';')) || 'image/png' }]
      : [];
    void (async () => {
      let currentAssistant: string | null = null;
      // Tool call ids come from the model and are not unique across turns (some providers
      // reuse call_0 every time), so results are attributed to the transcript row created
      // for the in-flight call, never looked up by call id.
      const toolRowByCall = new Map<string, string>();
      const apply = (event: HarnessEvent) => {
        switch (event.type) {
          case 'turn_start': {
            currentAssistant = nextId('a');
            setItems((prev) => [...prev, { kind: 'assistant', id: currentAssistant!, content: '', thoughts: '', streaming: true, at: Date.now() }]);
            break;
          }
          case 'thought_delta':
            if (currentAssistant) patchItem(currentAssistant, (i) => (i.kind === 'assistant' ? { ...i, thoughts: i.thoughts + event.delta } : i));
            break;
          case 'content_delta':
            if (currentAssistant) patchItem(currentAssistant, (i) => (i.kind === 'assistant' ? { ...i, content: i.content + event.delta } : i));
            break;
          case 'usage':
            if (currentAssistant) patchItem(currentAssistant, (i) => (i.kind === 'assistant' ? { ...i, usage: event.usage } : i));
            break;
          case 'tool_call': {
            if (currentAssistant) patchItem(currentAssistant, (i) => (i.kind === 'assistant' ? { ...i, streaming: false } : i));
            const rowId = nextId('tc');
            toolRowByCall.set(event.toolCall.id, rowId);
            setItems((prev) => [...prev, { kind: 'tool_call', id: rowId, call: event.toolCall, at: Date.now() }]);
            break;
          }
          case 'tool_result': {
            const rowId = toolRowByCall.get(event.result.toolCallId);
            toolRowByCall.delete(event.result.toolCallId);
            if (rowId) patchItem(rowId, (i) => (i.kind === 'tool_call' ? { ...i, result: event.result } : i));
            break;
          }
          case 'permission_request':
            setItems((prev) => [...prev, { kind: 'permission', id: event.request.id, request: event.request, at: Date.now() }]);
            break;
          case 'permission_result':
            break;
          case 'retry':
            setItems((prev) => [...prev, { kind: 'notice', id: nextId('n'), level: 'warn', text: `第 ${event.attempt}/${event.maxAttempts} 次重试(${Math.round(event.delayMs / 1000)}s 后):${event.reason}`, at: Date.now() }]);
            break;
          case 'compaction':
            setItems((prev) => [...prev, { kind: 'notice', id: nextId('n'), level: 'info', text: `上下文已压缩:约 ${event.tokensBefore} → ${event.tokensAfter} token,更早的内容换成了摘要。`, at: Date.now() }]);
            break;
          case 'degraded':
            setItems((prev) => [...prev, { kind: 'notice', id: nextId('n'), level: 'warn', text: `主模型槽位失败,本轮已切到备用槽位(${event.slot})。`, at: Date.now() }]);
            break;
          case 'turn_end':
            if (currentAssistant) patchItem(currentAssistant, (i) => (i.kind === 'assistant' ? { ...i, streaming: false, model: event.finalMessage.model } : i));
            break;
          case 'error':
            if (currentAssistant) patchItem(currentAssistant, (i) => (i.kind === 'assistant' ? { ...i, streaming: false } : i));
            setItems((prev) => [...prev, { kind: 'notice', id: nextId('n'), level: 'error', text: event.error, at: Date.now() }]);
            break;
        }
      };
      try {
        for await (const event of harness.send(trimmed, { images })) apply(event);
      } catch (error) {
        setItems((prev) => [...prev, { kind: 'notice', id: nextId('n'), level: 'error', text: `循环异常:${error instanceof Error ? error.message : String(error)}`, at: Date.now() }]);
      } finally {
        setBusy(false);
      }
    })();
  }, [busy, ensureHarness, patchItem]);

  const clear = useCallback(() => {
    harnessRef.current?.clearMessages();
    setItems([]);
  }, []);

  const unavailableReason = useMemo(() => {
    if (!handlersReady || !handlersRef.current?.workbench) return '工作台还没有挂载。';
    if (!llm) return null;
    if (!llm.configured) return '本地 sidecar 还没有配置 LLM 槽位(设置 → 辅助功能)。';
    if (llm.provider && llm.provider !== 'openai') return `当前槽位是 ${llm.provider},流式 Agent 只支持 OpenAI 兼容地址。`;
    return null;
  }, [handlersReady, handlersRef, llm]);

  return {
    items,
    busy,
    available: unavailableReason === null && llm !== null,
    unavailableReason,
    modelLabel: llm?.model || '',
    mode,
    setMode,
    lockedFields,
    toggleLockedField,
    send,
    answerQuestion,
    decidePermission,
    clear,
  };
}
