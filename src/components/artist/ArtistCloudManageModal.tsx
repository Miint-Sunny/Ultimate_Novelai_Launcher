import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Cloud, X, Upload, Download, Loader2, CheckCircle, AlertCircle } from 'lucide-react';
import { getArtists, saveArtist, type ArtistData } from '../../services/localLibrary';
import {
  getCurrentBotUserId, getArtistsBackup, uploadArtistsBackup,
  getBackupLog, recordBackup, type BackupLogEntry,
} from '../../services/botService';

function formatLogTime(unixSec: number): string {
  const d = new Date(unixSec * 1000);
  const now = new Date();
  const time = d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === now.toDateString()) return `今天 ${time}`;
  const yesterday = new Date(now); yesterday.setDate(yesterday.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return `昨天 ${time}`;
  return `${d.getMonth() + 1}/${d.getDate()} ${time}`;
}

interface Props {
  isOpen: boolean;
  onClose: () => void;
  onDataChanged?: () => void;
}

export const ArtistCloudManageModal: React.FC<Props> = ({ isOpen, onClose, onDataChanged }) => {
  const [localCount, setLocalCount] = useState(0);
  const [cloudCount, setCloudCount] = useState<number | null>(null);
  const [backupLog, setBackupLog] = useState<BackupLogEntry[]>([]);

  const [isRunning, setIsRunning] = useState(false);
  const [runningType, setRunningType] = useState<'backup' | 'restore' | null>(null);
  const [progress, setProgress] = useState('');
  const [progressPercent, setProgressPercent] = useState(0);
  const isBusyRef = useRef(false);

  const [sessionLogs, setSessionLogs] = useState<Array<{ time: string; type: 'ok' | 'error'; msg: string }>>([]);
  const addLog = useCallback((type: 'ok' | 'error', msg: string) => {
    const time = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    setSessionLogs(prev => [{ time, type, msg }, ...prev].slice(0, 10));
  }, []);

  const loadStats = useCallback(async () => {
    try {
      const locals = await getArtists();
      setLocalCount(locals.filter(a => a.isLocal).length);
      if (getCurrentBotUserId()) {
        try {
          const backup = await getArtistsBackup();
          setCloudCount(backup.count);
        } catch { setCloudCount(null); }
        const log = await getBackupLog();
        // 只显示画师串相关的日志
        setBackupLog(log.filter(e => e.detail.includes('画师串')));
      }
    } catch { }
  }, []);

  useEffect(() => { if (isOpen) { loadStats(); setSessionLogs([]); } }, [isOpen, loadStats]);

  // 备份
  const handleBackup = useCallback(async () => {
    if (isBusyRef.current || !getCurrentBotUserId()) return;
    isBusyRef.current = true;
    setIsRunning(true);
    setRunningType('backup');
    setProgress('准备备份...');
    setProgressPercent(0);
    try {
      const allArtists = await getArtists();
      const locals = allArtists.filter(a => a.isLocal);
      setProgress(`备份 ${locals.length} 个画师串...`);
      setProgressPercent(50);
      const data = locals.map(a => ({
        id: a.id, name: a.name, prompt: a.prompt, previews: a.previews,
        origin: a.origin, publicId: a.publicId, tags: a.tags || [],
        usageCount: a.usageCount, createdTime: a.createdTime,
        addedBy: a.addedBy,
      }));
      const result = await uploadArtistsBackup(data);
      setProgressPercent(100);
      addLog('ok', `画师串备份完成，${result.count} 个`);
      await recordBackup('backup', result.count, `画师串备份 ${result.count} 个`);
      await loadStats();
      onDataChanged?.();
    } catch (err) {
      addLog('error', '画师串备份失败: ' + (err instanceof Error ? err.message : ''));
    } finally {
      isBusyRef.current = false;
      setIsRunning(false);
      setRunningType(null);
      setTimeout(() => { setProgress(''); setProgressPercent(0); }, 1500);
    }
  }, [addLog, loadStats, onDataChanged]);

  // 恢复
  const handleRestore = useCallback(async () => {
    if (isBusyRef.current || !getCurrentBotUserId()) return;

    // 预检
    try {
      setProgress('检查云端数据...');
      const backup = await getArtistsBackup();
      if (backup.artists.length === 0) {
        addLog('ok', '云端无备份数据');
        setProgress('');
        return;
      }
      const locals = await getArtists();
      const localIds = new Set(locals.map(a => a.id));
      const willAdd = backup.artists.filter(a => !localIds.has(a.id as string));
      const willOverwrite = backup.artists.filter(a => localIds.has(a.id as string));
      if (willAdd.length === 0 && willOverwrite.length === 0) {
        addLog('ok', '已是最新，无需恢复');
        setProgress('');
        return;
      }
      if (willOverwrite.length > 0) {
        const names = willOverwrite.slice(0, 5).map(a => a.name as string).join('、');
        const extra = willOverwrite.length > 5 ? ` 等 ${willOverwrite.length} 个` : '';
        if (!confirm(`即将恢复:\n  新增 ${willAdd.length} 个\n  覆盖 ${willOverwrite.length} 个: ${names}${extra}\n\n确定继续？`)) {
          setProgress('');
          return;
        }
      }
    } catch (err) {
      addLog('error', '检查失败: ' + (err instanceof Error ? err.message : ''));
      setProgress('');
      return;
    }

    isBusyRef.current = true;
    setIsRunning(true);
    setRunningType('restore');
    setProgress('恢复中...');
    setProgressPercent(0);
    try {
      const backup = await getArtistsBackup();
      let added = 0, updated = 0;
      for (let i = 0; i < backup.artists.length; i++) {
        const a = backup.artists[i];
        setProgress(`恢复中 ${i + 1}/${backup.artists.length}`);
        setProgressPercent(Math.round(((i + 1) / backup.artists.length) * 90));
        const artistData: ArtistData = {
          id: (a.id as string) || `restore_${Date.now()}_${i}`,
          name: (a.name as string) || '未命名',
          prompt: (a.prompt as string) || '',
          previews: (a.previews as string[]) || [],
          isLocal: true,
          createdAt: (a.createdTime as number) || Date.now(),
          origin: (a.origin as ArtistData['origin']) || 'local',
          publicId: a.publicId as string | undefined,
          tags: (a.tags as string[]) || [],
          usageCount: a.usageCount as number | undefined,
          createdTime: a.createdTime as number | undefined,
          addedBy: a.addedBy as string | undefined,
        };
        const locals = await getArtists();
        const exists = locals.find(l => l.id === artistData.id);
        if (exists) updated++; else added++;
        await saveArtist(artistData);
      }
      setProgressPercent(100);
      const parts: string[] = [];
      if (added > 0) parts.push(`新增 ${added} 个`);
      if (updated > 0) parts.push(`覆盖 ${updated} 个`);
      addLog('ok', `画师串恢复完成，${parts.join('，')}`);
      await recordBackup('restore', backup.artists.length, `画师串恢复 ${parts.join('，')}`);
      await loadStats();
      onDataChanged?.();
    } catch (err) {
      addLog('error', '画师串恢复失败: ' + (err instanceof Error ? err.message : ''));
    } finally {
      isBusyRef.current = false;
      setIsRunning(false);
      setRunningType(null);
      setTimeout(() => { setProgress(''); setProgressPercent(0); }, 1500);
    }
  }, [addLog, loadStats, onDataChanged]);

  if (!isOpen) return null;
  const isAuthed = !!getCurrentBotUserId();

  const lastBackup = backupLog.find(e => e.action === 'backup');
  const lastRestore = backupLog.find(e => e.action === 'restore');

  return (
    <div className="fixed inset-0 z-[102] flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-nai-panel border border-gray-700 rounded-xl shadow-2xl w-[460px] max-h-[85vh] flex flex-col overflow-hidden animate-in zoom-in-95 duration-200" onClick={e => e.stopPropagation()}>
        <div className="px-5 py-4 border-b border-gray-800 flex items-center justify-between bg-nai-dark/50 shrink-0">
          <div className="flex items-center gap-2">
            <Cloud className="w-5 h-5 text-nai-accent" />
            <span className="font-bold text-white text-base">画师串数据备份</span>
          </div>
          <button onClick={onClose} disabled={isRunning} className="text-gray-400 hover:text-white transition-colors disabled:opacity-30"><X className="w-5 h-5" /></button>
        </div>

        <div className="flex-1 overflow-y-auto">
          <div className="px-5 py-4 border-b border-gray-800/50">
            <div className="flex items-baseline justify-between mb-1.5">
              <span className="text-sm text-gray-400">上次备份</span>
              <div className="text-right">
                {lastBackup ? (<><span className="text-sm font-bold text-white">{formatLogTime(lastBackup.time)}</span><span className="text-xs text-gray-500 ml-2">{lastBackup.device}</span></>) : <span className="text-sm text-gray-500">从未备份</span>}
              </div>
            </div>
            <div className="flex items-baseline justify-between mb-3">
              <span className="text-sm text-gray-400">上次恢复</span>
              <div className="text-right">
                {lastRestore ? (<><span className="text-sm font-bold text-white">{formatLogTime(lastRestore.time)}</span><span className="text-xs text-gray-500 ml-2">{lastRestore.device}</span></>) : <span className="text-sm text-gray-500">从未恢复</span>}
              </div>
            </div>
            <div className="flex items-center gap-4 text-xs text-gray-500">
              <span>本地 <span className="text-gray-300 font-bold">{localCount}</span> 个画师串</span>
              <span>·</span>
              <span>云端 <span className="text-gray-300 font-bold">{cloudCount ?? '—'}</span> 个画师串</span>
            </div>
          </div>

          {isRunning && (
            <div className="px-5 py-3 border-b border-gray-800/50 bg-nai-dark/30">
              <div className="flex items-center gap-2 mb-1.5">
                <Loader2 className="w-4 h-4 animate-spin text-nai-accent" />
                <span className="text-sm font-bold text-white">{runningType === 'backup' ? '正在备份...' : '正在恢复...'}</span>
              </div>
              <div className="text-xs text-gray-400 mb-2">{progress}</div>
              <div className="w-full h-1.5 bg-gray-700 rounded-full overflow-hidden">
                <div className="h-full bg-nai-accent rounded-full transition-all duration-300" style={{ width: `${progressPercent}%` }} />
              </div>
            </div>
          )}

          <div className="px-5 py-4 space-y-3">
            <button onClick={handleBackup} disabled={isRunning || !isAuthed}
              className="w-full flex items-center gap-4 p-4 rounded-xl border border-gray-700 bg-nai-dark/30 hover:border-nai-accent/40 hover:bg-nai-accent/5 transition-colors disabled:opacity-40 disabled:cursor-not-allowed text-left group">
              <div className="w-10 h-10 rounded-lg bg-gray-800 group-hover:bg-nai-accent/10 flex items-center justify-center shrink-0 transition-colors">
                <Upload className="w-5 h-5 text-gray-400 group-hover:text-nai-accent transition-colors" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-bold text-white">备份到云端</div>
                <div className="text-xs text-gray-500 mt-0.5">将本地 {localCount} 个画师串上传备份</div>
              </div>
            </button>
            <button onClick={handleRestore} disabled={isRunning || !isAuthed}
              className="w-full flex items-center gap-4 p-4 rounded-xl border border-gray-700 bg-nai-dark/30 hover:border-nai-accent/40 hover:bg-nai-accent/5 transition-colors disabled:opacity-40 disabled:cursor-not-allowed text-left group">
              <div className="w-10 h-10 rounded-lg bg-gray-800 group-hover:bg-nai-accent/10 flex items-center justify-center shrink-0 transition-colors">
                <Download className="w-5 h-5 text-gray-400 group-hover:text-nai-accent transition-colors" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-bold text-white">从备份恢复</div>
                <div className="text-xs text-gray-500 mt-0.5">从云端下载 {cloudCount ?? '?'} 个画师串合并到本地</div>
              </div>
            </button>
            {!isAuthed && <div className="text-center text-xs text-gray-500 py-2">需要 Bot 授权才能使用备份功能</div>}
          </div>

          {sessionLogs.length > 0 && (
            <div className="px-5 pb-3">
              <div className="text-xs text-gray-500 font-bold mb-2">本次操作</div>
              <div className="space-y-1.5">
                {sessionLogs.map((log, i) => (
                  <div key={i} className="flex items-start gap-2 text-xs">
                    <span className="text-gray-600 shrink-0 tabular-nums">{log.time}</span>
                    {log.type === 'error' ? <AlertCircle className="w-3.5 h-3.5 text-red-400 shrink-0 mt-0.5" /> : <CheckCircle className="w-3.5 h-3.5 text-green-400 shrink-0 mt-0.5" />}
                    <span className={log.type === 'error' ? 'text-red-400' : 'text-gray-300'}>{log.msg}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {backupLog.length > 0 && (
            <div className="px-5 pb-4">
              <div className="text-xs text-gray-500 font-bold mb-2">备份历史</div>
              <div className="space-y-1.5 max-h-36 overflow-y-auto">
                {backupLog.map((entry, i) => (
                  <div key={i} className="flex items-start gap-2 text-xs">
                    <span className="text-gray-600 shrink-0 tabular-nums">{formatLogTime(entry.time)}</span>
                    <span className={`shrink-0 px-1.5 py-0.5 rounded text-[10px] font-bold ${entry.action === 'backup' ? 'bg-blue-500/15 text-blue-400' : 'bg-green-500/15 text-green-400'}`}>
                      {entry.action === 'backup' ? '备份' : '恢复'}
                    </span>
                    <span className="text-gray-400 truncate">{entry.device}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
