// Records only whether a token has been configured. The token itself never
// touches the frontend (no localStorage/IndexedDB/bundle); it lives in the
// sidecar's OS credential store. See sidecar/credentials.py.
export const markApiTokenConfigured = (configured: boolean): void => {
  if (configured) {
    localStorage.setItem('novelai_token_configured', '1');
  } else {
    localStorage.removeItem('novelai_token_configured');
  }
};

// The token is never readable from the frontend by design.
export const getApiToken = (): string | null => {
  return null;
};

export const clearApiToken = (): void => {
  localStorage.removeItem('novelai_token_configured');
  localStorage.removeItem('novelai_user_id');
};

export const saveUserId = (id: string): void => {
  localStorage.setItem('novelai_user_id', id);
};

export const getUserId = (): string | null => {
  return localStorage.getItem('novelai_user_id');
};
