import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  compile,
  detectAllToolchains,
  runProcess,
  type Toolchain,
} from './core/compiler';

/**
 * 扩展入口（M1）。
 *
 * 这一层只做「VSCode 相关」的事：注册命令、输出通道、状态栏、弹窗。
 * 真正的评测逻辑放在 src/core/，那里不允许 import vscode。
 */

const OUTPUT_NAME = 'Verdict';
const SETTINGS_SECTION = 'verdict';

let output: vscode.OutputChannel | undefined;

export function activate(context: vscode.ExtensionContext): void {
  output = vscode.window.createOutputChannel(OUTPUT_NAME);
  context.subscriptions.push(output);

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  status.text = '$(beaker) Verdict';
  status.tooltip = 'Verdict：点击检查评测环境';
  status.command = 'verdict.checkEnv';
  status.show();
  context.subscriptions.push(status);

  context.subscriptions.push(
    vscode.commands.registerCommand('verdict.checkEnv', () => checkEnv(context, status)),
  );

  log('Verdict 已激活。执行命令「Verdict: 检查环境」开始。');
}

export function deactivate(): void {
  // 所有资源都通过 context.subscriptions 释放，这里无需额外处理。
}

async function checkEnv(
  context: vscode.ExtensionContext,
  status: vscode.StatusBarItem,
): Promise<void> {
  const config = vscode.workspace.getConfiguration(SETTINGS_SECTION);
  const explicitPath = (config.get<string>('compiler') ?? '').trim();

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'Verdict：检查评测环境',
    },
    async () => {
      const toolchains = await detectAllToolchains(
        explicitPath ? { explicitPath } : {},
      );

      if (toolchains.length === 0) {
        reportMissingCompiler(status, explicitPath);
        return;
      }

      const cacheDir = path.join(context.globalStorageUri.fsPath, 'cache');
      const selfCheck = await runSelfCheck(toolchains[0], cacheDir);
      reportToolchains(status, toolchains, selfCheck);
    },
  );
}

interface SelfCheckResult {
  ok: boolean;
  detail: string;
}

/**
 * 试编译并运行一个最小 C++ 程序。
 *
 * 只探测到编译器不算「环境可用」——编译器装坏了、缺链接器、缺运行库，都要真的编译一次才知道。
 */
async function runSelfCheck(
  toolchain: Toolchain,
  cacheDir: string,
): Promise<SelfCheckResult> {
  if (toolchain.kind === 'python') {
    return { ok: true, detail: '解释型语言，跳过编译自检' };
  }

  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'verdict-selfcheck-'));
  try {
    const sourcePath = path.join(tempDir, 'selfcheck.cpp');
    await fs.promises.writeFile(
      sourcePath,
      '#include <cstdio>\nint main() { std::printf("verdict-ok\\n"); return 0; }\n',
      'utf8',
    );

    const compiled = await compile(toolchain, sourcePath, { cacheDir });
    if (!compiled.ok) {
      const first = compiled.diagnostics[0];
      return { ok: false, detail: first ? `编译失败：${first.message}` : '编译失败' };
    }

    const run = await runProcess(compiled.runCmd.cmd, compiled.runCmd.args, 10_000);
    if (run.code !== 0) {
      return { ok: false, detail: `自检程序退出码 ${run.code ?? 'null'}：${run.stderr.trim()}` };
    }
    if (run.stdout.trim() !== 'verdict-ok') {
      return { ok: false, detail: `自检输出异常：${run.stdout.trim()}` };
    }
    return {
      ok: true,
      detail: compiled.cached ? '编译 + 运行自检通过（命中缓存）' : '编译 + 运行自检通过',
    };
  } catch (err) {
    return { ok: false, detail: `自检异常：${err instanceof Error ? err.message : String(err)}` };
  } finally {
    await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

function reportMissingCompiler(
  status: vscode.StatusBarItem,
  explicitPath: string,
): void {
  status.text = '$(warning) Verdict';
  status.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');

  log('未找到可用编译器。');
  if (explicitPath) {
    log(`设置 verdict.compiler 指定的是：${explicitPath}（探测失败）`);
  }
  log('请安装 g++ / clang++ / cl 之一并加入 PATH，或在设置 verdict.compiler 中填写完整路径。');

  void vscode.window
    .showErrorMessage('Verdict：未找到可用编译器，无法评测。', '打开设置', '查看输出')
    .then((choice) => {
      if (choice === '打开设置') {
        void vscode.commands.executeCommand(
          'workbench.action.openSettings',
          'verdict.compiler',
        );
      } else if (choice === '查看输出') {
        output?.show(true);
      }
    });
}

function reportToolchains(
  status: vscode.StatusBarItem,
  toolchains: Toolchain[],
  selfCheck: SelfCheckResult,
): void {
  const first = toolchains[0];

  log(`找到 ${toolchains.length} 个可用编译器：`);
  for (const toolchain of toolchains) {
    log(`  · ${toolchain.kind}  ${toolchain.path ?? toolchain.command}`);
    log(`    ${toolchain.version}`);
  }
  log(`将使用：${first.kind}（${first.command}）`);
  log(`自检：${selfCheck.ok ? '通过' : '失败'} — ${selfCheck.detail}`);

  if (!selfCheck.ok) {
    status.text = '$(warning) Verdict';
    status.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    status.tooltip = `Verdict：编译器自检失败\n${selfCheck.detail}`;
    void vscode.window
      .showErrorMessage(`Verdict：编译器自检失败 —— ${selfCheck.detail}`, '查看输出')
      .then((choice) => {
        if (choice === '查看输出') {
          output?.show(true);
        }
      });
    return;
  }

  status.text = `$(beaker) ${first.kind}`;
  status.backgroundColor = undefined;
  status.tooltip = `Verdict：使用 ${first.command}\n${first.version}\n${selfCheck.detail}`;

  void vscode.window
    .showInformationMessage(
      `Verdict：${first.kind} 可用，${selfCheck.detail}。`,
      '查看输出',
    )
    .then((choice) => {
      if (choice === '查看输出') {
        output?.show(true);
      }
    });
}

function log(line: string): void {
  output?.appendLine(`[${new Date().toISOString()}] ${line}`);
}
