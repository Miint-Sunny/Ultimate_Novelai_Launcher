export const saveApiToken = (token: string): void => {
  if (token.trim()) {
    localStorage.setItem('novelai_token_configured', '1');
  } else {
    localStorage.removeItem('novelai_token_configured');
  }
};

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
