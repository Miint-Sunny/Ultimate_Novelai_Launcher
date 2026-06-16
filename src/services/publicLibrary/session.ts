function readStoredSessionId(): string {
  try {
    const saved = localStorage.getItem('bot_session');
    if (!saved) return '';
    const data = JSON.parse(saved) as { sessionId?: unknown };
    return typeof data.sessionId === 'string' ? data.sessionId : '';
  } catch {
    return '';
  }
}

function readStoredBotUserId(): string {
  try {
    const saved = localStorage.getItem('bot_session');
    if (!saved) return '';
    const data = JSON.parse(saved) as { botUserId?: unknown };
    return typeof data.botUserId === 'string' ? data.botUserId : '';
  } catch {
    return '';
  }
}

export function getOptionalSessionId(): string {
  return readStoredSessionId();
}

export function getPublicLibraryOwnerId(): string {
  return readStoredBotUserId() || 'local';
}
