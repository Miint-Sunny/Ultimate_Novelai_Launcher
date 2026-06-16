import { useEffect, useState } from 'react';

export function useAprilFools() {
  const [aprilFoolsEffect] = useState(() => {
    const now = new Date();
    if (now.getMonth() === 3 && now.getDate() === 1) {
      return Math.random() < 0.5 ? 0 : 1;
    }
    return -1;
  });
  const [aprilSpinActive, setAprilSpinActive] = useState(true);
  const [aprilCostActive, setAprilCostActive] = useState(true);
  const [aprilFoolsCost, setAprilFoolsCost] = useState(0);

  useEffect(() => {
    if (aprilFoolsEffect !== 1 || !aprilCostActive) return;
    let value = 0;
    let speed = 1;
    const timer = setInterval(() => {
      speed *= 1.03;
      value += Math.floor(speed);
      setAprilFoolsCost(value);
    }, 50);
    return () => clearInterval(timer);
  }, [aprilFoolsEffect, aprilCostActive]);

  return {
    aprilFoolsEffect,
    aprilSpinActive,
    setAprilSpinActive,
    aprilCostActive,
    setAprilCostActive,
    aprilFoolsCost,
    resetAprilFoolsCost: () => setAprilFoolsCost(0),
  };
}
