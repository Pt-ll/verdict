import * as vscode from 'vscode';

/**
 * 文件顶部的操作按钮（SPEC §4.2）。
 *
 * 目前提供「▶ 评测」「🐞 调试首测点」「⚙ 限制」。
 * 数据文件上的「📋 关联测试点」还没做。
 */
export class JudgeCodeLensProvider implements vscode.CodeLensProvider {
  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    if (document.uri.scheme !== 'file' || document.lineCount === 0) {
      return [];
    }
    const top = new vscode.Range(0, 0, 0, 0);
    return [
      new vscode.CodeLens(top, {
        title: '▶ 评测',
        command: 'verdict.judgeCurrent',
      }),
      new vscode.CodeLens(top, {
        title: '🐞 调试首测点',
        command: 'verdict.debugCase',
      }),
      new vscode.CodeLens(top, {
        title: '⚙ 限制',
        command: 'verdict.setLimits',
      }),
    ];
  }
}
