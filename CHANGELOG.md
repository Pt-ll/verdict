# 更新日志

## 0.1.1 — 2026-09-13

**打包修复**：自带打包器产出的 VSIX 不符合市场后端的格式，上传时报 `TF400898`
（一个不说明原因的内部错误）。0.1.0 的功能没有变，这一版只是把包修对。

- **扩展 ID 改成 `YuChenZhong.verdict-judge`**：市场上 `verdict` 这个名字已被占用。
  扩展内部一律没变——命令、设置还是 `verdict.*`，工作区目录还是 `.verdict/`，
  所以在编辑器里用起来和 0.1.0 完全一样，只是安装时认的 ID 不同。
- `[Content_Types].xml` 按包内实际文件生成：后缀带点、没有后缀的 part 用 `<Override>`
  单独声明。之前那条 `Extension=""` 是非法清单，后端建内容类型表时直接崩。
- 清单补齐市场要的资产与属性：`Content.Details`（README）、`Content.Changelog`、
  `Content.License`、`Icons.Default`，以及 `<Icon>`、仓库链接、Branding、Pricing。
- 包内 README / CHANGELOG / LICENSE 改用市场约定的小写名（`readme.md` / `changelog.md` /
  `LICENSE.txt`），与官方 vsce 的产物一致。

## 0.1.0 — 2026-09-13

**侧边栏评测面板**：活动栏上的 Verdict 图标点开就是操作台，出题、评测、看榜都不用碰 JSON。

- 新增活动栏容器与「评测面板」视图（`verdict.controlPanel`），三个页签：
  - **题目**：比赛信息与题目列表；新建 / 导入 / 导出题目包；选中题目的限制与比较方式
    （`default` / `line` / `real` / `spj` / `interactive`，checker 与 interactor 用文件选择器指定）。
  - **测试点**：按子任务分组，每行给出最近一次判定、用时与内存；`▶` 只跑这一个点、`🐞` 用它调试、
    `⇄` 打开 diff、`▸` 展开看输入 / 标准答案 / 实际输出。子任务可增删、改分值 / 依赖 / 计分方式，
    也能按点均分；测试点可改归属，或移出登记（数据文件保留）。
  - **榜单**：选手 × 题目矩阵，点单元格看重测详情；一键评测全部、导出 HTML、打开完整榜单。
- 面板只是 `problem.json` / `contest.json` 的**视图**：每次编辑都是读-改-写，与手改文件完全等价；
  文件在编辑器外面被改（手改、git 切分支）时面板跟着刷新。
- 单点运行的分数是**下界**：结果标记为 `partial`，面板此时不显示总分，也不会清掉其它测试点的输出。
- 面板里没有网络请求，DOM 全部用 `createElement` / `textContent` 构建（有单测盯着）。

## 0.0.1 — 2026-09-13（首个发布版本）

- **编译与运行**：探测本机的 `g++` / `clang++` / `cl`，编译缓存与首次执行预热；
  `AC` / `WA` / `TLE` / `MLE` / `OLE` / `RE` / `CE` 判定，输出截断与跨平台进程树清理。
- **题目包与子任务**：`problem.json` 描述限制、比较方式、测试点与子任务；扫描 `data/` 登记测试点；
  子任务支持依赖与 `min` / `sum` 计分、部分分。
- **编辑器集成**：Testing 面板、原生 diff（定位首个不同行）、`verdict://` 虚拟文档、CodeLens、
  状态栏与输出通道。
- **比赛**：选手 × 题目整场评测、重测上限、榜单 WebView、自包含（离线可开）的 HTML 成绩单。
- **交互题与 Special Judge**：testlib interactor / checker，含退出码 7 的部分分折算；
  交互题的调试走「录制-重放」。
- **题目包迁移**：ZIP 导入导出；自带打包器产出单一跨平台 VSIX（无原生依赖、无网络请求）。
