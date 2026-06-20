import React, { useState, useEffect, useCallback } from 'react';
import { Eye, EyeOff, CheckCircle, Loader2, Plus } from 'lucide-react';
import { sidecarApi } from '../../api/sidecar';

/**
 * Editable LLM connection form backed by the sidecar. Supports a provider
 * (protocol) selector — OpenAI-compatible / Anthropic / Google Gemini — for both
 * a primary and an independent backup endpoint; the sidecar tries the primary and
 * falls back to the backup. Base URL + model + provider persist via /settings; the
 * API keys are stored in the OS secret store via /auth/llm-key and never returned.
 * Shared by the desktop and mobile settings pages.
 */

const PROVIDERS: { id: string; name: string }[] = [
  { id: 'openai', name: 'OpenAI 兼容' },
  { id: 'anthropic', name: 'Anthropic' },
  { id: 'gemini', name: 'Google (Gemini)' },
];

const BASE_HINT: Record<string, string> = {
  openai: 'Base URL，如 https://api.openai.com/v1',
  anthropic: '留空=默认 https://api.anthropic.com',
  gemini: '留空=默认 https://generativelanguage.googleapis.com',
};

const MODEL_HINT: Record<string, string> = {
  openai: '模型，如 gpt-4o-mini',
  anthropic: '模型，如 claude-3-5-sonnet-20241022',
  gemini: '模型，如 gemini-2.0-flash',
};

const inputCls =
  'w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2.5 text-sm text-white placeholder-gray-500 focus:border-nai-accent/50 focus:outline-none transition-colors';

interface SlotFieldsProps {
  provider: string;
  onProvider: (v: string) => void;
  baseUrl: string;
  onBaseUrl: (v: string) => void;
  model: string;
  onModel: (v: string) => void;
  onBlurConfig: () => void;
  apiKey: string;
  onApiKey: (v: string) => void;
  showKey: boolean;
  onToggleKey: () => void;
  keyConfigured: boolean;
  onSaveKey: () => void;
  onClearKey: () => void;
}

const SlotFields: React.FC<SlotFieldsProps> = (p) => (
  <div className="space-y-2">
    <select value={p.provider} onChange={(e) => p.onProvider(e.target.value)} className={inputCls}>
      {PROVIDERS.map((x) => (
        <option key={x.id} value={x.id}>{x.name}</option>
      ))}
    </select>
    <input value={p.baseUrl} onChange={(e) => p.onBaseUrl(e.target.value)} onBlur={p.onBlurConfig}
      placeholder={BASE_HINT[p.provider] || 'Base URL'} className={inputCls} />
    <input value={p.model} onChange={(e) => p.onModel(e.target.value)} onBlur={p.onBlurConfig}
      placeholder={MODEL_HINT[p.provider] || '模型'} className={inputCls} />
    <div className="relative">
      <input
        type={p.showKey ? 'text' : 'password'}
        value={p.apiKey}
        onChange={(e) => p.onApiKey(e.target.value)}
        onBlur={p.onSaveKey}
        placeholder={p.keyConfigured ? 'API Key 已配置（输入新值可替换）' : 'API Key'}
        className={`${inputCls} pr-10`}
      />
      <button type="button" onClick={p.onToggleKey}
        className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300 transition-colors">
        {p.showKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
      </button>
    </div>
    {p.keyConfigured && (
      <button onClick={p.onClearKey} className="text-xs text-red-400 hover:text-red-300 transition-colors">清除密钥</button>
    )}
  </div>
);

interface Cfg {
  provider: string;
  baseUrl: string;
  model: string;
  backupProvider: string;
  backupBaseUrl: string;
  backupModel: string;
}

const EMPTY: Cfg = {
  provider: 'openai', baseUrl: '', model: '',
  backupProvider: 'openai', backupBaseUrl: '', backupModel: '',
};

export const LlmApiSettings: React.FC = () => {
  const [cfg, setCfg] = useState<Cfg>(EMPTY);
  const [apiKey, setApiKey] = useState('');
  const [backupApiKey, setBackupApiKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [showBackupKey, setShowBackupKey] = useState(false);
  const [keyConfigured, setKeyConfigured] = useState(false);
  const [backupKeyConfigured, setBackupKeyConfigured] = useState(false);
  const [llmConfigured, setLlmConfigured] = useState(false);
  const [showBackup, setShowBackup] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let cancelled = false;
    sidecarApi.settings()
      .then((s) => {
        if (cancelled) return;
        setCfg({
          provider: s.llm_provider || 'openai',
          baseUrl: s.llm_base_url || '',
          model: s.llm_model || '',
          backupProvider: s.llm_backup_provider || 'openai',
          backupBaseUrl: s.llm_backup_base_url || '',
          backupModel: s.llm_backup_model || '',
        });
        setKeyConfigured(!!s.llm_key_configured);
        setBackupKeyConfigured(!!s.llm_backup_key_configured);
        setLlmConfigured(!!s.llm_configured);
        setShowBackup(!!(s.llm_backup_key_configured || s.llm_backup_base_url || s.llm_backup_model));
      })
      .catch(() => { /* sidecar not reachable yet */ })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const flash = () => { setSaved(true); setTimeout(() => setSaved(false), 1500); };

  const persist = useCallback(async (next: Cfg) => {
    try {
      const s = await sidecarApi.updateSettings({
        llm_provider: next.provider,
        llm_base_url: next.baseUrl.trim(),
        llm_model: next.model.trim(),
        llm_backup_provider: next.backupProvider,
        llm_backup_base_url: next.backupBaseUrl.trim(),
        llm_backup_model: next.backupModel.trim(),
      });
      setLlmConfigured(!!s.llm_configured);
      setError('');
      flash();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'LLM 配置保存失败');
    }
  }, []);

  // local-only patch (text inputs persist on blur); persistNow=true for the provider select
  const patch = (p: Partial<Cfg>, persistNow = false) =>
    setCfg((c) => { const n = { ...c, ...p }; if (persistNow) persist(n); return n; });

  const onBlurConfig = useCallback(() => { persist(cfg); }, [persist, cfg]);

  const saveKey = useCallback(async (slot: 'primary' | 'backup', value: string) => {
    const k = value.trim();
    if (!k) return; // empty blur is a no-op; use 清除 to delete
    try {
      const st = await sidecarApi.saveLlmKey(k, slot);
      setKeyConfigured(!!st.key_configured);
      setBackupKeyConfigured(!!st.backup_key_configured);
      setLlmConfigured(!!st.llm_configured);
      if (slot === 'primary') setApiKey(''); else setBackupApiKey('');
      setError('');
      flash();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'API Key 保存失败');
    }
  }, []);

  const clearKey = useCallback(async (slot: 'primary' | 'backup') => {
    try {
      const st = await sidecarApi.clearLlmKey(slot);
      setKeyConfigured(!!st.key_configured);
      setBackupKeyConfigured(!!st.backup_key_configured);
      setLlmConfigured(!!st.llm_configured);
      if (slot === 'primary') setApiKey(''); else setBackupApiKey('');
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : '清除失败');
    }
  }, []);

  return (
    <div className="bg-gray-800/50 rounded-lg border border-gray-700 p-4 space-y-3">
      <div className="flex items-center justify-between">
        <label className="text-xs text-gray-400 uppercase tracking-wider">AI 接口 (LLM)</label>
        {llmConfigured ? (
          <span className="flex items-center gap-1 text-xs text-emerald-300"><CheckCircle className="w-3.5 h-3.5" />已配置</span>
        ) : (
          <span className="text-xs text-gray-500">未完整配置</span>
        )}
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-xs text-gray-500"><Loader2 className="w-3.5 h-3.5 animate-spin" />读取中…</div>
      ) : (
        <>
          <SlotFields
            provider={cfg.provider}
            onProvider={(v) => patch({ provider: v }, true)}
            baseUrl={cfg.baseUrl}
            onBaseUrl={(v) => patch({ baseUrl: v })}
            model={cfg.model}
            onModel={(v) => patch({ model: v })}
            onBlurConfig={onBlurConfig}
            apiKey={apiKey}
            onApiKey={(v) => { setApiKey(v); setError(''); }}
            showKey={showKey}
            onToggleKey={() => setShowKey(!showKey)}
            keyConfigured={keyConfigured}
            onSaveKey={() => saveKey('primary', apiKey)}
            onClearKey={() => clearKey('primary')}
          />

          {showBackup ? (
            <div className="pt-2 border-t border-gray-700/60 space-y-2">
              <div className="text-xs text-gray-400">备用接口（主接口失败时自动尝试）</div>
              <SlotFields
                provider={cfg.backupProvider}
                onProvider={(v) => patch({ backupProvider: v }, true)}
                baseUrl={cfg.backupBaseUrl}
                onBaseUrl={(v) => patch({ backupBaseUrl: v })}
                model={cfg.backupModel}
                onModel={(v) => patch({ backupModel: v })}
                onBlurConfig={onBlurConfig}
                apiKey={backupApiKey}
                onApiKey={(v) => { setBackupApiKey(v); setError(''); }}
                showKey={showBackupKey}
                onToggleKey={() => setShowBackupKey(!showBackupKey)}
                keyConfigured={backupKeyConfigured}
                onSaveKey={() => saveKey('backup', backupApiKey)}
                onClearKey={() => clearKey('backup')}
              />
            </div>
          ) : (
            <button
              onClick={() => setShowBackup(true)}
              className="flex items-center gap-1 text-xs text-gray-400 hover:text-gray-200 transition-colors"
            >
              <Plus className="w-3.5 h-3.5" />添加备用接口
            </button>
          )}

          <p className="text-xs text-gray-500">密钥保存在系统密钥库，不会回传前端。</p>
          {error && <p className="text-xs text-red-400">{error}</p>}
          {saved && !error && <p className="text-xs text-emerald-300">已保存</p>}
        </>
      )}
    </div>
  );
};
