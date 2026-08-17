import { useEffect, useState } from 'react';
import {
  GEN_MODULE_ORDER_STORAGE_KEY,
  normalizeGenModuleOrder,
  type SortableGenModuleKey,
} from '../../generation/genModules';

// 生图页模块卡顺序的持久化(移动端独占,桌面不动)。读取经 normalizeGenModuleOrder
// 容错(未知 key 过滤、去重、新增模块补尾);隐藏模块不丢槽位 —— 顺序存的是全部
// 可排序 key,可见性只在渲染/剥离/计数时过滤。
export function useMobileModuleOrder() {
  const [order, setOrder] = useState<SortableGenModuleKey[]>(() => {
    try {
      return normalizeGenModuleOrder(
        JSON.parse(localStorage.getItem(GEN_MODULE_ORDER_STORAGE_KEY) ?? 'null'),
      );
    } catch {
      return normalizeGenModuleOrder(null);
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem(GEN_MODULE_ORDER_STORAGE_KEY, JSON.stringify(order));
    } catch {
      // 存储不可用时顺序仅保留在内存(与既有 localStorage 读写的容错口径一致)
    }
  }, [order]);

  return { order, setOrder };
}
