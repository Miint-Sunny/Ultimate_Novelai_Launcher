import React, { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle, Download, Loader2, RefreshCw, Upload } from 'lucide-react';
import {
  DEFAULT_EXPORT_OPTIONS,
  exportBackup,
  getDataCounts,
  parseAndPreviewBackup,
  restoreBackup,
  type BackupData,
  type BackupSummary,
  type ExportOptions,
} from '../../../services/backupService';

export const MobileBackupSettingsSection: React.FC = () => {
  const [isExporting, setIsExporting] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [importPreview, setImportPreview] = useState<BackupSummary | null>(null);
  const [importData, setImportData] = useState<BackupData | null>(null);
  const [backupStatus, setBackupStatus] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [exportOptions, setExportOptions] = useState<ExportOptions>({ ...DEFAULT_EXPORT_OPTIONS });
  const [dataCounts, setDataCounts] = useState<{ vibes: number; ocs: number; artists: number; crs: number; presets: number } | null>(null);

  useEffect(() => {
    getDataCounts().then(setDataCounts);
  }, []);

  const handleExport = async () => {
    setIsExporting(true);
    setBackupStatus(null);
    try {
      await exportBackup(exportOptions);
      setBackupStatus({ type: 'success', text: '备份文件已导出' });
    } catch (error) {
      setBackupStatus({ type: 'error', text: `导出失败: ${error}` });
    } finally {
      setIsExporting(false);
    }
  };

  const handleSelectImportFile = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setBackupStatus(null);
    try {
      const { summary, data } = await parseAndPreviewBackup(file);
      setImportPreview(summary);
      setImportData(data);
    } catch (error) {
      setBackupStatus({ type: 'error', text: `${error instanceof Error ? error.message : error}` });
    }
    event.target.value = '';
  };

  const handleCancelImport = () => {
    setImportPreview(null);
    setImportData(null);
    setBackupStatus(null);
  };

  const handleConfirmImport = async () => {
    if (!importData) return;
    setIsImporting(true);
    setBackupStatus(null);
    try {
      const result = await restoreBackup(importData);
      const parts = [];
      if (result.restored.localStorageKeys > 0) parts.push(`设置 ${result.restored.localStorageKeys} 项`);
      if (result.restored.vibes > 0) parts.push(`Vibe ${result.restored.vibes} 个`);
      if (result.restored.ocs > 0) parts.push(`OC ${result.restored.ocs} 个`);
      if (result.restored.artists > 0) parts.push(`画师 ${result.restored.artists} 个`);
      if (result.restored.crs > 0) parts.push(`精准参考 ${result.restored.crs} 个`);
      const message = `已恢复：${parts.join('、')}`;
      if (result.errors.length > 0) {
        setBackupStatus({ type: 'error', text: `${message}（${result.errors.length} 项失败）` });
      } else {
        setBackupStatus({ type: 'success', text: message });
      }
    } catch (error) {
      setBackupStatus({ type: 'error', text: `导入失败: ${error}` });
    } finally {
      setIsImporting(false);
      setImportPreview(null);
      setImportData(null);
    }
  };

  return (
    <div className="p-4 space-y-4">
      {backupStatus && (
        <div className={`p-3 rounded-xl text-sm flex items-start gap-2 ${
          backupStatus.type === 'success'
            ? 'bg-green-900/30 text-green-400 border border-green-800/50'
            : 'bg-red-900/30 text-red-400 border border-red-800/50'
        }`}>
          {backupStatus.type === 'success' ? <CheckCircle className="w-4 h-4 mt-0.5 flex-shrink-0" /> : <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" />}
          <span>{backupStatus.text}</span>
        </div>
      )}

      <div className="bg-nai-input rounded-xl border border-gray-700/50 p-4 space-y-3">
        <div className="text-xs text-gray-500 uppercase tracking-wider">导出备份</div>
        <div className="space-y-1">
          {([
            { key: 'settings' as const, label: '应用设置 & 生成参数' },
            { key: 'presets' as const, label: '提示词预设', count: dataCounts?.presets },
            { key: 'vibes' as const, label: 'Vibe', count: dataCounts?.vibes },
            { key: 'ocs' as const, label: 'OC (原创角色)', count: dataCounts?.ocs },
            { key: 'artists' as const, label: '画师', count: dataCounts?.artists },
            { key: 'crs' as const, label: '精准参考', count: dataCounts?.crs },
          ]).map(({ key, label, count }) => (
            <label key={key} className="flex items-center gap-2.5 px-2 py-2 rounded-lg active:bg-gray-700/30 cursor-pointer text-sm">
              <input
                type="checkbox"
                checked={exportOptions[key]}
                onChange={() => setExportOptions((prev) => ({ ...prev, [key]: !prev[key] }))}
                className="w-4 h-4 rounded accent-nai-accent"
              />
              <span className="text-gray-300 flex-1">{label}</span>
              {count !== undefined && <span className="text-gray-600 text-xs">{count}</span>}
            </label>
          ))}
        </div>
        <button
          onClick={handleExport}
          disabled={isExporting || !Object.values(exportOptions).some(Boolean)}
          className="w-full flex items-center justify-center gap-2 py-3 rounded-xl text-sm font-medium bg-nai-accent/20 text-nai-accent border border-nai-accent/50 active:bg-nai-accent/30 disabled:opacity-50"
        >
          {isExporting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
          {isExporting ? '正在导出...' : '导出数据'}
        </button>
      </div>

      <div className="bg-nai-input rounded-xl border border-gray-700/50 p-4 space-y-3">
        <div className="text-xs text-gray-500 uppercase tracking-wider">导入备份</div>
        <p className="text-xs text-gray-500">
          从备份文件恢复数据。相同 ID 的项目将被覆盖，其余保留。
        </p>

        {!importPreview ? (
          <label className="w-full flex items-center justify-center gap-2 py-3 rounded-xl text-sm font-medium bg-gray-800/80 text-gray-300 border border-gray-700/50 active:bg-gray-700/80 cursor-pointer">
            <Upload className="w-4 h-4" />
            选择备份文件
            <input
              type="file"
              accept=".json"
              className="hidden"
              onChange={handleSelectImportFile}
            />
          </label>
        ) : (
          <div className="space-y-3">
            <div className="bg-gray-900/50 rounded-xl p-3 text-xs space-y-1.5">
              <div className="text-gray-400">
                <span className="text-gray-500">备份时间：</span>
                {new Date(importPreview.createdAt).toLocaleString()}
              </div>
              <div className="text-gray-400 flex flex-wrap gap-x-3 gap-y-1">
                {importPreview.localStorageKeyCount > 0 && <span>设置 {importPreview.localStorageKeyCount} 项</span>}
                {importPreview.vibeCount > 0 && <span>Vibe {importPreview.vibeCount} 个</span>}
                {importPreview.ocCount > 0 && <span>OC {importPreview.ocCount} 个</span>}
                {importPreview.artistCount > 0 && <span>画师 {importPreview.artistCount} 个</span>}
                {importPreview.crCount > 0 && <span>精准参考 {importPreview.crCount} 个</span>}
              </div>
            </div>
            <div className="flex gap-2">
              <button
                onClick={handleCancelImport}
                className="flex-1 py-2.5 rounded-xl text-sm text-gray-400 bg-gray-800/80 border border-gray-700/50 active:bg-gray-700/80"
              >
                取消
              </button>
              <button
                onClick={handleConfirmImport}
                disabled={isImporting}
                className="flex-1 flex items-center justify-center gap-2 py-2.5 rounded-xl text-sm font-medium bg-nai-accent/20 text-nai-accent border border-nai-accent/50 active:bg-nai-accent/30 disabled:opacity-50"
              >
                {isImporting ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle className="w-4 h-4" />}
                {isImporting ? '正在导入...' : '确认导入'}
              </button>
            </div>
          </div>
        )}
      </div>

      {backupStatus?.type === 'success' && backupStatus.text.startsWith('已恢复') && (
        <div className="bg-nai-input rounded-xl border border-gray-700/50 p-4 space-y-2">
          <p className="text-xs text-gray-500">导入完成后建议刷新页面以使所有更改生效。</p>
          <button
            onClick={() => window.location.reload()}
            className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xl text-sm text-gray-300 bg-gray-800/80 border border-gray-700/50 active:bg-gray-700/80"
          >
            <RefreshCw className="w-4 h-4" />
            刷新页面
          </button>
        </div>
      )}
    </div>
  );
};
