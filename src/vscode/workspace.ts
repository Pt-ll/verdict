import * as path from 'node:path';
import * as vscode from 'vscode';
import * as fs from 'node:fs';
import { findProblemRoot, PROBLEM_FILE } from '../core/problem/package';
import { PROBLEMS_DIR, VERDICT_DIR } from '../core/contest/contest';
import { isFile } from '../util/files';

/**
 * 工作区里所有题目包根目录（problem.json 所在目录）。
 *
 * 先显式枚举 .verdict/problems/（SPEC §6.1 规定的比赛布局），再用 findFiles 兜底找
 * 放在别处的题目包。之所以不只用 findFiles：它对点目录是否可见取决于用户设置，
 * 而 .verdict 是点目录——比赛题目不该因为「搜索排除了隐藏文件」就从 Testing 面板里消失。
 */
export async function discoverProblemRoots(): Promise<string[]> {
  const roots = new Set<string>();

  const root = workspaceRoot();
  if (root !== undefined) {
    const problemsDir = path.join(root, VERDICT_DIR, PROBLEMS_DIR);
    for (const entry of await readdirOrEmpty(problemsDir)) {
      const candidate = path.join(problemsDir, entry);
      if (await isFile(path.join(candidate, PROBLEM_FILE))) {
        roots.add(candidate);
      }
    }
  }

  for (const uri of await vscode.workspace.findFiles(
    `**/${PROBLEM_FILE}`,
    '**/node_modules/**',
  )) {
    roots.add(path.dirname(uri.fsPath));
  }

  return [...roots];
}

async function readdirOrEmpty(target: string): Promise<string[]> {
  try {
    const entries = await fs.promises.readdir(target, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }
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
