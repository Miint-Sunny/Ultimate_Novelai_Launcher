// 让校验脚本能直接加载前端源码模块。
//
// 为什么需要这一层:前端源码按 vite 的解析规则写(`from './localLibrary'` 这种目录
// import 落到 index.ts),而 node 的 ESM 解析不认目录 import;另外少数模块在模块级
// 就读 localStorage / 挂 window 事件。两者叠加的结果是 `src/services/novelai.ts`
// ——也就是真正拼请求载荷的那个文件——在 node 里根本 import 不起来,于是
// check-v5-parity 至今只能断言注册表、计费、预设文本这些「周边」,
// 碰不到载荷本身。而按 PARAMETER_MAPPING.md 的说法,载荷恰恰是最贵的一层:
// params_version 传错不报错只静默丢角色坐标,ucPreset 与 ucPresetId 混发出错,
// 发 sm:true 直接 HTTP 500。
//
// 这里补的是解析与运行环境,**不改任何产品代码**,断言到的就是线上那份实现。
import { registerHooks } from 'node:module';
import { statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const DIRECTORY_INDEX_CANDIDATES = ['/index.ts', '.ts', '/index.tsx', '.tsx'];

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (error.code !== 'ERR_UNSUPPORTED_DIR_IMPORT' && error.code !== 'ERR_MODULE_NOT_FOUND') {
        throw error;
      }
      const base = error.url ?? new URL(specifier, context.parentURL).href;
      for (const suffix of DIRECTORY_INDEX_CANDIDATES) {
        const candidate = `${base}${suffix}`;
        try {
          statSync(fileURLToPath(candidate));
          // 不指定 format:让 node 按 .ts 后缀自己走类型擦除,
          // 写死 'module' 会绕过擦除,然后在第一个 `interface` 上炸掉。
          return { url: candidate, shortCircuit: true };
        } catch {
          // 试下一个候选
        }
      }
      throw error;
    }
  },
});

// 模块级就会跑的浏览器 API,只补到「能加载」为止 —— 这里不是要模拟浏览器,
// 补多了反而会让断言在一个不真实的环境里通过。
function installBrowserShims() {
  const store = new Map();
  // 用 defineProperty 而不是读一下再赋值:node 自带一个 localStorage 取值器,
  // 光是读它就会打一条 ExperimentalWarning,把校验输出弄脏。
  const localStorageShim = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
    clear: () => store.clear(),
    key: (index) => Array.from(store.keys())[index] ?? null,
    get length() {
      return store.size;
    },
  };
  Object.defineProperty(globalThis, 'localStorage', {
    value: localStorageShim,
    configurable: true,
    writable: true,
  });
  globalThis.addEventListener = () => {};
  globalThis.removeEventListener = () => {};
  globalThis.dispatchEvent = () => true;
  globalThis.window = globalThis;
}

installBrowserShims();
