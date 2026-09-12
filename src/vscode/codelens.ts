import * as vscode from 'vscode';

/**
 * 文件顶部的操作按钮（SPEC §4.2）。
 *
 * M1 只提供「▶ 评测」；「🐞 调试首测点」「⚙ 限制」和「📋 关联测试点」
 * 分别依赖调试会话与题目包，留到后续里程碑。
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
    ];
  }
}
