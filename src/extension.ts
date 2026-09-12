import * as vscode from 'vscode';
import { registerCommands } from './vscode/commands';
import { JudgeCodeLensProvider } from './vscode/codelens';
import { DiagnosticsPublisher } from './vscode/diagnostics';
import { VerdictOutput } from './vscode/output';
import { VerdictStatusBar } from './vscode/statusBar';

/**
 * 扩展入口：只负责装配与释放。
 *
 * 具体行为分别在 src/vscode/ 的各模块里，评测内核在 src/core/，
 * 中间由 src/engineFacade.ts 连接。
 */
export function activate(context: vscode.ExtensionContext): void {
  const output = new VerdictOutput(
    () => vscode.workspace.getConfiguration('verdict').get<boolean>('debug') === true,
  );
  const status = new VerdictStatusBar();
  const diagnostics = new DiagnosticsPublisher();

  context.subscriptions.push(
    output,
    status,
    diagnostics,
    ...registerCommands({ context, output, status, diagnostics }),
    vscode.languages.registerCodeLensProvider(
      [
        { language: 'cpp', scheme: 'file' },
        { language: 'c', scheme: 'file' },
        { language: 'python', scheme: 'file' },
      ],
      new JudgeCodeLensProvider(),
    ),
  );

  output.info('Verdict 已激活。执行命令「Verdict: 检查环境」开始。');
}

export function deactivate(): void {
  // 资源都通过 context.subscriptions 释放，这里无需额外处理。
}
