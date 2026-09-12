import * as vscode from 'vscode';

const CHANNEL_NAME = 'Verdict';

/**
 * 输出通道（SPEC §4.10）。
 *
 * 评测过程的细节都往这里写：命令、耗时、每个测试点的判定。
 * 弹窗只用来表达「需要用户决策」的事，不刷屏。
 */
export class VerdictOutput implements vscode.Disposable {
  private readonly channel = vscode.window.createOutputChannel(CHANNEL_NAME);

  constructor(private readonly isDebugEnabled: () => boolean) {}

  info(line: string): void {
    this.channel.appendLine(`[${timestamp()}] ${line}`);
  }

  debug(line: string): void {
    if (this.isDebugEnabled()) {
      this.channel.appendLine(`[${timestamp()}] [debug] ${line}`);
    }
  }

  error(line: string): void {
    this.channel.appendLine(`[${timestamp()}] [错误] ${line}`);
  }

  show(preserveFocus = true): void {
    this.channel.show(preserveFocus);
  }

  dispose(): void {
    this.channel.dispose();
  }
}

function timestamp(): string {
  return new Date().toISOString().slice(11, 23);
}
