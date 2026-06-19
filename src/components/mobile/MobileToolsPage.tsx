import React, { useState } from 'react';
import { ArrowLeftRight, FileSearch } from 'lucide-react';
import { useDragDrop } from '../../contexts/DragDropContext';
import { MobileMetadataToolSection } from './tools/MobileMetadataToolSection';
import { MobileWeightToolSection } from './tools/MobileWeightToolSection';

// MetadataFile 真相源在 ./tools/types.ts，此处 re-export 保持对外 API 稳定。
export type { MetadataFile } from './tools/types';

type ToolType = 'metadata' | 'weight';

export const MobileToolsPage: React.FC = () => {
  const [activeTool, setActiveTool] = useState<ToolType>('weight');
  const { processFileForTarget } = useDragDrop();

  return (
    <div className="flex flex-col h-full bg-nai-bg relative">
      <header className="shrink-0 bg-nai-panel border-b border-gray-800">
        <div className="px-4 py-3">
          <h1 className="text-lg font-semibold">工具箱</h1>
        </div>
        <div className="flex px-4 pb-2 gap-1">
          {([
            { id: 'weight' as const, label: '权重转换', icon: ArrowLeftRight },
            { id: 'metadata' as const, label: '元数据', icon: FileSearch },
          ] as const).map((tool) => (
            <button
              key={tool.id}
              onClick={() => setActiveTool(tool.id)}
              className={`flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                activeTool === tool.id ? 'bg-nai-accent/15 text-nai-accent' : 'text-gray-400 active:text-white'
              }`}
            >
              <tool.icon className="w-4 h-4" />
              {tool.label}
            </button>
          ))}
        </div>
      </header>

      {activeTool === 'weight' && (
        <MobileWeightToolSection processFileForTarget={processFileForTarget} />
      )}
      {activeTool === 'metadata' && (
        <MobileMetadataToolSection processFileForTarget={processFileForTarget} />
      )}
    </div>
  );
};
