import * as path from 'node:path';
import * as vscode from 'vscode';
import { clearSubtasks, evenSubtasks, planAddTests, withLimits } from '../core/problem/edit';
import {
  loadProblem,
  PROBLEM_FILE,
  saveProblem,
  type ProblemPackage,
} from '../core/problem/package';
import type { CaseDocumentStore } from './caseDocs';
import type { VerdictOutput } from './output';
import { activeProblemRoot, discoverProblemRoots, workspaceRoot } from './workspace';

export const COMMAND_ADD_TESTS = 'verdict.addTests';
export const COMMAND_CONFIGURE_SUBTASKS = 'verdict.configureSubtasks';
export const COMMAND_SET_LIMITS = 'verdict.setLimits';
export const COMMAND_SHOW_DIFF = 'verdict.showDiff';

export interface ProblemCommandDeps {
  output: VerdictOutput;
  caseDocs: CaseDocumentStore;
  /** 题目包被改动后刷新 Testing 树。 */
  refreshTests: () => Promise<void>;
}

/**
 * 改题目包的那几个命令（SPEC §4.1）。
 *
 * 所有写操作都通过 saveProblem 落到 problem.json，绝不碰数据文件与选手源码。
 * 真正的逻辑在 core/problem/edit.ts 里（纯函数、可单测），这里只负责收集输入与提示。
 */
export function registerProblemCommands(deps: ProblemCommandDeps): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand(COMMAND_ADD_TESTS, guard(deps, addTests)),
    vscode.commands.registerCommand(COMMAND_CONFIGURE_SUBTASKS, guard(deps, configureSubtasks)),
    vscode.commands.registerCommand(COMMAND_SET_LIMITS, guard(deps, setLimits)),
    vscode.commands.registerCommand(COMMAND_SHOW_DIFF, guard(deps, showDiff)),
  ];
}

/** 命令出错时别静默：通知里给第一行，完整内容（problem.json 的问题是分行列的）进输出通道。 */
function guard(
  deps: ProblemCommandDeps,
  run: (deps: ProblemCommandDeps) => Promise<void>,
): () => Promise<void> {
  return async () => {
    try {
      await run(deps);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      deps.output.error(`命令失败：\n${message}`);
      const firstLine = message.split('\n')[0] ?? message;
      void vscode.window
        .showErrorMessage(`Verdict：${firstLine}`, '查看输出')
        .then((choice) => {
          if (choice === '查看输出') {
            deps.output.show();
          }
        });
    }
  };
}

async function addTests(deps: ProblemCommandDeps): Promise<void> {
  const pkg = await resolvePackage();
  if (pkg === null) {
    return;
  }

  const plan = await planAddTests(pkg);
  if (plan.added.length === 0) {
    deps.output.info(`没有新的测试点：${pkg.dataDir} 里的数据都已登记。`);
    void vscode.window.showInformationMessage('Verdict：没有发现新的测试点。');
    return;
  }

  const names = plan.added.map((test) => test.id).join('、');
  const choice = await vscode.window.showInformationMessage(
    `Verdict：发现 ${plan.added.length} 个新测试点（${names}），登记进 problem.json？`,
    '登记',
  );
  if (choice !== '登记') {
    return;
  }

  pkg.problem.tests = plan.tests;
  await saveProblem(pkg);
  await afterChange(deps, `已登记 ${plan.added.length} 个测试点：${names}。`);
}

async function configureSubtasks(deps: ProblemCommandDeps): Promise<void> {
  const pkg = await resolvePackage();
  if (pkg === null) {
    return;
  }
  if (pkg.problem.tests.length === 0) {
    void vscode.window.showWarningMessage(
      'Verdict：这个题目还没有测试点，先执行「Verdict: 导入测试点」。',
    );
    return;
  }

  const pick = await vscode.window.showQuickPick(
    [
      { label: '按测试点均分', detail: '把测试点按顺序分成几组，组内全对才给分' },
      { label: '清空子任务', detail: '所有测试点直接计入总分' },
      { label: '打开 problem.json 手动编辑', detail: '细调分值、依赖与计分方式' },
    ],
    { title: 'Verdict：配置子任务' },
  );
  if (pick === undefined) {
    return;
  }

  if (pick.label === '打开 problem.json 手动编辑') {
    await vscode.window.showTextDocument(vscode.Uri.file(path.join(pkg.rootDir, PROBLEM_FILE)));
    return;
  }

  if (pick.label === '清空子任务') {
    pkg.problem.subtasks = [];
    // 测试点上的 subtask 字段要一起清掉：留着它下次加载就会因「两边不一致」报错。
    pkg.problem.tests = clearSubtasks(pkg.problem.tests);
    await saveProblem(pkg);
    await afterChange(deps, '已清空子任务，所有测试点直接计入总分。');
    return;
  }

  const total = pkg.problem.tests.length;
  const groups = await vscode.window.showInputBox({
    title: 'Verdict：分成几个子任务',
    value: String(Math.min(2, total)),
    validateInput: (text) => {
      const count = Number.parseInt(text, 10);
      return Number.isInteger(count) && count >= 1 && count <= total
        ? undefined
        : `请输入 1 到 ${total} 之间的整数`;
    },
  });
  if (groups === undefined) {
    return;
  }

  const plan = evenSubtasks(pkg.problem.tests, Number.parseInt(groups, 10));
  pkg.problem.subtasks = plan.subtasks;
  pkg.problem.tests = plan.tests;
  await saveProblem(pkg);
  await afterChange(
    deps,
    `已分成 ${plan.subtasks.length} 个子任务：` +
      `${plan.subtasks.map((item) => `${item.id}（${item.points} 分）`).join('、')}。` +
      '分值、依赖与计分方式可以在 problem.json 里细调。',
  );
}

async function setLimits(deps: ProblemCommandDeps): Promise<void> {
  const pkg = await resolvePackage();
  if (pkg === null) {
    return;
  }

  const { limits } = pkg.problem;
  const timeMs = await askNumber('时间限制（毫秒）', limits.timeMs, (value) => value > 0);
  if (timeMs === undefined) {
    return;
  }
  const memoryMb = await askNumber('内存限制（MB）', limits.memoryMb, (value) => value > 0);
  if (memoryMb === undefined) {
    return;
  }
  const outputKb = await askNumber('输出上限（KB）', limits.outputKb, (value) => value >= 0);
  if (outputKb === undefined) {
    return;
  }

  // 栈上限跟着内存走：SPEC §6.3 的示例就是配套的，分两处填只会让人多按一次回车。
  pkg.problem = withLimits(pkg.problem, { timeMs, memoryMb, stackMb: memoryMb, outputKb });
  await saveProblem(pkg);
  await afterChange(
    deps,
    `已设置限制：${timeMs}ms、${memoryMb}MB、输出上限 ${outputKb}KB（栈上限同内存）。`,
  );
}

async function showDiff(deps: ProblemCommandDeps): Promise<void> {
  const owner = await currentOwner();
  if (owner === null) {
    void vscode.window.showWarningMessage('Verdict：请先打开要对比的源码文件。');
    return;
  }

  const cases = deps.caseDocs.casesOf(owner);
  if (cases.length === 0) {
    void vscode.window.showWarningMessage(
      'Verdict：还没有这个题目的评测结果，先跑一次评测再来对比输出。',
    );
    return;
  }

  // 失败的点排在前面：要对比的多半是挂掉的那个。
  const failed = cases.filter((item) => item.verdict === 'WA' || item.verdict === 'PC');
  const pool = failed.length > 0 ? failed : cases;
  const picked = await vscode.window.showQuickPick(
    pool.map((item) => ({
      label: `#${item.test}`,
      description:
        `${item.verdict}` +
        (item.firstDiffLine === undefined ? '' : `  第 ${item.firstDiffLine} 行不同`),
      detail: item.message,
      result: item,
    })),
    { title: 'Verdict：对比哪个测试点' },
  );
  if (picked === undefined) {
    return;
  }
  await deps.caseDocs.openDiff(owner, picked.result.test, picked.result.firstDiffLine);
}

async function askNumber(
  label: string,
  current: number,
  acceptable: (value: number) => boolean,
): Promise<number | undefined> {
  const text = await vscode.window.showInputBox({
    title: `Verdict：设置限制 - ${label}`,
    value: String(current),
    validateInput: (input) => {
      const value = Number.parseInt(input, 10);
      return Number.isInteger(value) && acceptable(value) ? undefined : '请输入一个合法的整数';
    },
  });
  return text === undefined ? undefined : Number.parseInt(text, 10);
}

/** showDiff 用的标识：与 commands.ts 记录结果时用的是同一套（题目 id 或源文件名）。 */
async function currentOwner(): Promise<string | null> {
  const document = vscode.window.activeTextEditor?.document;
  if (document === undefined || document.uri.scheme !== 'file') {
    return null;
  }
  const root = await activeProblemRoot();
  if (root === null) {
    return path.basename(document.uri.fsPath, path.extname(document.uri.fsPath));
  }
  return (await loadProblem(root)).problem.id;
}

/**
 * 确定这次操作哪个题目包：优先当前文件所属的，其次工作区里唯一/用户选中的那个。
 *
 * 不做「猜」：一个工作区里有多个题目包、当前文件又不在任何一个里面时，
 * 必须让用户明确选一个，改错文件比多按一次回车糟糕得多。
 */
async function resolvePackage(): Promise<ProblemPackage | null> {
  const root = await activeProblemRoot();
  if (root !== null) {
    return await loadProblem(root);
  }

  const roots = await discoverProblemRoots();
  if (roots.length === 0) {
    void vscode.window.showWarningMessage(
      'Verdict：工作区里没有题目包。在题目目录里放一个 problem.json，或执行「Verdict: 新建题目」。',
    );
    return null;
  }
  if (roots.length === 1) {
    return await loadProblem(roots[0] ?? '');
  }

  const base = workspaceRoot() ?? '';
  const picked = await vscode.window.showQuickPick(
    roots.map((item) => ({
      label: path.basename(item),
      description: path.relative(base, item),
      root: item,
    })),
    { title: 'Verdict：对哪个题目操作' },
  );
  return picked === undefined ? null : await loadProblem(picked.root);
}

async function afterChange(deps: ProblemCommandDeps, message: string): Promise<void> {
  await deps.refreshTests();
  deps.output.info(message);
  void vscode.window.showInformationMessage(`Verdict：${message}`);
}
