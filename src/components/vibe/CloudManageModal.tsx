import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Cloud, X, Upload, Download, Loader2, CheckCircle, AlertCircle } from 'lucide-react';
import { getVibes, getVibeTagPool, pushAllToCloud, syncVibesFromCloud, type SyncResult } from '../../services/localLibrary';
import {
  getCurrentBotUserId, getCloudVibesStrict, getCloudTagPool, putCloudTagPool,
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

interface CloudManageModalProps {
  isOpen: boolean;
  onClose: () => void;
  onDataChanged?: () => void;
}

export const CloudManageModal: React.FC<CloudManageModalProps> = ({
  isOpen,
  onClose,
  onDataChanged,
}) => {
  const [localCount, setLocalCount] = useState(0);
  const [cloudCount, setCloudCount] = useState<number | null>(null);
  const [backupLog, setBackupLog] = useState<BackupLogEntry[]>([]);

  const [isRunning, setIsRunning] = useState(false);
  const [runningType, setRunningType] = useState<'backup' | 'restore' | null>(null);
  const [progress, setProgress] = useState('');
  const [progressPercent, setProgressPercent] = useState(0);
  const isBusyRef = useRef(false);

  // 本次会话的操作日志（不持久化，只在弹窗内显示）
  const [sessionLogs, setSessionLogs] = useState<Array<{ time: string; type: 'ok' | 'error'; msg: string }>>([]);
  const addSessionLog = useCallback((type: 'ok' | 'error', msg: string) => {
    const time = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    setSessionLogs(prev => [{ time, type, msg }, ...prev].slice(0, 10));
  }, []);

  const loadStats = useCallback(async () => {
    try {
      const localVibes = await getVibes();
      setLocalCount(localVibes.length);
      if (getCurrentBotUserId()) {
        try {
          const cloudVibes = await getCloudVibesStrict();
          setCloudCount(cloudVibes.length);
        } catch { setCloudCount(null); }
        const log = await getBackupLog();
        setBackupLog(log);
      }
    } catch { }
  }, []);

  useEffect(() => { if (isOpen) { loadStats(); setSessionLogs([]); } }, [isOpen, loadStats]);

  // 备份到云端
  const handleBackup = useCallback(async () => {
    if (isBusyRef.current || !getCurrentBotUserId()) return;
    isBusyRef.current = true;
    setIsRunning(true);
    setRunningType('backup');
    setProgress('准备备份...');
    setProgressPercent(0);
    try {
      const result = await pushAllToCloud((cur, total) => {
        setProgress(`备份中 ${cur}/${total}`);
        setProgressPercent(Math.round((cur / total) * 90));
      });
      setProgress('备份标签...');
      setProgressPercent(95);
      const localPool = await getVibeTagPool();
      await putCloudTagPool(localPool).catch(() => {});
      setProgressPercent(100);

      const parts: string[] = [];
      if (result.pushed > 0) parts.push(`备份 ${result.pushed} 个`);
      if (result.skipped > 0) parts.push(`跳过 ${result.skipped} 个`);
      if (result.failed > 0) parts.push(`失败 ${result.failed} 个`);
      const detail = parts.join('，') || '已是最新';
      addSessionLog(result.failed > 0 ? 'error' : 'ok', detail);

      // 写云端备份记录
      const localVibes = await getVibes();
      await recordBackup('backup', localVibes.length, detail);
      await loadStats();
      onDataChanged?.();
    } catch (err) {
      addSessionLog('error', '备份失败: ' + (err instanceof Error ? err.message : '未知错误'));
    } finally {
      isBusyRef.current = false;
      setIsRunning(false);
      setRunningType(null);
      setTimeout(() => { setProgress(''); setProgressPercent(0); }, 1500);
    }
  }, [addSessionLog, loadStats, onDataChanged]);

  // 从备份恢复
  const handleRestore = useCallback(async () => {
    if (isBusyRef.current || !getCurrentBotUserId()) return;

    // 预检：对比冲突
    try {
      setProgress('检查云端数据...');
      const [cloudVibes, localVibes] = await Promise.all([getCloudVibesStrict(), getVibes()]);
      const localById = new Map(localVibes.map(v => [v.id, v]));
      const willAdd: string[] = [];
      const willOverwrite: string[] = [];
      for (const cloud of cloudVibes) {
        const local = localById.get(cloud.id);
        if (!local) willAdd.push(cloud.name);
        else if (cloud.metaHash && local.metaHash !== cloud.metaHash) willOverwrite.push(local.name);
      }
      if (willAdd.length === 0 && willOverwrite.length === 0) {
        addSessionLog('ok', '已是最新，无需恢复');
        setProgress('');
        return;
      }
      if (willOverwrite.length > 0) {
        const list = willOverwrite.length <= 5
          ? willOverwrite.join('、')
          : willOverwrite.slice(0, 5).join('、') + ` 等 ${willOverwrite.length} 个`;
        const msg = [
          `即将从云端恢复:`,
          willAdd.length > 0 ? `  新增 ${willAdd.length} 个 Vibe` : '',
          `  覆盖 ${willOverwrite.length} 个本地 Vibe:`,
          `  ${list}`,
          '',
          '被覆盖的本地版本将丢失，确定继续？',
        ].filter(Boolean).join('\n');
        if (!confirm(msg)) { setProgress(''); return; }
      }
    } catch (err) {
      addSessionLog('error', '检查失败: ' + (err instanceof Error ? err.message : ''));
      setProgress('');
      return;
    }

    isBusyRef.current = true;
    setIsRunning(true);
    setRunningType('restore');
    setProgress('恢复中...');
    setProgressPercent(0);
    try {
      const result: SyncResult = await syncVibesFromCloud((msg) => {
        setProgress(msg);
        const match = msg.match(/(\d+)\/(\d+)/);
        if (match) setProgressPercent(Math.round((parseInt(match[1]) / parseInt(match[2])) * 90));
      });
      setProgressPercent(100);

      const parts: string[] = [];
      if (result.added > 0) parts.push(`新增 ${result.added} 个`);
      if (result.updated > 0) parts.push(`覆盖 ${result.updated} 个`);
      if (result.skipped > 0) parts.push(`跳过 ${result.skipped} 个`);
      const detail = parts.join('，') || '已是最新';
      addSessionLog('ok', detail);

      await recordBackup('restore', localCount, detail);
      await loadStats();
      onDataChanged?.();
    } catch (err) {
      addSessionLog('error', '恢复失败: ' + (err instanceof Error ? err.message : ''));
    } finally {
      isBusyRef.current = false;
      setIsRunning(false);
      setRunningType(null);
      setTimeout(() => { setProgress(''); setProgressPercent(0); }, 1500);
    }
  }, [addSessionLog, loadStats, onDataChanged, localCount]);

  if (!isOpen) return null;
  const isAuthed = !!getCurrentBotUserId();

  // 从云端记录中提取上次备份/恢复
  const lastBackupEntry = backupLog.find(e => e.action === 'backup');
  const lastRestoreEntry = backupLog.find(e => e.action === 'restore');

  return (
    <div className="fixed inset-0 z-[102] flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div
        className="bg-nai-panel border border-gray-700 rounded-xl shadow-2xl w-[460px] max-h-[85vh] flex flex-col overflow-hidden animate-in zoom-in-95 duration-200"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-5 py-4 border-b border-gray-800 flex items-center justify-between bg-nai-dark/50 shrink-0">
          <div className="flex items-center gap-2">
            <Cloud className="w-5 h-5 text-nai-accent" />
            <span className="font-bold text-white text-base">Vibe 数据备份</span>
          </div>
          <button onClick={onClose} disabled={isRunning} className="text-gray-400 hover:text-white transition-colors disabled:opacity-30">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto">
          {/* 备份状态 */}
          <div className="px-5 py-4 border-b border-gray-800/50">
            <div className="flex items-baseline justify-between mb-1.5">
              <span className="text-sm text-gray-400">上次备份</span>
              <div className="text-right">
                {lastBackupEntry ? (
                  <>
                    <span className="text-sm font-bold text-white">{formatLogTime(lastBackupEntry.time)}</span>
                    <span className="text-xs text-gray-500 ml-2">{lastBackupEntry.device}</span>
                  </>
                ) : (
                  <span className="text-sm text-gray-500">从未备份</span>
                )}
              </div>
            </div>
            <div className="flex items-baseline justify-between mb-3">
              <span className="text-sm text-gray-400">上次恢复</span>
              <div className="text-right">
                {lastRestoreEntry ? (
                  <>
                    <span className="text-sm font-bold text-white">{formatLogTime(lastRestoreEntry.time)}</span>
                    <span className="text-xs text-gray-500 ml-2">{lastRestoreEntry.device}</span>
                  </>
                ) : (
                  <span className="text-sm text-gray-500">从未恢复</span>
                )}
              </div>
            </div>
            <div className="flex items-center gap-4 text-xs text-gray-500">
              <span>本地 <span className="text-gray-300 font-bold">{localCount}</span> 个 Vibe</span>
              <span>·</span>
              <span>云端 <span className="text-gray-300 font-bold">{cloudCount ?? '—'}</span> 个 Vibe</span>
            </div>
          </div>

          {/* 进度条 */}
          {isRunning && (
            <div className="px-5 py-3 border-b border-gray-800/50 bg-nai-dark/30">
              <div className="flex items-center gap-2 mb-1.5">
                <Loader2 className="w-4 h-4 animate-spin text-nai-accent" />
                <span className="text-sm font-bold text-white">
                  {runningType === 'backup' ? '正在备份...' : '正在恢复...'}
                </span>
              </div>
              <div className="text-xs text-gray-400 mb-2">{progress}</div>
              <div className="w-full h-1.5 bg-gray-700 rounded-full overflow-hidden">
                <div className="h-full bg-nai-accent rounded-full transition-all duration-300" style={{ width: `${progressPercent}%` }} />
              </div>
            </div>
          )}

          {/* 操作 */}
          <div className="px-5 py-4 space-y-3">
            <button
              onClick={handleBackup}
              disabled={isRunning || !isAuthed}
              className="w-full flex items-center gap-4 p-4 rounded-xl border border-gray-700 bg-nai-dark/30 hover:border-nai-accent/40 hover:bg-nai-accent/5 transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:border-gray-700 disabled:hover:bg-nai-dark/30 text-left group"
            >
              <div className="w-10 h-10 rounded-lg bg-gray-800 group-hover:bg-nai-accent/10 flex items-center justify-center shrink-0 transition-colors">
                <Upload className="w-5 h-5 text-gray-400 group-hover:text-nai-accent transition-colors" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-bold text-white">备份到云端</div>
                <div className="text-xs text-gray-500 mt-0.5">将本地 {localCount} 个 Vibe 和标签上传备份</div>
              </div>
            </button>

            <button
              onClick={handleRestore}
              disabled={isRunning || !isAuthed}
              className="w-full flex items-center gap-4 p-4 rounded-xl border border-gray-700 bg-nai-dark/30 hover:border-nai-accent/40 hover:bg-nai-accent/5 transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:border-gray-700 disabled:hover:bg-nai-dark/30 text-left group"
            >
              <div className="w-10 h-10 rounded-lg bg-gray-800 group-hover:bg-nai-accent/10 flex items-center justify-center shrink-0 transition-colors">
                <Download className="w-5 h-5 text-gray-400 group-hover:text-nai-accent transition-colors" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-bold text-white">从备份恢复</div>
                <div className="text-xs text-gray-500 mt-0.5">从云端下载 {cloudCount ?? '?'} 个 Vibe 合并到本地</div>
              </div>
            </button>

            {!isAuthed && (
              <div className="text-center text-xs text-gray-500 py-2">需要 Bot 授权才能使用备份功能</div>
            )}
          </div>

          {/* 本次操作记录 */}
          {sessionLogs.length > 0 && (
            <div className="px-5 pb-3">
              <div className="text-xs text-gray-500 font-bold mb-2">本次操作</div>
              <div className="space-y-1.5">
                {sessionLogs.map((log, i) => (
                  <div key={i} className="flex items-start gap-2 text-xs">
                    <span className="text-gray-600 shrink-0 tabular-nums">{log.time}</span>
                    {log.type === 'error'
                      ? <AlertCircle className="w-3.5 h-3.5 text-red-400 shrink-0 mt-0.5" />
                      : <CheckCircle className="w-3.5 h-3.5 text-green-400 shrink-0 mt-0.5" />}
                    <span className={log.type === 'error' ? 'text-red-400' : 'text-gray-300'}>{log.msg}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* 云端备份历史 */}
          {backupLog.length > 0 && (
            <div className="px-5 pb-4">
              <div className="text-xs text-gray-500 font-bold mb-2">备份历史</div>
              <div className="space-y-1.5 max-h-36 overflow-y-auto">
                {backupLog.map((entry, i) => (
                  <div key={i} className="flex items-start gap-2 text-xs">
                    <span className="text-gray-600 shrink-0 tabular-nums">{formatLogTime(entry.time)}</span>
                    <span className={`shrink-0 px-1.5 py-0.5 rounded text-[10px] font-bold ${
                      entry.action === 'backup' ? 'bg-blue-500/15 text-blue-400' : 'bg-green-500/15 text-green-400'
                    }`}>
                      {entry.action === 'backup' ? '备份' : '恢复'}
                    </span>
                    <span className="text-gray-400 truncate">{entry.device}</span>
                    {entry.vibe_count > 0 && <span className="text-gray-600 shrink-0">{entry.vibe_count} 个</span>}
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
