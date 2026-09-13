import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  compile,
  detectAllToolchains,
  type CompileResult,
  type Toolchain,
} from '../core/compiler';
import { runProcess } from '../util/process';
import { summarizeVerdict } from '../core/model';
import type { CancellationTokenLike, SubtaskResult } from '../core/model';
import { loadProblem } from '../core/problem/package';
import { debugFailureText, startDebug, type DebugResult } from './debug';
import { readCompilerSetting, readEngineOptions } from './config';
import {
  clearToolchainCache,
  judgeSourceFile,
  judgeWithProblem,
  type EngineOptions,
  type JudgeOutcome,
} from '../engineFacade';

/** 评测成功那一支的结果，日志与状态栏都只需要它。 */
type JudgedOutcome = Extract<JudgeOutcome, { kind: 'judged' }>;
import type { DiagnosticsPublisher } from './diagnostics';
import type { VerdictOutput } from './output';
import type { VerdictStatusBar } from './statusBar';
import type { CaseDocumentStore } from './caseDocs';

export const COMMAND_CHECK_ENV = 'verdict.checkEnv';
export const COMMAND_JUDGE_CURRENT = 'verdict.judgeCurrent';
export const COMMAND_CANCEL = 'verdict.cancel';
export const COMMAND_DEBUG_CASE = 'verdict.debugCase';

const SETTINGS_SECTION = 'verdict';

export interface CommandDeps {
  context: vscode.ExtensionContext;
  output: VerdictOutput;
  status: VerdictStatusBar;
  diagnostics: DiagnosticsPublisher;
  /** 评测结果的虚拟文档与 diff；由 extension.ts 装配。 */
  caseDocs: CaseDocumentStore;
}

export interface VerdictCommands {
  disposables: vscode.Disposable[];
  /**
   * 评测一个已打开的文档并返回结构化结果；没有真正评测时返回 null。
   *
   * 命令面板与集成测试走同一条链路：面板忽略返回值，测试用它断言 AC/WA/TLE/RE/OLE/CE。
   * 因此这条链路上的弹窗一律不 await（见 reportOutcome 的说明），否则测试会挂到超时。
   */
  judgeDocument(document: vscode.TextDocument): Promise<JudgeOutcome | null>;
  /** 用指定题目包评测；problemRoot 是 problem.json 所在目录。 */
  judgeDocumentInPackage(
    document: vscode.TextDocument,
    problemRoot: string,
    token?: vscode.CancellationToken,
  ): Promise<JudgeOutcome | null>;
}

export function registerCommands(deps: CommandDeps): VerdictCommands {
  const run = new JudgeRunner(deps);
  return {
    disposables: [
      vscode.commands.registerCommand(COMMAND_CHECK_ENV, () => run.checkEnv()),
      vscode.commands.registerCommand(COMMAND_JUDGE_CURRENT, () => run.judgeCurrent()),
      vscode.commands.registerCommand(COMMAND_CANCEL, () => run.cancel()),
      vscode.commands.registerCommand(COMMAND_DEBUG_CASE, () => debugCurrent(deps)),
    ],
    judgeDocument: (document) => run.judgeDocument(document),
    judgeDocumentInPackage: (document, problemRoot, token) =>
      run.judgeDocumentInPackage(document, problemRoot, token),
  };
}

class JudgeRunner {
  private activeCancellation: vscode.CancellationTokenSource | undefined;

  constructor(private readonly deps: CommandDeps) {}

  cancel(): void {
    if (this.activeCancellation === undefined) {
      this.deps.output.info('当前没有正在进行的评测。');
      return;
    }
    this.activeCancellation.cancel();
  }

  async checkEnv(): Promise<void> {
    const { output, status, context } = this.deps;
    const explicitPath = readCompilerSetting();

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'Verdict：检查评测环境',
      },
      async () => {
        clearToolchainCache();
        const toolchains = await detectAllToolchains(
          explicitPath.length > 0 ? { explicitPath } : {},
        );

        if (toolchains.length === 0) {
          status.setWarning('Verdict：未找到可用编译器');
          output.info('未找到可用编译器。');
          if (explicitPath.length > 0) {
            output.info(`设置 verdict.compiler 指定的是：${explicitPath}（探测失败）`);
          }
          output.info('请安装 g++ / clang++ / cl 之一并加入 PATH，或在设置里填写完整路径。');
          await offerChoice(
            'Verdict：未找到可用编译器，无法评测。',
            'error',
            '打开设置',
            'workbench.action.openSettings',
            'verdict.compiler',
            output,
          );
          return;
        }

        output.info(`找到 ${toolchains.length} 个可用编译器：`);
        for (const toolchain of toolchains) {
          output.info(`  · ${toolchain.kind}  ${toolchain.path ?? toolchain.command}`);
          output.info(`    ${toolchain.version}`);
        }

        const cacheDir = path.join(context.globalStorageUri.fsPath, 'cache');
        const selfCheck = await runSelfCheck(toolchains[0], cacheDir);
        output.info(`自检：${selfCheck.ok ? '通过' : '失败'} - ${selfCheck.detail}`);

        if (!selfCheck.ok) {
          status.setWarning(`Verdict：编译器自检失败\n${selfCheck.detail}`);
          await offerChoice(
            `Verdict：编译器自检失败 - ${selfCheck.detail}`,
            'error',
            '查看输出',
            undefined,
            undefined,
            output,
          );
          return;
        }

        const first = toolchains[0];
        status.setIdle(
          `$(beaker) ${first.kind}`,
          `Verdict：使用 ${first.command}\n${first.version}\n${selfCheck.detail}`,
        );
        await offerChoice(
          `Verdict：${first.kind} 可用，${selfCheck.detail}。`,
          'info',
          '查看输出',
          undefined,
          undefined,
          output,
        );
      },
    );
  }

  async judgeCurrent(): Promise<void> {
    const document = vscode.window.activeTextEditor?.document;
    if (document === undefined) {
      await vscode.window.showWarningMessage(
        'Verdict：请先打开一个已保存到磁盘的源码文件。',
      );
      return;
    }
    await this.judgeDocument(document);
  }

  async judgeDocument(
    document: vscode.TextDocument,
    externalToken?: vscode.CancellationToken,
  ): Promise<JudgeOutcome | null> {
    return this.runJudge(
      document,
      (sourcePath, options, token, report) => judgeSourceFile(sourcePath, options, token, report),
      externalToken,
    );
  }

  /**
   * 用指定的题目包评测一个文档。
   *
   * Testing 面板和 M3 的比赛流程都走这里：题目包在 .verdict/problems/ 下，
   * 选手源码在 players/ 里，光靠源码位置是找不到题目的。
   * 与 judgeDocument 共用全套加锁/保存/报告逻辑，所以两条入口行为一致：
   * 都会写进虚拟文档、WA 都会开 diff、都能被「取消当前任务」打断。
   */
  async judgeDocumentInPackage(
    document: vscode.TextDocument,
    problemRoot: string,
    externalToken?: vscode.CancellationToken,
  ): Promise<JudgeOutcome | null> {
    return this.runJudge(
      document,
      async (sourcePath, options, token, report) => {
        const pkg = await loadProblem(problemRoot);
        return judgeWithProblem(sourcePath, pkg, options, token, report);
      },
      externalToken,
    );
  }

  private async runJudge(
    document: vscode.TextDocument,
    execute: (
      sourcePath: string,
      options: EngineOptions,
      token: CancellationTokenLike,
      report: (stage: string) => void,
    ) => Promise<JudgeOutcome>,
    externalToken?: vscode.CancellationToken,
  ): Promise<JudgeOutcome | null> {
    const { output, status, diagnostics } = this.deps;

    if (document.uri.scheme !== 'file') {
      await vscode.window.showWarningMessage(
        'Verdict：请先打开一个已保存到磁盘的源码文件。',
      );
      return null;
    }

    if (this.activeCancellation !== undefined) {
      await vscode.window.showWarningMessage('Verdict：已有评测在进行中，可先执行「Verdict: 取消当前任务」。');
      return null;
    }

    // 评测的是磁盘上的内容：不保存就等于编译上一版，结论会骗人。
    if (document.isDirty) {
      const saved = await document.save();
      if (!saved) {
        await vscode.window.showWarningMessage('Verdict：文件保存失败，已取消评测。');
        return null;
      }
    }

    const sourcePath = document.uri.fsPath;
    const cancellation = new vscode.CancellationTokenSource();
    // 外部取消（Testing 面板上点停止）也要能中断这次评测，而不是各管各的。
    if (externalToken?.isCancellationRequested === true) {
      cancellation.cancel();
    }
    const unsubscribe = externalToken?.onCancellationRequested(() => cancellation.cancel());
    this.activeCancellation = cancellation;
    diagnostics.clear();
    status.setBusy('评测中');
    output.info(`开始评测：${sourcePath}`);

    try {
      const outcome = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Verdict',
          cancellable: true,
        },
        async (progress, progressToken) => {
          progressToken.onCancellationRequested(() => cancellation.cancel());
          return execute(
            sourcePath,
            readEngineOptions(this.deps.context),
            cancellation.token,
            (stage) => {
              progress.report({ message: stage });
              output.debug(`阶段：${stage}`);
            },
          );
        },
      );

      await this.reportOutcome(outcome, sourcePath);
      return outcome;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      output.error(`评测过程中出错：${message}`);
      status.setWarning('Verdict：评测失败');
      // 同样不 await，否则 finally 不执行，评测锁会一直握着。
      void vscode.window.showErrorMessage(`Verdict：评测失败 - ${message}`);
      return null;
    } finally {
      unsubscribe?.dispose();
      cancellation.dispose();
      this.activeCancellation = undefined;
    }
  }

  private async reportOutcome(outcome: JudgeOutcome, sourcePath: string): Promise<void> {
    const { output, status, diagnostics } = this.deps;

    switch (outcome.kind) {
      case 'no-tests': {
        const base = path.basename(sourcePath, path.extname(sourcePath));
        status.setWarning('Verdict：未找到测试数据');
        // 题目包里没有测试点时 message 已经写清了该往哪里放数据，直接用它。
        if (outcome.message !== undefined) {
          output.info(outcome.message);
          void vscode.window.showWarningMessage(`Verdict：${outcome.message}`);
          return;
        }
        output.info('未找到测试数据。');
        output.info(`预期位置：与源文件同名的 ${base}.in 与 ${base}.out，或同级 tests/ 目录下的 1.in / 1.out。`);
        // 故意不 await：通知的 Promise 只在用户交互或手动关闭时才 resolve，
        // 若在这里等，评测锁要等到用户点掉弹窗才释放，下一次评测会被误判成「正在评测中」。
        void vscode.window.showWarningMessage(
          `Verdict：未找到测试数据。请放置 ${base}.in 与 ${base}.out 后再试。`,
        );
        return;
      }

      case 'no-compiler': {
        status.setWarning(outcome.message);
        output.error(outcome.message);
        void vscode.window.showErrorMessage(`Verdict：${outcome.message}`);
        return;
      }

      case 'compile-failed': {
        diagnostics.publish(sourcePath, outcome.compile.diagnostics);
        for (const item of outcome.compile.diagnostics) {
          output.error(`${item.file}:${item.line}:${item.column} ${item.message}`);
        }
        const errorCount = outcome.compile.diagnostics.filter((d) => d.severity === 'error').length;
        status.setWarning('Verdict：编译失败');
        void vscode.window
          .showErrorMessage(
            `Verdict：编译失败（${errorCount} 个错误），详见问题面板。`,
            '查看输出',
          )
          .then((choice) => {
            if (choice === '查看输出') {
              output.show();
            }
          });
        return;
      }

      case 'judged': {
        if (outcome.cancelled) {
          output.info('评测已被取消。');
        }
        logJudged(output, outcome);

        // 记下这一轮输出，WA 时才有东西可以 diff。
        // 没有题目包时用源文件名当标识：M1 的约定式数据也能享受到 diff。
        const owner = outcome.problemId ?? path.basename(sourcePath, path.extname(sourcePath));
        this.deps.caseDocs.record(owner, outcome.cases);

        const total = outcome.cases.length;
        const accepted = outcome.cases.filter((item) => item.verdict === 'AC').length;
        const worst = summarizeVerdict(outcome.cases) ?? 'AC';
        // 有题目包才报分数：M1 的约定式数据每个点 1 分，「得分 1/1」只是噪音。
        const scoreText =
          outcome.problemId === undefined ? '' : `，得分 ${outcome.score}/${outcome.maxScore}`;

        if (accepted === total && total > 0) {
          status.setIdle(
            `$(beaker) AC ${accepted}/${total}`,
            `Verdict：全部通过（${outcome.elapsedMs}ms）${scoreText}`,
          );
        } else {
          status.setWarning(`Verdict：${worst} ${accepted}/${total}${scoreText}`);
        }

        if (!outcome.cancelled) {
          const summary = `Verdict：${worst} ${accepted}/${total}${scoreText}，用时 ${outcome.elapsedMs}ms。`;
          void vscode.window.showInformationMessage(summary, '查看输出').then((choice) => {
            if (choice === '查看输出') {
              output.show();
            }
          });
        }

        await this.openDiffIfFailed(owner, outcome);
        return;
      }
    }
  }

  /**
   * WA / PC 时自动打开 diff（SPEC §4.5）。
   *
   * 只挑第一个失败点：一次评测可能几十个点，全打开会把编辑器铺满，反而什么都看不见。
   */
  private async openDiffIfFailed(owner: string, outcome: JudgedOutcome): Promise<void> {
    if (outcome.cancelled || !readAutoDiffSetting()) {
      return;
    }
    const failed = outcome.cases.find(
      (item) => item.verdict === 'WA' || item.verdict === 'PC',
    );
    if (failed === undefined) {
      return;
    }
    const where = failed.firstDiffLine === undefined ? '' : `（第 ${failed.firstDiffLine} 行不同）`;
    this.deps.output.info(`打开 diff：测试点 ${failed.test}${where}`);
    await this.deps.caseDocs.openDiff(owner, failed.test, failed.firstDiffLine);
  }
}

function readAutoDiffSetting(): boolean {
  return (
    vscode.workspace.getConfiguration(SETTINGS_SECTION).get<boolean>('autoDiff') !== false
  );
}

/** 「Verdict: 调试首测点」：用当前文件的题目包，拿第一个测试点的输入起调试会话。 */
async function debugCurrent(deps: CommandDeps): Promise<void> {
  const document = vscode.window.activeTextEditor?.document;
  if (document === undefined) {
    void vscode.window.showWarningMessage('Verdict：请先打开一个源码文件。');
    return;
  }

  const result: DebugResult = await startDebug(
    { context: deps.context, output: deps.output },
    document,
  );
  const failure = debugFailureText(result);
  if (failure === null) {
    return;
  }

  deps.output.error(failure);
  if (result.kind === 'no-debugger') {
    // 直接带用户去装扩展，而不是只丢一句「找不到 xxx」。
    await offerChoice(
      `Verdict：${failure}`,
      'error',
      '搜索扩展',
      'workbench.extensions.search',
      result.extensionId,
      deps.output,
    );
    return;
  }
  void vscode.window.showErrorMessage(`Verdict：${failure}`);
}

function logJudged(output: VerdictOutput, outcome: JudgedOutcome): void {
  output.info(`测试数据目录：${outcome.dataDir}`);
  if (outcome.problemId !== undefined) {
    output.info(`题目包：${outcome.problemId}`);
  }
  for (const item of outcome.cases) {
    const memory = item.memoryKb > 0 ? `${(item.memoryKb / 1024).toFixed(1)}MB` : 'n/a';
    output.info(
      `  ${item.test}: ${item.verdict}  ${item.timeMs}ms  ${memory}` +
        (item.message !== undefined ? `  ${item.message}` : ''),
    );
  }
  const accepted = outcome.cases.filter((item) => item.verdict === 'AC').length;
  output.info(`评测结束：AC ${accepted} / 共 ${outcome.cases.length}，用时 ${outcome.elapsedMs}ms`);

  for (const subtask of outcome.subtasks) {
    output.info(
      `  子任务 ${subtask.id}：${subtask.score}/${subtask.maxScore} 分（${subtaskStatusText(subtask.status)}）`,
    );
  }
  if (outcome.problemId !== undefined) {
    output.info(`得分：${outcome.score} / ${outcome.maxScore}`);
  }
}

function subtaskStatusText(status: SubtaskResult['status']): string {
  switch (status) {
    case 'full':
      return '满分';
    case 'partial':
      return '部分分';
    case 'none':
      return '未得分';
    case 'skipped':
      // 说清楚是「没跑」而不是「跑了没分」，这两件事对选手的意义完全不同。
      return '依赖未满足，已跳过';
  }
}


interface SelfCheckResult {
  ok: boolean;
  detail: string;
}

/**
 * 试编译并运行一个最小程序。
 *
 * 只探测到编译器不等于环境可用：缺链接器、缺运行库、权限问题都要真的编译一次才暴露。
 */
async function runSelfCheck(
  toolchain: Toolchain,
  cacheDir: string,
): Promise<SelfCheckResult> {
  if (toolchain.kind === 'python') {
    return { ok: true, detail: '解释型语言，跳过编译自检' };
  }

  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'verdict-selfcheck-'));
  try {
    const sourcePath = path.join(tempDir, 'selfcheck.cpp');
    await fs.promises.writeFile(
      sourcePath,
      '#include <cstdio>\nint main() { std::printf("verdict-ok\\n"); return 0; }\n',
      'utf8',
    );

    const compiled: CompileResult = await compile(toolchain, sourcePath, { cacheDir });
    if (!compiled.ok) {
      const first = compiled.diagnostics[0];
      return { ok: false, detail: first ? `编译失败：${first.message}` : '编译失败' };
    }

    const run = await runProcess(compiled.runCmd.cmd, compiled.runCmd.args, 10_000);
    if (run.code !== 0) {
      return { ok: false, detail: `自检程序退出码 ${run.code ?? 'null'}：${run.stderr.trim()}` };
    }
    if (run.stdout.trim() !== 'verdict-ok') {
      return { ok: false, detail: `自检输出异常：${run.stdout.trim()}` };
    }
    return {
      ok: true,
      detail: compiled.cached ? '编译 + 运行自检通过（命中缓存）' : '编译 + 运行自检通过',
    };
  } catch (err) {
    return { ok: false, detail: `自检异常：${err instanceof Error ? err.message : String(err)}` };
  } finally {
    await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function offerChoice(
  message: string,
  kind: 'info' | 'error',
  actionLabel: string,
  command: string | undefined,
  commandArg: string | undefined,
  output: VerdictOutput,
): Promise<void> {
  const choice =
    kind === 'error'
      ? await vscode.window.showErrorMessage(message, actionLabel)
      : await vscode.window.showInformationMessage(message, actionLabel);
  if (choice !== actionLabel) {
    return;
  }
  if (command !== undefined) {
    await vscode.commands.executeCommand(command, commandArg);
  } else {
    output.show();
  }
}
