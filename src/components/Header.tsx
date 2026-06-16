import React from 'react';
import { Menu, Plus, PenTool } from 'lucide-react';

export const Header: React.FC = () => {
  return (
    <header className="h-14 bg-nai-panel border-b border-gray-800 flex items-center justify-between px-4 shrink-0 z-20">
      <div className="flex items-center gap-4">
        <div className="w-8 h-8 flex items-center justify-center">
             <PenTool className="w-6 h-6 text-white transform -rotate-135" />
        </div>
      </div>

      <div className="flex items-center bg-nai-input rounded overflow-hidden border border-gray-700">
        <div className="px-3 py-1 text-sm font-medium text-white flex items-center gap-1">
          <span className="text-gray-400">Anlas:</span>
          <span className="text-nai-accent">8505</span>
          <span className="text-xs text-nai-accent">💎</span>
        </div>
        <button className="p-1.5 bg-nai-input hover:bg-gray-700 transition-colors border-l border-gray-700">
          <Plus className="w-4 h-4 text-white" />
        </button>
      </div>

      <button className="p-2 hover:bg-gray-800 rounded">
        <Menu className="w-6 h-6 text-gray-300" />
      </button>
    </header>
  );
};
