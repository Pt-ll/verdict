import * as vscode from 'vscode';

const COMMAND_CHECK_ENV = 'verdict.checkEnv';
const ICON = '$(beaker)';
const BUSY_ICON = '$(sync~spin)';

/** 状态栏（SPEC §4.9）：平时显示环境，评测时显示进度与最终判定。 */
export class VerdictStatusBar implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100,
  );

  constructor() {
    this.item.text = `${ICON} Verdict`;
    this.item.tooltip = 'Verdict：点击检查评测环境';
    this.item.command = COMMAND_CHECK_ENV;
    this.item.show();
  }

  setBusy(text: string): void {
    this.item.command = undefined;
    this.item.text = `${BUSY_ICON} ${text}`;
    this.item.tooltip = 'Verdict：正在评测';
    this.item.backgroundColor = undefined;
  }

  setIdle(text: string, tooltip: string): void {
    this.item.command = COMMAND_CHECK_ENV;
    this.item.text = text;
    this.item.tooltip = tooltip;
    this.item.backgroundColor = undefined;
  }

  setWarning(message: string): void {
    this.item.command = COMMAND_CHECK_ENV;
    this.item.text = '$(warning) Verdict';
    this.item.tooltip = message;
    this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
  }

  dispose(): void {
    this.item.dispose();
  }
}
