import React from 'react';
import { CheckCircle, AlertTriangle, Loader2, Download, Upload, RefreshCw } from 'lucide-react';
import {
  exportBackup,
  parseAndPreviewBackup,
  restoreBackup,
  type BackupData,
  type BackupSummary,
  type ExportOptions,
} from '../../services/backupService';

type BackupStatus = { type: 'success' | 'error'; text: string } | null;
type DataCounts = { vibes: number; ocs: number; artists: number; crs: number; presets: number } | null;

interface BackupSettingsSectionProps {
  backupStatus: BackupStatus;
  setBackupStatus: React.Dispatch<React.SetStateAction<BackupStatus>>;
  dataCounts: DataCounts;
  exportOptions: ExportOptions;
  setExportOptions: React.Dispatch<React.SetStateAction<ExportOptions>>;
  isExporting: boolean;
  setIsExporting: React.Dispatch<React.SetStateAction<boolean>>;
  isImporting: boolean;
  setIsImporting: React.Dispatch<React.SetStateAction<boolean>>;
  importPreview: BackupSummary | null;
  setImportPreview: React.Dispatch<React.SetStateAction<BackupSummary | null>>;
  importData: BackupData | null;
  setImportData: React.Dispatch<React.SetStateAction<BackupData | null>>;
}

export const BackupSettingsSection: React.FC<BackupSettingsSectionProps> = ({
  backupStatus,
  setBackupStatus,
  dataCounts,
  exportOptions,
  setExportOptions,
  isExporting,
  setIsExporting,
  isImporting,
  setIsImporting,
  importPreview,
  setImportPreview,
  importData,
  setImportData,
}) => {
  return (
    <div className="space-y-4">
      {/* 状态提示 */}
      {backupStatus && (
        <div className={`p-3 rounded-lg text-sm flex items-center gap-2 ${
          backupStatus.type === 'success'
            ? 'bg-green-900/30 text-green-400 border border-green-800/50'
            : 'bg-red-900/30 text-red-400 border border-red-800/50'
        }`}>
          {backupStatus.type === 'success' ? <CheckCircle className="w-4 h-4 flex-shrink-0" /> : <AlertTriangle className="w-4 h-4 flex-shrink-0" />}
          <span>{backupStatus.text}</span>
        </div>
      )}

      {/* 导出区 */}
      <div className="bg-gray-800/50 rounded-lg border border-gray-700 p-4">
        <label className="block text-xs text-gray-400 mb-3 uppercase tracking-wider">导出备份</label>
        <div className="space-y-1.5 mb-3">
          {([
            { key: 'settings' as const, label: '应用设置 & 生成参数' },
            { key: 'presets' as const, label: '提示词预设', count: dataCounts?.presets },
            { key: 'vibes' as const, label: 'Vibe', count: dataCounts?.vibes },
            { key: 'ocs' as const, label: 'OC (原创角色)', count: dataCounts?.ocs },
            { key: 'artists' as const, label: '画师', count: dataCounts?.artists },
            { key: 'crs' as const, label: '精准参考', count: dataCounts?.crs },
          ]).map(({ key, label, count }) => (
            <label key={key} className="flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-gray-700/30 cursor-pointer text-sm">
              <input
                type="checkbox"
                checked={exportOptions[key]}
                onChange={() => setExportOptions(prev => ({ ...prev, [key]: !prev[key] }))}
                className="w-3.5 h-3.5 rounded accent-nai-accent"
              />
              <span className="text-gray-300 flex-1">{label}</span>
              {count !== undefined && <span className="text-gray-600 text-xs">{count}</span>}
            </label>
          ))}
        </div>
        <button
          onClick={async () => {
            setIsExporting(true);
            setBackupStatus(null);
            try {
              await exportBackup(exportOptions);
              setBackupStatus({ type: 'success', text: '备份文件已导出' });
            } catch (e) {
              setBackupStatus({ type: 'error', text: `导出失败: ${e}` });
            } finally {
              setIsExporting(false);
            }
          }}
          disabled={isExporting || !Object.values(exportOptions).some(Boolean)}
          className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium transition-colors bg-nai-accent/20 text-nai-accent border border-nai-accent/50 hover:bg-nai-accent/30 disabled:opacity-50"
        >
          {isExporting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
          {isExporting ? '正在导出...' : '导出数据'}
        </button>
      </div>

      {/* 导入区 */}
      <div className="bg-gray-800/50 rounded-lg border border-gray-700 p-4">
        <label className="block text-xs text-gray-400 mb-2 uppercase tracking-wider">导入备份</label>
        <p className="text-xs text-gray-500 mb-3">
          从备份文件恢复数据。相同 ID 的项目将被覆盖，其余保留。
        </p>

        {!importPreview ? (
          <label className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium transition-colors bg-gray-900 text-gray-300 border border-gray-700 hover:bg-gray-800 cursor-pointer">
            <Upload className="w-4 h-4" />
            选择备份文件
            <input
              type="file"
              accept=".json"
              className="hidden"
              onChange={async (e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                setBackupStatus(null);
                try {
                  const { summary, data } = await parseAndPreviewBackup(file);
                  setImportPreview(summary);
                  setImportData(data);
                } catch (err) {
                  setBackupStatus({ type: 'error', text: `${err instanceof Error ? err.message : err}` });
                }
                e.target.value = '';
              }}
            />
          </label>
        ) : (
          <div className="space-y-3">
            <div className="bg-gray-900/50 rounded-lg p-3 text-xs space-y-1.5">
              <div className="text-gray-400">
                <span className="text-gray-500">备份时间：</span>
                {new Date(importPreview.createdAt).toLocaleString()}
              </div>
              <div className="text-gray-400 flex flex-wrap gap-x-4 gap-y-1">
                {importPreview.localStorageKeyCount > 0 && <span>设置 {importPreview.localStorageKeyCount} 项</span>}
                {importPreview.vibeCount > 0 && <span>Vibe {importPreview.vibeCount} 个</span>}
                {importPreview.ocCount > 0 && <span>OC {importPreview.ocCount} 个</span>}
                {importPreview.artistCount > 0 && <span>画师 {importPreview.artistCount} 个</span>}
                {importPreview.crCount > 0 && <span>精准参考 {importPreview.crCount} 个</span>}
              </div>
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => { setImportPreview(null); setImportData(null); setBackupStatus(null); }}
                className="flex-1 px-4 py-2 rounded-lg text-sm text-gray-400 bg-gray-900 border border-gray-700 hover:bg-gray-800"
              >
                取消
              </button>
              <button
                onClick={async () => {
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
                    const msg = `已恢复：${parts.join('、')}`;
                    if (result.errors.length > 0) {
                      setBackupStatus({ type: 'error', text: `${msg}（${result.errors.length} 项失败）` });
                    } else {
                      setBackupStatus({ type: 'success', text: msg });
                    }
                  } catch (e) {
                    setBackupStatus({ type: 'error', text: `导入失败: ${e}` });
                  } finally {
                    setIsImporting(false);
                    setImportPreview(null);
                    setImportData(null);
                  }
                }}
                disabled={isImporting}
                className="flex-1 flex items-center justify-center gap-2 px-4 py-2 rounded-lg text-sm font-medium bg-nai-accent/20 text-nai-accent border border-nai-accent/50 hover:bg-nai-accent/30 disabled:opacity-50"
              >
                {isImporting ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle className="w-4 h-4" />}
                {isImporting ? '正在导入...' : '确认导入'}
              </button>
            </div>
          </div>
        )}
      </div>

      {/* 导入后刷新提示 */}
      {backupStatus?.type === 'success' && backupStatus.text.startsWith('已恢复') && (
        <div className="bg-gray-800/50 rounded-lg border border-gray-700 p-4">
          <p className="text-xs text-gray-500 mb-2">导入完成后建议刷新页面以使所有更改生效。</p>
          <button
            onClick={() => window.location.reload()}
            className="w-full flex items-center justify-center gap-2 px-4 py-2 rounded-lg text-sm text-gray-300 bg-gray-900 border border-gray-700 hover:bg-gray-800"
          >
            <RefreshCw className="w-4 h-4" />
            刷新页面
          </button>
        </div>
      )}
    </div>
  );
};
