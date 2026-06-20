import React, { useState, useEffect, useCallback } from 'react';
import { Eye, EyeOff, CheckCircle, Loader2 } from 'lucide-react';
import { sidecarApi } from '../../api/sidecar';

/**
 * Editable LLM connection form (Base URL / Model / API Key), backed by the
 * sidecar. Base URL + model persist via /settings; the API key is stored in the
 * OS secret store via /auth/llm-key and is never returned to the frontend.
 * Shared by the desktop and mobile settings pages.
 */
export const LlmApiSettings: React.FC = () => {
  const [baseUrl, setBaseUrl] = useState('');
  const [model, setModel] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [keyConfigured, setKeyConfigured] = useState(false);
  const [llmConfigured, setLlmConfigured] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [savedHint, setSavedHint] = useState(false);

  useEffect(() => {
    let cancelled = false;
    sidecarApi.settings()
      .then((s) => {
        if (cancelled) return;
        setBaseUrl(s.llm_base_url || '');
        setModel(s.llm_model || '');
        setKeyConfigured(!!s.llm_key_configured);
        setLlmConfigured(!!s.llm_configured);
      })
      .catch(() => { /* sidecar not reachable yet; leave fields empty */ })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const flashSaved = () => {
    setSavedHint(true);
    setTimeout(() => setSavedHint(false), 1500);
  };

  const saveBaseUrlModel = useCallback(async () => {
    try {
      const s = await sidecarApi.updateSettings({ llm_base_url: baseUrl.trim(), llm_model: model.trim() });
      setLlmConfigured(!!s.llm_configured);
      setError('');
      flashSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'LLM 配置保存失败');
    }
  }, [baseUrl, model]);

  const saveKey = useCallback(async () => {
    const k = apiKey.trim();
    if (!k) return; // empty blur is a no-op; use 清除 to delete a saved key
    try {
      const st = await sidecarApi.saveLlmKey(k);
      setKeyConfigured(!!st.key_configured);
      setLlmConfigured(!!st.llm_configured);
      setApiKey('');
      setError('');
      flashSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'API Key 保存失败');
    }
  }, [apiKey]);

  const clearKey = useCallback(async () => {
    try {
      const st = await sidecarApi.clearLlmKey();
      setKeyConfigured(!!st.key_configured);
      setLlmConfigured(!!st.llm_configured);
      setApiKey('');
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : '清除失败');
    }
  }, []);

  const inputCls = 'w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2.5 text-sm text-white placeholder-gray-500 focus:border-nai-accent/50 focus:outline-none transition-colors';

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
          <input
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            onBlur={saveBaseUrlModel}
            placeholder="Base URL，如 https://api.openai.com/v1"
            className={inputCls}
          />
          <input
            value={model}
            onChange={(e) => setModel(e.target.value)}
            onBlur={saveBaseUrlModel}
            placeholder="模型，如 gpt-4o-mini"
            className={inputCls}
          />
          <div className="relative">
            <input
              type={showKey ? 'text' : 'password'}
              value={apiKey}
              onChange={(e) => { setApiKey(e.target.value); setError(''); }}
              onBlur={saveKey}
              placeholder={keyConfigured ? 'API Key 已配置（输入新值可替换）' : 'API Key'}
              className={`${inputCls} pr-10`}
            />
            <button
              type="button"
              onClick={() => setShowKey(!showKey)}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300 transition-colors"
            >
              {showKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
            </button>
          </div>
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs text-gray-500">密钥保存在系统密钥库，不会回传前端。</p>
            {keyConfigured && (
              <button onClick={clearKey} className="text-xs text-red-400 hover:text-red-300 transition-colors shrink-0">清除密钥</button>
            )}
          </div>
          {error && <p className="text-xs text-red-400">{error}</p>}
          {savedHint && !error && <p className="text-xs text-emerald-300">已保存</p>}
        </>
      )}
    </div>
  );
};
