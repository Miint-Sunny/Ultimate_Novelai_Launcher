import {
  startTransition,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type UIEvent,
} from 'react';
import {
  getRecentVibeEntries,
  getVibeTagPool,
  getVibes,
  migrateFavoritedToTag,
  recordVibeUsageBatch,
  type RecentVibeEntry,
} from '../../services/localLibrary';
import {
  getPublicVibes,
  resolvePublicVibeThumbnailUrl,
} from '../../services/publicLibrary';
import type { VibeFile } from './types';
import {
  filterVibesBySearchAndModel,
  filterVibesByTags,
  mapLocalVibeToFile,
  mapPublicVibeToFile,
} from './vibeManagerUtils';

let savedPublicScrollTop = 0;
let savedLocalScrollTop = 0;
let savedVisiblePublicCount = 20;

interface UseVibeManagerListsParams {
  isOpen: boolean;
  activeVibeIds: string[];
  currentBotUserId: string;
}

export function useVibeManagerLists({
  isOpen,
  activeVibeIds,
  currentBotUserId,
}: UseVibeManagerListsParams) {
  const [vibeTab, setVibeTab] = useState<'public' | 'local'>(() => {
    try {
      const saved = localStorage.getItem('vibe_tab');
      return saved === 'public' || saved === 'local' ? saved : 'public';
    } catch {
      return 'public';
    }
  });
  const [selectedVibes, setSelectedVibes] = useState<string[]>([]);
  const [recentEntries, setRecentEntries] = useState<RecentVibeEntry[]>(() => getRecentVibeEntries());
  const [vibeSearchQuery, setVibeSearchQuery] = useState('');
  const [vibeModelFilter, setVibeModelFilter] = useState<string>('all');
  const [selectedTagFilter, setSelectedTagFilter] = useState<Set<string>>(new Set());
  const [tagPool, setTagPool] = useState<string[]>([]);
  const [publicFiles, setPublicFiles] = useState<VibeFile[]>([]);
  const [localFiles, setLocalFiles] = useState<VibeFile[]>([]);
  const [isLoadingPublicVibes, setIsLoadingPublicVibes] = useState(false);
  const [visiblePublicVibeCount, setVisiblePublicVibeCount] = useState(savedVisiblePublicCount);

  const publicVibeEndRef = useRef<HTMLDivElement>(null);
  const publicScrollRef = useRef<HTMLDivElement>(null);
  const localScrollRef = useRef<HTMLDivElement>(null);

  const bumpRecentUsage = useCallback((vibes: Array<{ id: string; name?: string; preview?: string }>) => {
    if (!vibes.length) return;
    recordVibeUsageBatch(vibes);
    setRecentEntries(getRecentVibeEntries());
  }, []);

  const refreshRecentEntries = useCallback(() => {
    setRecentEntries(getRecentVibeEntries());
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem('vibe_tab', vibeTab);
    } catch {
      // localStorage can be unavailable in hardened/test contexts.
    }
  }, [vibeTab]);

  useEffect(() => {
    if (isOpen) {
      setSelectedVibes([...activeVibeIds]);
    }
  }, [isOpen]);

  useEffect(() => {
    savedVisiblePublicCount = visiblePublicVibeCount;
  }, [visiblePublicVibeCount]);

  useEffect(() => {
    if (!isOpen) return;
    const ref = vibeTab === 'public' ? publicScrollRef : localScrollRef;
    const saved = vibeTab === 'public' ? savedPublicScrollTop : savedLocalScrollTop;
    if (saved <= 0) return;
    const id = requestAnimationFrame(() => {
      if (ref.current) ref.current.scrollTop = saved;
    });
    return () => cancelAnimationFrame(id);
  }, [isOpen, vibeTab, publicFiles.length, localFiles.length]);

  useEffect(() => {
    const el = publicVibeEndRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) {
        setVisiblePublicVibeCount(prev => prev + 20);
      }
    }, { threshold: 0.1 });
    observer.observe(el);
    return () => observer.disconnect();
  }, [publicFiles, vibeSearchQuery, vibeModelFilter]);

  const reloadTagPool = useCallback(async () => {
    const pool = await getVibeTagPool();
    setTagPool(pool);
  }, []);

  const loadLocalVibes = useCallback(async () => {
    try {
      const savedVibes = await getVibes();
      setLocalFiles(savedVibes.map(mapLocalVibeToFile));
    } catch (err) {
      console.error('Error loading local vibes:', err);
    }
  }, []);

  const loadPublicVibes = useCallback(async (forceRefresh = false) => {
    setIsLoadingPublicVibes(true);
    try {
      const vibes = await getPublicVibes(forceRefresh);
      const vibeFiles = vibes.map(vibe => mapPublicVibeToFile(vibe, resolvePublicVibeThumbnailUrl));
      startTransition(() => {
        setPublicFiles(vibeFiles);
        setVisiblePublicVibeCount(prev => Math.max(20, Math.min(prev, vibeFiles.length || 20)));
      });
    } catch (err) {
      console.error('Failed to load public vibes:', err);
      setPublicFiles([]);
    } finally {
      setIsLoadingPublicVibes(false);
    }
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    migrateFavoritedToTag().then(() => reloadTagPool());
    loadLocalVibes();
    loadPublicVibes(true);
    setRecentEntries(getRecentVibeEntries());
  }, [isOpen, loadLocalVibes, loadPublicVibes, reloadTagPool]);

  const filteredPublicFiles = useMemo(() => {
    return filterVibesBySearchAndModel(publicFiles, vibeSearchQuery, vibeModelFilter);
  }, [publicFiles, vibeSearchQuery, vibeModelFilter]);

  const filteredLocalFiles = useMemo(() => {
    return filterVibesBySearchAndModel(localFiles, vibeSearchQuery, vibeModelFilter);
  }, [localFiles, vibeSearchQuery, vibeModelFilter]);

  const tagFilteredLocalFiles = useMemo(() => {
    return filterVibesByTags(filteredLocalFiles, selectedTagFilter);
  }, [filteredLocalFiles, selectedTagFilter]);

  const myPublicUploadsCount = useMemo(() => {
    if (!currentBotUserId) return 0;
    return publicFiles.filter(f => f.uploaderId === currentBotUserId).length;
  }, [publicFiles, currentBotUserId]);

  const tagUsageCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const v of localFiles) {
      if (v.tags) {
        for (const tag of v.tags) {
          counts.set(tag, (counts.get(tag) || 0) + 1);
        }
      }
    }
    return counts;
  }, [localFiles]);

  const toggleVibeSelection = useCallback((id: string) => {
    setSelectedVibes(prev => (
      prev.includes(id)
        ? prev.filter(vibeId => vibeId !== id)
        : [...prev, id]
    ));
  }, []);

  const isVibeInLocal = useCallback((vibeId: string) => {
    return localFiles.some(file => file.id === vibeId);
  }, [localFiles]);

  const isVibeInPublic = useCallback((vibeId: string) => {
    return publicFiles.some(file => file.id === vibeId);
  }, [publicFiles]);

  const handlePublicScroll = useCallback((event: UIEvent<HTMLDivElement>) => {
    savedPublicScrollTop = event.currentTarget.scrollTop;
  }, []);

  const handleLocalScroll = useCallback((event: UIEvent<HTMLDivElement>) => {
    savedLocalScrollTop = event.currentTarget.scrollTop;
  }, []);

  return {
    vibeTab,
    setVibeTab,
    selectedVibes,
    setSelectedVibes,
    recentEntries,
    setRecentEntries,
    bumpRecentUsage,
    refreshRecentEntries,
    vibeSearchQuery,
    setVibeSearchQuery,
    vibeModelFilter,
    setVibeModelFilter,
    selectedTagFilter,
    setSelectedTagFilter,
    tagPool,
    setTagPool,
    publicFiles,
    setPublicFiles,
    localFiles,
    setLocalFiles,
    isLoadingPublicVibes,
    visiblePublicVibeCount,
    setVisiblePublicVibeCount,
    publicVibeEndRef,
    publicScrollRef,
    localScrollRef,
    filteredPublicFiles,
    filteredLocalFiles,
    tagFilteredLocalFiles,
    myPublicUploadsCount,
    tagUsageCounts,
    loadLocalVibes,
    loadPublicVibes,
    reloadTagPool,
    toggleVibeSelection,
    isVibeInLocal,
    isVibeInPublic,
    handlePublicScroll,
    handleLocalScroll,
  };
}
