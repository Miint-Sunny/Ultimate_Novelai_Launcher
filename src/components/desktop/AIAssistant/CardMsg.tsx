import React, { useState } from 'react';
import type { AssistantCard } from '../../../services/agentService';
import { C } from './tokens';
import { TagChip } from './TagChip';
import { splitPromptToTags } from './tokens';
import type { VMsg } from './types';

/**
 * 固定指令的结果卡片。数据全部来自 card（可序列化）；
 * 动作按 kind 派生，回调由 AgentDock 注入（导入需要在运行时重取原图）。
 */
export const CardMsg: React.FC<{
  m: VMsg;
  onImportMetadata?: (m: VMsg) => void;
}> = ({ m, onImportMetadata }) => {
  const card = m.card as AssistantCard;
  const [showNegative, setShowNegative] = useState(false);
  const [copied, setCopied] = useState(false);

  const meta = card.kind === 'metadata' ? card.metadata : undefined;
  const tags = meta?.prompt ? splitPromptToTags(meta.prompt) : [];

  const copyTags = () => {
    if (!meta?.prompt) return;
    navigator.clipboard?.writeText(meta.prompt);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

  const paramRows: Array<[string, string]> = meta
    ? ([
        ['来源', meta.source],
        ['尺寸', meta.width && meta.height ? `${meta.width}×${meta.height}` : ''],
        ['种子', meta.seed ?? ''],
        ['步数', meta.steps ?? ''],
        ['采样器', meta.sampler ?? ''],
        ['CFG', meta.scale ?? ''],
      ].filter(([, v]) => v !== '' && v !== undefined) as Array<[string, string]>)
    : [];

  return (
    <div className="aa-msg-in" style={{ display: 'flex', justifyContent: 'flex-start' }}>
      <div
        style={{
          maxWidth: '94%',
          width: '100%',
          background: C.panel2,
          border: `1px solid ${C.border}`,
          borderRadius: 12,
          padding: '10px 12px',
          fontSize: 12,
          color: C.text2,
        }}
      >
        {/* 标题行 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
          <span style={{ color: C.accent, fontWeight: 700 }}>{card.title}</span>
          <span style={{ marginLeft: 'auto', color: C.textMute, fontSize: 10 }}>{m.ts}</span>
        </div>

        {card.kind === 'info' && (
          <>
            {card.body && <div style={{ whiteSpace: 'pre-wrap', lineHeight: 1.6 }}>{card.body}</div>}
            {card.hint && (
              <div style={{ marginTop: 6, color: C.textMute, fontSize: 11 }}>{card.hint}</div>
            )}
          </>
        )}

        {card.kind === 'metadata' && meta && (
          <>
            {/* 参数网格 */}
            {paramRows.length > 0 && (
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fill, minmax(96px, 1fr))',
                  gap: 4,
                  marginBottom: 8,
                }}
              >
                {paramRows.map(([k, v]) => (
                  <div
                    key={k}
                    style={{
                      background: C.surface,
                      borderRadius: 6,
                      padding: '4px 7px',
                      minWidth: 0,
                    }}
                  >
                    <div style={{ color: C.textMute, fontSize: 10 }}>{k}</div>
                    <div
                      style={{
                        color: C.text,
                        fontSize: 11,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                      title={String(v)}
                    >
                      {String(v)}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* 正向 tags */}
            {tags.length > 0 && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 6 }}>
                {tags.slice(0, 40).map((t, i) => (
                  <TagChip key={`${t}-${i}`}>{t}</TagChip>
                ))}
                {tags.length > 40 && (
                  <span style={{ color: C.textMute, fontSize: 10, alignSelf: 'center' }}>
                    +{tags.length - 40}
                  </span>
                )}
              </div>
            )}

            {/* 负向（折叠） */}
            {meta.negativePrompt && (
              <div style={{ marginBottom: 6 }}>
                <button
                  className="aa-btn"
                  style={{ color: C.textDim, fontSize: 11, padding: 0, background: 'none', border: 'none', cursor: 'pointer' }}
                  onClick={() => setShowNegative(v => !v)}
                >
                  {showNegative ? '▾ 负向提示词' : '▸ 负向提示词'}
                </button>
                {showNegative && (
                  <div
                    style={{
                      marginTop: 4,
                      padding: '6px 8px',
                      background: C.surface,
                      borderRadius: 6,
                      color: C.textDim,
                      fontSize: 11,
                      lineHeight: 1.5,
                      wordBreak: 'break-all',
                    }}
                  >
                    {meta.negativePrompt}
                  </div>
                )}
              </div>
            )}

            {/* 角色提示词 */}
            {meta.characterPrompts && meta.characterPrompts.length > 0 && (
              <div style={{ marginBottom: 6, color: C.textDim, fontSize: 11 }}>
                {meta.characterPrompts.length} 个角色提示词
              </div>
            )}

            {/* 动作 */}
            <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
              {onImportMetadata && (
                <button className="aa-btn aa-btn-cell" style={actionBtnStyle(true)} onClick={() => onImportMetadata(m)}>
                  导入到左栏
                </button>
              )}
              {tags.length > 0 && (
                <button className="aa-btn aa-btn-cell" style={actionBtnStyle(false)} onClick={copyTags}>
                  {copied ? '已复制' : '复制正向 tags'}
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
};

function actionBtnStyle(primary: boolean): React.CSSProperties {
  return {
    fontSize: 11,
    padding: '4px 10px',
    borderRadius: 8,
    cursor: 'pointer',
    border: `1px solid ${primary ? C.accentLine : C.border}`,
    background: primary ? C.accentSoft : 'transparent',
    color: primary ? C.accent : C.text2,
  };
}
