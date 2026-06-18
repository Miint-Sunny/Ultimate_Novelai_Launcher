import React from 'react';

interface MobileSettingsToggleProps {
  enabled: boolean;
  onChange: () => void;
  disabled?: boolean;
}

export const MobileSettingsToggle: React.FC<MobileSettingsToggleProps> = ({
  enabled,
  onChange,
  disabled,
}) => (
  <button
    onClick={onChange}
    disabled={disabled}
    className={`relative w-12 h-7 rounded-full transition-colors duration-200 ${enabled ? 'bg-emerald-500' : 'bg-gray-600'
      } ${disabled ? 'opacity-50' : ''}`}
  >
    <div
      className={`absolute top-1 left-1 w-5 h-5 rounded-full bg-white shadow transition-transform duration-200 ${enabled ? 'translate-x-5' : 'translate-x-0'
        }`}
    />
  </button>
);
