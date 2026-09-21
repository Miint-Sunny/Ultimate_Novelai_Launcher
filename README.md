# Ultimate NovelAI Launcher

一个跑在自己电脑上的 NovelAI 客户端:桌面应用与同一套网页界面,
生图、重绘、导演工具、角色摆位、以及一个能直接操作工作台的 AI 助手。

桌面外壳基于 Tauri,三平台都能从源码构建;目前只有 **Windows 安装包由 CI 产出**,
macOS 与 Linux 需要自己打包(命令见下)。

**与 NovelAI 官方无任何关联。** 使用本项目需要你自己的 NovelAI 账号与订阅,
产生的 Anlas 消耗由你的账号承担。

---

## 它解决什么

官方网页版够用,但有几件事它不做,而这些恰好是画多了之后最费时间的:

- **出图要花多少点,事先看得见。** 计价在界面上直接显示数字,不写「约」——
  公式经过真实扣费实测校准,包括 V5 的 1.5× 与 Opus 体力条耗尽后的静默计费。
- **角色摆位直接画在画布上**,取景框按**这次要生成的分辨率**画,不贴着屏幕上那张旧图。
  摆完就是发出去的坐标。
- **局部重绘按官方的焦点重绘做**:框内整块重画、四周留上下文,截下来的区域放大到约
  100 万像素再送,补完细节缩回原位贴回去。
- **提示词、角色、参考图、预设全部本地可管**:片段库、标签联想(官方 / Danbooru /
  离线词典三路)、PNG 元数据读回。
- **AI 助手不是聊天框**,它直接改你的工作台:写提示词、加角色、调参数、出图、
  放大、看图、局部重绘。每一个动作都过权限闸,花钱的先报价再确认。

## 界面

桌面端是「左栏输入 / 中间画布 / 右侧可拼停靠区」的三段式,顶栏对当前这张图说话。
竖屏是独立的一套翻页式界面,不是把桌面端压窄。

## 安全上的几条底线

这类客户端要拿着你的账号密钥,所以这几条是设计约束,不是可选项:

- NovelAI 与 LLM 的密钥**只存操作系统的凭据库**(macOS 钥匙串 / Windows 凭据管理器 /
  Linux Secret Service),永不写进配置文件、localStorage、日志或命令行参数。
  凭据库不可用时直接失败,不降级到明文。
- 本地 sidecar **只绑定回环地址**,除 `/livez` 外全部需要进程级凭证;
  浏览器接入走一次性、限次、120 秒过期的配对码。
- 前端**从不直连 NovelAI**,也不持有令牌;所有出站请求过统一的 SSRF 策略,
  跨源不转发授权头。
- 日志里永远不会出现完整令牌、Cookie、授权头或 base64 图像体。

## 自己跑起来

需要 Node 24、Python 3.10–3.14、Rust(只有打桌面包时用)与 [uv](https://docs.astral.sh/uv/)。

```bash
npm ci
uv sync --frozen --group dev
```

开发时前后端分开跑:

```bash
npm run sidecar   # 本地后端,默认回环端口
npm run dev       # 前端,浏览器打开后用 sidecar 终端里打印的配对码连上
```

桌面应用:

```bash
npm run desktop:dev     # 开发
npm run desktop:build   # 打包(产物在 src-tauri/target/release/bundle/)
```

**Windows 安装包由 CI 产出**:手动触发 `CI` 工作流、level 选 `package`,
构建完成后在该次 run 的 Artifacts 里下载。开发机是 macOS 时交叉编译到 Windows 走不通,
这是唯一的来源。

## 代码结构

| 路径 | 是什么 |
| --- | --- |
| `src/` | React 前端。UI 与客户端领域状态,通过类型化的 API 客户端选本地或云端传输。 |
| `sidecar/` | 本地 Python 后端(FastAPI)。生成、资产、库、凭据、标签,全部本机。 |
| `backend_core/` | 传输中立的核心协议。**不依赖** FastAPI、sidecar 或任何部署路径。 |
| `cloud_backend/` | 可选的云端身份、配额、任务与安全。 |
| `server/` | 历史兼容宿主与 Agent 路由资源。 |
| `src-tauri/` | 桌面外壳(Rust):单实例、启动与监管 sidecar、有界关闭。 |
| `scripts/` | 门禁脚本。多数可以直接 `node --experimental-strip-types` 跑。 |

细节看 [ARCHITECTURE.md](ARCHITECTURE.md)(后端系统图)与 [AGENTS.md](AGENTS.md)(工程规则)。

## 测试

```bash
npm run build          # 类型检查 + 打包 + API 边界
npm run test:python    # 全量 pytest,带覆盖率闸
npm run scan:secrets   # 工作树密钥扫描
```

`scripts/check-*.mjs` 是一批**结构性断言**:把容易回归的行为用真实数据钉死——
计价公式的实测锚点、载荷字段的对等、模型能力位、停靠布局的结构。
改到相关区域时对应那条会先响。

## 许可

[GPL-3.0](LICENSE)。本项目包含来自其他开源项目的代码,署名与各自许可见
[NOTICE.md](NOTICE.md) —— 其中 MIT 部分的许可全文按要求随分发保留。
