'use strict';

// 集成测试入口：拉起一个真正的 VS Code 扩展开发宿主（Extension Development Host），
// 以 testdata/itest 为工作区跑 test/integration/index.js。
//
// 单元测试跑不到的东西都在这里验收：命令注册、编译失败诊断、以及真的编译并运行样例程序。
// 触发方式：`pnpm test:integration`。

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { downloadAndUnzipVSCode, runTests } = require('@vscode/test-electron');

const ROOT = path.resolve(__dirname, '..');
// 工作区是整个 testdata：itest 里的样例程序走 M1 的约定式查找，
// problemA 是个完整的题目包，用来验收 Testing 面板与子任务计分。
const WORKSPACE = path.join(ROOT, 'testdata');
const TESTS_PATH = path.join(__dirname, 'integration', 'index.js');

// CI 上没有安装任何调试扩展，所以调试相关的断言只跑「没装扩展时给可操作提示」那条路径。
// 想在本机验证真实调试会话（会真的拉起 lldb）：
//   VERDICT_ITEST_KEEP_EXTENSIONS=1 pnpm test:integration
const keepExtensions = process.env.VERDICT_ITEST_KEEP_EXTENSIONS === '1';

/** 机器上真实安装的扩展目录（本机验证调试会话时借用它，见下方 launchArgs）。 */
const MACHINE_EXTENSIONS = path.join(os.homedir(), '.vscode', 'extensions');

/**
 * 优先用本机已装的 VS Code：开发机多数离线，而下载一份 VS Code 有好几百 MB。
 * CI 上不存在这些路径，会回落到 test-electron 的下载（CI 有网）。
 * 想强制指定时设置环境变量 VSCODE_EXECUTABLE。
 */
function findLocalVSCode() {
  if (process.env.VSCODE_EXECUTABLE) {
    return process.env.VSCODE_EXECUTABLE;
  }
  // macOS 上那个二进制在 VS Code 1.10x 前后改过名：老版本叫 Electron，现在叫 Code。
  // 只认老名字的话，本机明明装了也会被当成没装，转而去下载 300MB（2026-09-13 撞到过：
  // 本机是 1.137，二进制已是 Code，集成测试因此卡在下载上）。
  const macApp = (name) =>
    [
      path.join('/Applications', name),
      path.join(os.homedir(), 'Applications', name),
    ].flatMap((app) => [
      path.join(app, 'Contents', 'MacOS', 'Code'),
      path.join(app, 'Contents', 'MacOS', 'Electron'),
    ]);
  const candidates =
    {
      darwin: [
        ...macApp('Visual Studio Code.app'),
        ...macApp('VSCodium.app'),
        ...macApp('Visual Studio Code - Insiders.app'),
      ],
      win32: [
        path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Microsoft VS Code', 'Code.exe'),
        path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'VSCodium', 'VSCodium.exe'),
      ],
      linux: ['/usr/bin/code', '/usr/share/code/code', '/snap/bin/code'],
    }[process.platform] ?? [];
  return candidates.find((candidate) => fs.existsSync(candidate));
}

async function main() {
  if (!fs.existsSync(TESTS_PATH)) {
    throw new Error(`找不到集成测试脚本：${TESTS_PATH}`);
  }
  if (!fs.existsSync(WORKSPACE)) {
    throw new Error(`找不到集成测试工作区：${WORKSPACE}`);
  }

  // 宿主加载的是打包产物 dist/extension.js，而 dist/ 不入库，
  // 所以每次先打包一次，保证测的是当前源码而不是上一次的残留。
  const build = spawnSync(process.execPath, ['esbuild.js'], { cwd: ROOT, stdio: 'inherit' });
  if (build.status !== 0) {
    throw new Error('打包失败（node esbuild.js），集成测试中止。');
  }

  const vscodeExecutablePath = findLocalVSCode() ?? (await downloadAndUnzipVSCode());
  console.log(`[verdict] 扩展宿主：${vscodeExecutablePath}`);

  const exitCode = await runTests({
    vscodeExecutablePath,
    extensionDevelopmentPath: ROOT,
    extensionTestsPath: TESTS_PATH,
    launchArgs: [
      WORKSPACE,
      // 默认只加载被测扩展；跳过「是否信任此工作区」的弹窗，否则测试会卡在界面上等交互。
      //
      // 本机验证调试会话时改用机器上真实的扩展目录：test-electron 默认会在
      // .vscode-test/extensions 下建一个空目录，里面没有 cpptools，调试根本无从验证。
      // 只借扩展目录、不借用户数据目录——否则会和你正开着的 VS Code 抢实例。
      ...(keepExtensions
        ? [`--extensions-dir=${MACHINE_EXTENSIONS}`]
        : ['--disable-extensions']),
      '--disable-workspace-trust',
    ],
    extensionTestsEnv: {
      VERDICT_ITEST_KEEP_EXTENSIONS: keepExtensions ? '1' : '',
    },
  });
  process.exit(exitCode);
}

main().catch((err) => {
  console.error(`[verdict] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
