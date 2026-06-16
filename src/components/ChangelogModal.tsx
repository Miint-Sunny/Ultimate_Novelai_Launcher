import React, { useState, useEffect } from 'react';
import { X, Sparkles, ScrollText } from 'lucide-react';
import { changelog, type ChangelogEntry } from '../data/changelog';
import { hasWhatsNewForLatest } from './WhatsNewModal';

const STORAGE_KEY = 'changelog_last_seen_version';

interface ChangelogModalProps {
  /** 外部控制打开（查看全部日志） */
  forceOpen?: boolean;
  onClose?: () => void;
}

/** 外部调用：打开全部更新日志 */
export const openChangelogAll = () => {
  window.dispatchEvent(new CustomEvent('open-changelog-all'));
};

export const ChangelogModal: React.FC<ChangelogModalProps> = ({ forceOpen, onClose }) => {
  const [isOpen, setIsOpen] = useState(false);
  const [entries, setEntries] = useState<ChangelogEntry[]>([]);
  const [isViewAll, setIsViewAll] = useState(false);

  // 监听全局事件：手动打开全部日志
  useEffect(() => {
    const handler = () => {
      setEntries(changelog);
      setIsViewAll(true);
      setIsOpen(true);
    };
    window.addEventListener('open-changelog-all', handler);
    return () => window.removeEventListener('open-changelog-all', handler);
  }, []);

  // 自动弹出：检查未读更新
  // 注意：当最新版本配置了 WhatsNew 导览（hasWhatsNewForLatest）时，由 WhatsNewModal 接管；
  // 本组件仅在没有导览的版本上自动弹文字补丁。
  useEffect(() => {
    if (forceOpen) return;
    if (changelog.length === 0) return;
    if (hasWhatsNewForLatest()) return; // 让 WhatsNewModal 接管

    const lastSeen = localStorage.getItem(STORAGE_KEY);
    const latestVersion = changelog[0].version;

    if (!lastSeen || lastSeen !== latestVersion) {
      const lastSeenIndex = lastSeen
        ? changelog.findIndex(e => e.version === lastSeen)
        : -1;
      const unseen = lastSeenIndex > 0
        ? changelog.slice(0, lastSeenIndex)
        : lastSeenIndex === 0
          ? []
          : changelog;
      setEntries(unseen.length > 0 ? unseen : [changelog[0]]);
      setIsViewAll(false);
      setIsOpen(true);
    }
  }, [forceOpen]);

  // 外部控制打开：查看全部日志
  useEffect(() => {
    if (forceOpen) {
      setEntries(changelog);
      setIsViewAll(true);
      setIsOpen(true);
    }
  }, [forceOpen]);

  const handleClose = () => {
    setIsOpen(false);
    if (changelog.length > 0) {
      localStorage.setItem(STORAGE_KEY, changelog[0].version);
    }
    onClose?.();
  };

  // 切换查看全部
  const handleViewAll = () => {
    setEntries(changelog);
    setIsViewAll(true);
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={handleClose} />

      <div className="relative bg-nai-panel border border-gray-700 rounded-2xl shadow-2xl w-full max-w-lg max-h-[80vh] flex flex-col overflow-hidden animate-in fade-in zoom-in-95 duration-200">
        {/* 头部 */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-700/50">
          <div className="flex items-center gap-2">
            {isViewAll
              ? <ScrollText className="w-5 h-5 text-nai-accent" />
              : <Sparkles className="w-5 h-5 text-nai-accent" />
            }
            <h2 className="text-lg font-semibold text-white">{isViewAll ? '更新日志' : '更新内容'}</h2>
          </div>
          <button
            onClick={handleClose}
            className="p-1 rounded-lg text-gray-400 hover:text-white hover:bg-gray-700 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* 内容区域 */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
          {entries.map((entry) => (
            <div key={entry.version}>
              <div className="flex items-baseline gap-2 mb-2">
                <span className="text-sm font-mono text-nai-accent">{entry.version}</span>
                <span className="text-xs text-gray-500">{entry.date}</span>
              </div>
              {entry.title && <h3 className="text-sm font-medium text-gray-200 mb-3">{entry.title}</h3>}

              {entry.sections ? (
                <div className="space-y-3">
                  {entry.sections.map((sec, si) => (
                    <div key={si} className="bg-gray-800/40 rounded-lg p-3">
                      <div className="text-xs font-medium text-gray-300 mb-1.5">{sec.heading}</div>
                      <ul className="space-y-1">
                        {sec.items.map((raw, i) => {
                          const hl = raw.startsWith('!');
                          const text = hl ? raw.slice(1) : raw;
                          return (
                            <li key={i} className={`text-sm flex items-start gap-2 ${hl ? 'text-nai-accent font-medium' : 'text-gray-400'}`}>
                              <span className={`mt-1 shrink-0 ${hl ? 'text-nai-accent' : 'text-nai-accent'}`}>•</span>
                              <span>{text}</span>
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                  ))}
                </div>
              ) : entry.items ? (
                <ul className="space-y-1.5">
                  {entry.items.map((raw, i) => {
                    const hl = raw.startsWith('!');
                    const text = hl ? raw.slice(1) : raw;
                    return (
                      <li key={i} className={`text-sm flex items-start gap-2 ${hl ? 'text-nai-accent font-medium' : 'text-gray-400'}`}>
                        <span className="text-nai-accent mt-1 shrink-0">•</span>
                        <span>{text}</span>
                      </li>
                    );
                  })}
                </ul>
              ) : null}
            </div>
          ))}
        </div>

        {/* 底部 */}
        <div className="px-5 py-3 border-t border-gray-700/50 flex gap-2">
          {!isViewAll && (
            <button
              onClick={handleViewAll}
              className="flex-1 py-2 rounded-lg bg-gray-700/50 hover:bg-gray-700 text-gray-300 text-sm font-medium transition-colors"
            >
              查看全部日志
            </button>
          )}
          <button
            onClick={handleClose}
            className={`${isViewAll ? 'w-full' : 'flex-1'} py-2 rounded-lg bg-nai-accent hover:bg-nai-accent/90 text-black text-sm font-bold transition-colors`}
          >
            {isViewAll ? '关闭' : '我知道了'}
          </button>
        </div>
      </div>
    </div>
  );
};
