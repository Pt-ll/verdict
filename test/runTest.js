'use strict';

// 集成测试入口：拉起一个真正的 VS Code 扩展开发宿主（Extension Development Host），
// 以 testdata/itest 为工作区跑 test/integration/index.js。
//
// 单元测试跑不到的东西都在这里验收：命令注册、编译失败诊断、以及真的编译并运行样例程序。
// 触发方式：`pnpm test:integration`。

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { downloadAndUnzipVSCode, runTests } = require('@vscode/test-electron');

const ROOT = path.resolve(__dirname, '..');
const WORKSPACE = path.join(ROOT, 'testdata', 'itest');
const TESTS_PATH = path.join(__dirname, 'integration', 'index.js');

/**
 * 优先用本机已装的 VS Code：开发机多数离线，而下载一份 VS Code 有好几百 MB。
 * CI 上不存在这些路径，会回落到 test-electron 的下载（CI 有网）。
 * 想强制指定时设置环境变量 VSCODE_EXECUTABLE。
 */
function findLocalVSCode() {
  if (process.env.VSCODE_EXECUTABLE) {
    return process.env.VSCODE_EXECUTABLE;
  }
  const candidates =
    {
      darwin: ['/Applications/Visual Studio Code.app/Contents/MacOS/Electron'],
      win32: [
        path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Microsoft VS Code', 'Code.exe'),
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
      // 只加载被测扩展；跳过「是否信任此工作区」的弹窗，否则测试会卡在界面上等交互。
      '--disable-extensions',
      '--disable-workspace-trust',
    ],
  });
  process.exit(exitCode);
}

main().catch((err) => {
  console.error(`[verdict] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
