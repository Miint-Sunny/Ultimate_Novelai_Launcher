# Web UI 设计约定

桌面端(`src/AppContent.tsx` 一侧)的既有视觉与交互规则,从现有组件中归纳而来。
改 UI 前先读这份;新组件不得发明第二套做法。移动端(`MobileAppContent`)另有习惯,
不在本文范围。

## 1. 色彩

色值统一定义在 `src/index.css` 的 `:root` CSS 变量层(RGB 三元组),
`tailwind.config.js` 通过 `rgb(var(--…) / <alpha-value>)` 映射成 `nai-*` 与
`gray-*` 类;组件一律用类名引用,不得裸写 hex。基底为**石墨中性**(2026-08
起,取代旧海军蓝紫基底;各档与旧值逐档等亮,对比关系不变):

| Token | 值 | 用途 |
|---|---|---|
| `nai-bg` | `#0e0f11` | 页面底色 |
| `nai-dark` | `#070809` | 更深底(遮罩下层) |
| `nai-panel` | `#151719` | 面板底色 |
| `nai-input` | `#1f2124` | 输入框/嵌套容器底色 |
| `nai-accent` | `#fceda4` | **唯一主强调色**(金):主按钮、选中态、进度 |
| `nai-accent-hover` | `#ebd576` | 强调色 hover |
| `nai-text-dim` | `#8c8e8f` | 弱化文字 |

`gray-*` 已在 theme 中整体重定义为中性石墨灰阶(Tailwind 默认 gray 带蓝调,
勿恢复默认);用法不变:文字 `gray-200/300`(正文)、`gray-400/500`(次要)、
`gray-600`(禁用);背景 `gray-800`(缩略图底/次级按钮)。

- 选中/激活态的标准写法:`border-nai-accent` + 光晕
  `shadow-[0_0_10px_rgba(252,237,164,0.3)]`;半透明衬底用
  `bg-nai-accent/20`,描边用 `border-nai-accent/50`。
- 语义色固定:绿=成功/超分标记,蓝=局部重绘标记,金=主操作,
  红=危险(删除、清空),青(cyan)=vibe/来源标记。危险按钮写法
  `bg-red-500/20 text-red-400 border-red-500/50`。
- **紫/靛(purple/indigo/violet)已全面废除**,不得在任何新组件中引入;
  装饰性强调用 `nai-accent` 低透明度档,分类数据色优先 cyan/sky/amber。
- `desktop/AIAssistant` 的 `tokens.ts` 与全局同源(色值一致,面板底与
  `nai-panel` 同值);新组件优先用全局类名,特区仅维持存量。

## 2. 面板与边框

- 纵深顺序:页面 `nai-bg` → 面板 `nai-panel` → 输入/嵌套 `nai-input` →
  缩略图底 `gray-800`。
- 面板之间的分界线:`border-gray-800`;控件描边:`border-gray-700`,
  hover 提亮到 `border-gray-600`;同面板内的微弱分隔:`border-white/5`~`/10`。
- 大面板(侧栏/底栏)自身:`bg-nai-panel` + 单侧 `border-*-gray-800` + `shrink-0 z-10`。

## 3. 圆角与阴影

- 控件、缩略图 `rounded-lg`;卡片、弹窗、悬浮条 `rounded-xl`;
  徽标/小标签 `rounded`;圆点、药丸、全览计数 `rounded-full`。
- 阴影少用:弹窗 `shadow-2xl`/`shadow-xl`;选中光晕见上;不做发光堆叠。

## 4. 字号与排版

- 根字号 16px,大屏媒体查询放大(1920→17,2560→19,3840→22),
  因此**一律用 rem 尺寸类**(Tailwind 默认即 rem),不要写 px 定宽字号,
  叠加信息除外:缩略图上的覆盖文字用 `text-[10px]`/`text-[11px]`。
- 层级:标题 `text-base`~`lg font-bold`;正文/按钮 `text-sm`;辅助 `text-xs`。
- Tag 文字用 `.font-tag`(Source Sans Pro 600,仿 NovelAI 官方)。
- 界面文案一律中文;可交互元素必须带 `title`;时间显示 `HH:mm`(zh-CN)。

## 5. 交互反馈

- hover 标准:文字 `text-gray-400/500 → hover:text-white`,
  衬底 `hover:bg-white/5`(图标钮)或 `hover:bg-gray-800`(实体钮)。
- 过渡:控件 `transition-* duration-200`,面板/布局 `duration-300`;
  入场动画用全局 `animate-fade-in` / `animate-slide-in-from-bottom`。
- 禁用:`text-gray-600 cursor-not-allowed`,不移除 title。
- 图标用 `lucide-react`,常规 `w-4 h-4`,小徽标 `w-3 h-3`,
  hover 微放大 `group-hover:scale-110`。

## 6. 浮层与 z 序

- 全屏弹窗一律 `createPortal(..., document.body)`:
  遮罩 `fixed inset-0 bg-black/80 backdrop-blur-sm`,
  容器 `bg-nai-panel border border-gray-700 rounded-xl shadow-2xl`。
- z 序阶梯:面板 `z-10` → 画布悬浮件 `z-20` → 右键菜单 `z-50` →
  次级浮层 `z-[100~200]` → 全屏弹窗 `z-[9999]` → 图片预览 `z-[10000]`。
- 右键菜单:`fixed` 定位 + 超出视口边缘反向定位,
  `mousedown`/`Escape`/`scroll`(capture)/`blur` 任一关闭。
- 悬浮在画布上的工具(如 `ImageToolbar`):
  `absolute` + `bg-gray-900/70 backdrop-blur-xl border-white/5 rounded-xl`。

## 7. 图片缩略卡(历史/画廊通用)

`aspect-square bg-gray-800 rounded-lg border-2 overflow-hidden relative group` +
`object-contain` 图片;边框三态:透明 → `hover:border-gray-600` → 选中
`border-nai-accent` + 光晕。角标:超分(绿)、重绘(蓝)、香蕉(黄),
`text-[8px]~[10px] font-bold`;信息条用底部渐变
`bg-gradient-to-t from-black/95 to-transparent` + `group-hover:opacity-100`。

## 8. 滚动与布局

- 滚动条全局 6px 深色;需要显式类时用 `.custom-scrollbar`,隐藏用 `.scrollbar-hide`。
- 布局用 flex + `overflow-hidden` 分区,面板 `shrink-0`,内容区 `flex-1 overflow-y-auto`。
- 可收起面板:细把手按钮 + Chevron 图标,`transition-all duration-200/300`。

## 9. 状态与通信

- 本地持久化:`localStorage`,蛇形命名;新键统一加 `nai_` 前缀
  (旧键是历史遗留,不迁移但也不新增无前缀键)。
  敏感凭据(sidecar token)只进 `sessionStorage`,绝不进 localStorage。
- 跨组件通信用 `window` 上的 `CustomEvent`,kebab-case 命名
  (如 `open-inpaint-mode`、`inpaint-generate`);既有事件名是兼容面,不改名。
- 后端调用只走 `localSidecarApi` / `cloudBackendApi` / `appBackendApi`,
  组件内不写裸 `fetch`。

## 10. 组件架构

- 页面壳(`AppContent`、`LeftSidebar`、`MainContent`)是编排层:
  域状态放进 hooks/服务,可见区块拆成聚焦组件,避免继续往壳里堆全局状态。
- 复杂组件目录化(参照 `desktop/AIAssistant/`):`index.tsx` 编排 +
  子组件分文件 + `types.ts`/`tokens.ts`/`useXxx.ts`。
