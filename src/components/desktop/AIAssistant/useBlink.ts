import { useEffect, useState } from 'react';

/** 猫娘头像随机眨眼（2.5-6.5s 闭眼 140ms） */
export function useBlink(): boolean {
  const [blink, setBlink] = useState(false);
  useEffect(() => {
    let t1: number | undefined;
    let t2: number | undefined;
    const loop = () => {
      const wait = 2500 + Math.random() * 4000;
      t1 = window.setTimeout(() => {
        setBlink(true);
        t2 = window.setTimeout(() => {
          setBlink(false);
          loop();
        }, 140);
      }, wait);
    };
    loop();
    return () => {
      if (t1) window.clearTimeout(t1);
      if (t2) window.clearTimeout(t2);
    };
  }, []);
  return blink;
}
