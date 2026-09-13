import * as vscode from 'vscode';
import type { JudgeOutcome } from './engineFacade';
import { CaseDocumentStore } from './vscode/caseDocs';
import { registerCommands } from './vscode/commands';
import { JudgeCodeLensProvider } from './vscode/codelens';
import { DiagnosticsPublisher } from './vscode/diagnostics';
import { VerdictOutput } from './vscode/output';
import { VerdictStatusBar } from './vscode/statusBar';

/**
 * 暴露给集成测试的 API。
 *
 * 集成测试通过 activate() 的返回值拿到评测入口：命令面板里点一下没法断言结果，
 * 只有拿到结构化的 JudgeOutcome 才能验证 AC/WA/TLE/RE/OLE/CE。
 */
export interface VerdictApi {
  judgeDocument(document: vscode.TextDocument): Promise<JudgeOutcome | null>;
}

/**
 * 扩展入口：只负责装配与释放。
 *
 * 具体行为分别在 src/vscode/ 的各模块里，评测内核在 src/core/，
 * 中间由 src/engineFacade.ts 连接。
 */
export function activate(context: vscode.ExtensionContext): VerdictApi {
  const output = new VerdictOutput(
    () => vscode.workspace.getConfiguration('verdict').get<boolean>('debug') === true,
  );
  const status = new VerdictStatusBar();
  const diagnostics = new DiagnosticsPublisher();
  const caseDocs = new CaseDocumentStore();
  caseDocs.register(context);
  const commands = registerCommands({ context, output, status, diagnostics, caseDocs });

  context.subscriptions.push(
    output,
    status,
    diagnostics,
    ...commands.disposables,
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

  return { judgeDocument: (document) => commands.judgeDocument(document) };
}

export function deactivate(): void {
  // 资源都通过 context.subscriptions 释放，这里无需额外处理。
}
