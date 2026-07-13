import { useCallback, useEffect, useState } from 'react';
import {
  localSidecarApi,
  SIDECAR_SETTINGS_CHANGED_EVENT,
} from '../api/localSidecarApi';
import {
  APP_SETTINGS_CHANGED_EVENT,
  getAppSettings,
} from '../services/localLibrary/appSettings';

export interface AgentModelPresentation {
  isLocal: boolean;
  primaryModel: string | null;
}

/**
 * The local Agent model is process configuration, not a per-request choice.
 * Custom/private-cloud mode retains the historical five-model selector.
 */
export function useAgentModelPresentation(): AgentModelPresentation {
  const readMode = useCallback(() => getAppSettings().serverMode !== 'custom', []);
  const [presentation, setPresentation] = useState<AgentModelPresentation>(() => ({
    isLocal: readMode(),
    primaryModel: null,
  }));

  const refresh = useCallback(() => {
    const nextIsLocal = readMode();
    if (!nextIsLocal) {
      setPresentation({ isLocal: false, primaryModel: null });
      return () => undefined;
    }

    let cancelled = false;
    localSidecarApi.primaryLlmModel()
      .then((model) => {
        if (!cancelled) {
          // Always replace the object so a capability-only change (for example
          // adding/removing a key while the model name stays the same) also
          // re-renders every Agent entry point.
          setPresentation({ isLocal: true, primaryModel: model || null });
        }
      })
      .catch(() => {
        if (!cancelled) setPresentation({ isLocal: true, primaryModel: null });
      });
    return () => {
      cancelled = true;
    };
  }, [readMode]);

  useEffect(() => {
    let cancelPending = refresh();
    const handleChange = () => {
      cancelPending();
      cancelPending = refresh();
    };
    window.addEventListener(APP_SETTINGS_CHANGED_EVENT, handleChange);
    window.addEventListener(SIDECAR_SETTINGS_CHANGED_EVENT, handleChange);
    window.addEventListener('storage', handleChange);
    return () => {
      cancelPending();
      window.removeEventListener(APP_SETTINGS_CHANGED_EVENT, handleChange);
      window.removeEventListener(SIDECAR_SETTINGS_CHANGED_EVENT, handleChange);
      window.removeEventListener('storage', handleChange);
    };
  }, [refresh]);

  return presentation;
}
