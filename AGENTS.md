# AGENTS.md

Verdict：把 OI/ICPC 风格的本地评测系统做进 VSCode 的扩展。
完整设计以 `SPEC.md` 为准；本文件只写「动手时必须遵守的规矩」。

## 硬约束

- 交付物是 **VSCode 扩展**，不是 CLI、不是本地服务、不是独立 GUI。
- **运行时依赖为 0**：只能用 Node 内置模块 + VSCode API。不新增 `dependencies`。
- **完全离线**：代码中不得出现 `http`/`https`/`fetch`/`net.connect`/`dns` 等调用。
- 扩展自身不捆绑编译器，只探测并调用用户本机已安装的 `g++` / `clang++` / `cl`。

## 分层

- `src/core/**`：平台无关的评测内核，**禁止 `import 'vscode'`**，必须能在纯 Node 下单测。
- `src/vscode/**`、`src/extension.ts`：唯一允许依赖 VSCode API 的地方，只做注册/展示/弹窗。
- `src/util/**`：两端共用的纯函数工具。

## 三平台约定（强制）

1. 路径一律 `path.join` / `path.delimiter` / `os.tmpdir()`，禁止硬编码 `/`、`\` 或盘符。
2. `package.json` 的 scripts 只用 Node 命令，禁止 `rm`/`cp`/`&&`/`export` 等平台专有 shell 语法。
3. 调用外部程序一律 `spawn` 传参数数组，禁止拼接 shell 字符串。
4. 源码 LF + UTF-8；数据文件按字节处理，不做换行规范化假设。
5. 杀进程树必须分平台：POSIX 杀进程组，Windows 用 `taskkill /T /F`。
6. 文件名不得仅靠大小写区分。

## 常用命令

```bash
pnpm install        # 安装依赖（首次；pnpm 会读 pnpm-workspace.yaml 的 allowBuilds）
pnpm build          # esbuild 打包到 dist/extension.js
pnpm watch          # 增量编译（F5 调试时用）
pnpm typecheck      # tsc --noEmit
pnpm test           # vitest（M1 第 2 步起可用）
pnpm package        # 打包 VSIX
```

调试：在 VSCode 中打开本目录，按 `F5` 启动扩展开发宿主。

## 里程碑（见 SPEC §12）

- M1 骨架 + 编译运行 + 单点判定 ← 当前
- M2 题目包 + 测试点 + 子任务 + Testing/diff
- M3 比赛 + 选手 + 重测 + 榜单 + HTML
- M4 交互题 + testlib SPJ + 导入导出 + 打包

## 代码风格

- TypeScript 5，`strict: true`；不写隐式 `any`。
- 注释用中文，解释「为什么」而不是复述「做了什么」。
- 不加版权头；不引入任何需要联网或上报的包。
