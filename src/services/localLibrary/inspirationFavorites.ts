const INSPIRATION_FAVORITES_KEY = 'novelai_inspiration_favorites';

export interface InspirationFavorites {
  codexIds: string[];
  kktIds: string[];
  ocIds: string[];
}

const EMPTY_FAVORITES: InspirationFavorites = { codexIds: [], kktIds: [], ocIds: [] };

export const saveInspirationFavorites = (favorites: InspirationFavorites): void => {
  localStorage.setItem(INSPIRATION_FAVORITES_KEY, JSON.stringify(favorites));
};

export const getInspirationFavorites = (): InspirationFavorites => {
  const stored = localStorage.getItem(INSPIRATION_FAVORITES_KEY);
  if (!stored) return EMPTY_FAVORITES;

  try {
    return { ...EMPTY_FAVORITES, ...JSON.parse(stored) };
  } catch {
    return EMPTY_FAVORITES;
  }
};
