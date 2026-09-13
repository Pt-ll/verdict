import * as path from 'node:path';
import * as vscode from 'vscode';
import { findProblemRoot, PROBLEM_FILE } from '../core/problem/package';

/** 工作区里所有题目包根目录（problem.json 所在目录）。 */
export async function discoverProblemRoots(): Promise<string[]> {
  const files = await vscode.workspace.findFiles(`**/${PROBLEM_FILE}`, '**/node_modules/**');
  return files.map((uri) => path.dirname(uri.fsPath));
}

/** 当前打开文件所属的题目包根目录；不在任何题目包里则为 null。 */
export async function activeProblemRoot(): Promise<string | null> {
  const document = vscode.window.activeTextEditor?.document;
  if (document === undefined || document.uri.scheme !== 'file') {
    return null;
  }
  return findProblemRoot(path.dirname(document.uri.fsPath), workspaceRoot());
}

/** 第一个工作区文件夹；题目包的向上查找以它为界，免得找到用户主目录去。 */
export function workspaceRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}
