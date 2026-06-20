import React, { useState, useRef, useEffect } from 'react';

export const VibeNumberInput: React.FC<{
  value: number;
  onChange: (value: number) => void;
  style?: React.CSSProperties;
  className?: string;
  title?: string;
}> = ({ value, onChange, style, className, title }) => {
  const [inputValue, setInputValue] = useState((value ?? 0).toString());
  const inputRef = useRef<HTMLInputElement>(null);

  // Refs to keep track of current values for event listener
  const valueRef = useRef(value ?? 0);
  const onChangeRef = useRef(onChange);

  useEffect(() => {
    valueRef.current = value ?? 0;
    onChangeRef.current = onChange;
  }, [value, onChange]);

  useEffect(() => {
    // Sync with prop if the numeric value differs (e.g. from wheel/external update)
    if (value !== undefined && value !== null && parseFloat(inputValue) !== value) {
      setInputValue(value.toString());
    }
  }, [value]);

  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;

    const handleWheel = (e: WheelEvent) => {
      e.preventDefault();
      e.stopPropagation();

      const delta = e.deltaY > 0 ? -0.05 : 0.05;
      const currentVal = valueRef.current;
      let val = Math.max(-10, Math.min(1, currentVal + delta));
      onChangeRef.current(parseFloat(val.toFixed(2)));
    };

    // Use passive: false to allow preventDefault()
    input.addEventListener('wheel', handleWheel, { passive: false });

    return () => {
      input.removeEventListener('wheel', handleWheel);
    };
  }, []);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newVal = e.target.value;
    setInputValue(newVal);

    const num = parseFloat(newVal);
    if (!isNaN(num)) {
      if (num >= -10 && num <= 1) {
        onChange(num);
      }
    }
  };

  const handleBlur = () => {
    let num = parseFloat(inputValue);
    if (isNaN(num)) num = 0;
    if (num < -10) num = -10;
    if (num > 1) num = 1;
    setInputValue(num.toString());
    onChange(num);
  };

  return (
    <input
      ref={inputRef}
      type="number"
      min="-10"
      max="1"
      step="0.01"
      value={inputValue}
      onChange={handleChange}
      onBlur={handleBlur}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.currentTarget.blur();
        }
      }}
      style={style}
      className={className}
      title={title}
    />
  );
};
