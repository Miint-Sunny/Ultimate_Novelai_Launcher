import React from 'react';

export interface CategoryGroupProps {
  title: string;
  tone: 'nsfw' | 'common';
  categories: string[];
  selectedCategories: string[];
  onToggle: (category: string) => void;
}

// 灵感分类组：标题 + 标签云，按 tone（nsfw/common）着色。
export function CategoryGroup({ title, tone, categories, selectedCategories, onToggle }: CategoryGroupProps) {
  const colorClass = tone === 'nsfw' ? 'text-pink-400' : 'text-green-400';
  const prefix = tone === 'nsfw' ? 'nsfw' : 'common';

  return (
    <div>
      <div className="flex items-center gap-2 mb-2">
        <span className={`text-sm font-bold ${colorClass}`}>{title}</span>
        <span className="text-xs text-gray-500">({categories.length})</span>
      </div>
      <div className="flex flex-wrap gap-2">
        {categories.map((category) => {
          const key = `${prefix}:${category}`;
          const isSelected = selectedCategories.includes(key);
          const selectedClass = tone === 'nsfw'
            ? 'bg-pink-500/30 text-pink-300 border border-pink-500/50'
            : 'bg-green-500/30 text-green-300 border border-green-500/50';

          return (
            <button
              key={key}
              onClick={() => onToggle(key)}
              className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${isSelected
                ? selectedClass
                : 'bg-gray-800 text-gray-400 border border-gray-700'
                }`}
            >
              {category}
            </button>
          );
        })}
      </div>
    </div>
  );
}
