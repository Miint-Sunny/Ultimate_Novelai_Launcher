import { sanitizePresetLibrary, type PresetLibrary } from '../../../../services/agentHarness/presetLibrary';

const KEY = 'desktop_agent_presets';

export function loadPresetLibrary(): PresetLibrary {
  try {
    return sanitizePresetLibrary(JSON.parse(localStorage.getItem(KEY) || 'null'));
  } catch {
    return sanitizePresetLibrary(null);
  }
}

export function savePresetLibrary(lib: PresetLibrary): void {
  try { localStorage.setItem(KEY, JSON.stringify(lib)); } catch { /* 存不下就算了 */ }
}
