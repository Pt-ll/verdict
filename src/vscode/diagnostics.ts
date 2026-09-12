import * as path from 'node:path';
import * as vscode from 'vscode';
import type { CompileDiagnostic } from '../core/compiler';

const COLLECTION_NAME = 'verdict';
const SOURCE = 'Verdict';

/** 把编译诊断发到问题面板（SPEC §4.3）。 */
export class DiagnosticsPublisher implements vscode.Disposable {
  private readonly collection = vscode.languages.createDiagnosticCollection(COLLECTION_NAME);

  /** 发布一批诊断；同一文件的旧诊断会被整体替换，不留残影。 */
  publish(sourcePath: string, diagnostics: CompileDiagnostic[]): void {
    const fallbackDir = path.dirname(sourcePath);
    const grouped = new Map<string, vscode.Diagnostic[]>();

    for (const diagnostic of diagnostics) {
      // 编译器对 #include 进来的头文件可能给出相对路径，按源文件所在目录还原。
      const filePath = path.isAbsolute(diagnostic.file)
        ? diagnostic.file
        : path.resolve(fallbackDir, diagnostic.file);
      const list = grouped.get(filePath) ?? [];
      list.push(toDiagnostic(diagnostic));
      grouped.set(filePath, list);
    }

    this.collection.clear();
    for (const [filePath, list] of grouped) {
      this.collection.set(vscode.Uri.file(filePath), list);
    }
  }

  clear(): void {
    this.collection.clear();
  }

  dispose(): void {
    this.collection.dispose();
  }
}

function toDiagnostic(diagnostic: CompileDiagnostic): vscode.Diagnostic {
  // 编译器报的是 1 起的行列，vscode 的 Position 从 0 起。
  const line = Math.max(0, diagnostic.line - 1);
  const column = Math.max(0, diagnostic.column - 1);
  const start = new vscode.Position(line, column);

  const result = new vscode.Diagnostic(
    new vscode.Range(start, new vscode.Position(line, column + 1)),
    diagnostic.message,
    toSeverity(diagnostic.severity),
  );
  result.source = SOURCE;
  return result;
}

function toSeverity(severity: CompileDiagnostic['severity']): vscode.DiagnosticSeverity {
  switch (severity) {
    case 'warning':
      return vscode.DiagnosticSeverity.Warning;
    case 'note':
      return vscode.DiagnosticSeverity.Information;
    case 'error':
      return vscode.DiagnosticSeverity.Error;
  }
}
