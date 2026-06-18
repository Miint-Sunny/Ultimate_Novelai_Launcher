import React from 'react';

// 高级设置页通用的滑块控件。
export interface SliderControlProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
}

export const SliderControl: React.FC<SliderControlProps> = ({ label, value, min, max, step, onChange }) => (
  <div className="space-y-2">
    <div className="flex items-center justify-between">
      <span className="text-sm font-medium text-gray-300">{label}</span>
      <span className="text-sm font-mono text-nai-accent">{value}</span>
    </div>
    <input
      type="range"
      min={min}
      max={max}
      step={step}
      value={value}
      onChange={(event) => onChange(parseFloat(event.target.value))}
      className="w-full h-2 bg-gray-700 rounded-lg appearance-none cursor-pointer accent-nai-accent"
    />
  </div>
);

// 高级设置页通用的选项网格控件。
export interface OptionGridProps {
  label: string;
  options: Array<{ id: string; name: string }>;
  value: string;
  onChange: (value: string) => void;
}

export const OptionGrid: React.FC<OptionGridProps> = ({ label, options, value, onChange }) => (
  <div className="space-y-2">
    <span className="text-sm font-medium text-gray-300">{label}</span>
    <div className="grid grid-cols-2 gap-2">
      {options.map((option) => (
        <button
          key={option.id}
          onClick={() => onChange(option.id)}
          className={`py-2.5 px-3 rounded-lg text-sm font-medium transition-colors ${value === option.id
            ? 'bg-nai-accent/20 text-nai-accent border border-nai-accent/50'
            : 'bg-gray-800 text-gray-400 border border-gray-700'
            }`}
        >
          {option.name}
        </button>
      ))}
    </div>
  </div>
);
