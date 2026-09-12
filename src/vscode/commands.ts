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
import { DEFAULT_LIMITS, type ComparatorConfig, type Limits, type Verdict } from '../core/model';
import type { CaseResult } from '../core/judge/judge';
import {
  clearToolchainCache,
  judgeSourceFile,
  type EngineOptions,
  type JudgeOutcome,
} from '../engineFacade';
import type { DiagnosticsPublisher } from './diagnostics';
import type { VerdictOutput } from './output';
import type { VerdictStatusBar } from './statusBar';

export const COMMAND_CHECK_ENV = 'verdict.checkEnv';
export const COMMAND_JUDGE_CURRENT = 'verdict.judgeCurrent';
export const COMMAND_CANCEL = 'verdict.cancel';

const SETTINGS_SECTION = 'verdict';

export interface CommandDeps {
  context: vscode.ExtensionContext;
  output: VerdictOutput;
  status: VerdictStatusBar;
  diagnostics: DiagnosticsPublisher;
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
}

export function registerCommands(deps: CommandDeps): VerdictCommands {
  const run = new JudgeRunner(deps);
  return {
    disposables: [
      vscode.commands.registerCommand(COMMAND_CHECK_ENV, () => run.checkEnv()),
      vscode.commands.registerCommand(COMMAND_JUDGE_CURRENT, () => run.judgeCurrent()),
      vscode.commands.registerCommand(COMMAND_CANCEL, () => run.cancel()),
    ],
    judgeDocument: (document) => run.judgeDocument(document),
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

  async judgeDocument(document: vscode.TextDocument): Promise<JudgeOutcome | null> {
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
          return judgeSourceFile(
            sourcePath,
            readEngineOptions(this.deps),
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
        logCases(output, outcome.cases, outcome.elapsedMs, outcome.dataDir);

        const total = outcome.cases.length;
        const accepted = outcome.cases.filter((item) => item.verdict === 'AC').length;
        const worst = worstVerdict(outcome.cases);

        if (accepted === total && total > 0) {
          status.setIdle(
            `$(beaker) AC ${accepted}/${total}`,
            `Verdict：全部通过（${outcome.elapsedMs}ms）`,
          );
        } else {
          status.setWarning(`Verdict：${worst} ${accepted}/${total}`);
        }

        if (!outcome.cancelled) {
          const summary = `Verdict：${worst} ${accepted}/${total}，用时 ${outcome.elapsedMs}ms。`;
          void vscode.window.showInformationMessage(summary, '查看输出').then((choice) => {
            if (choice === '查看输出') {
              output.show();
            }
          });
        }
        return;
      }
    }
  }
}

function readCompilerSetting(): string {
  return (vscode.workspace.getConfiguration(SETTINGS_SECTION).get<string>('compiler') ?? '').trim();
}

function readEngineOptions(deps: CommandDeps): EngineOptions {
  const config = vscode.workspace.getConfiguration(SETTINGS_SECTION);
  const memoryMb = config.get<number>('defaultMemoryMb') ?? DEFAULT_LIMITS.memoryMb;
  const limits: Limits = {
    timeMs: config.get<number>('defaultTimeMs') ?? DEFAULT_LIMITS.timeMs,
    memoryMb,
    // 栈上限默认与内存上限同值，与 SPEC §6.3 的 problem.json 示例一致。
    stackMb: memoryMb,
    outputKb: config.get<number>('outputLimitKb') ?? DEFAULT_LIMITS.outputKb,
  };

  const comparator: ComparatorConfig = {
    mode: config.get<'default' | 'line' | 'real'>('comparator') ?? 'default',
    absEps: config.get<number>('realAbsEps'),
    relEps: config.get<number>('realRelEps'),
  };

  return {
    compilerPath: readCompilerSetting(),
    flags: config.get<string[]>('flags') ?? [],
    limits,
    comparator,
    cacheDir: path.join(deps.context.globalStorageUri.fsPath, 'cache'),
  };
}

function logCases(
  output: VerdictOutput,
  cases: CaseResult[],
  elapsedMs: number,
  dataDir: string,
): void {
  output.info(`测试数据目录：${dataDir}`);
  for (const item of cases) {
    const memory = item.memoryKb > 0 ? `${(item.memoryKb / 1024).toFixed(1)}MB` : 'n/a';
    output.info(
      `  ${item.test}: ${item.verdict}  ${item.timeMs}ms  ${memory}` +
        (item.message !== undefined ? `  ${item.message}` : ''),
    );
  }
  const accepted = cases.filter((item) => item.verdict === 'AC').length;
  output.info(`评测结束：AC ${accepted} / 共 ${cases.length}，用时 ${elapsedMs}ms`);
}

const VERDICT_PRIORITY: Verdict[] = ['UKE', 'RE', 'MLE', 'OLE', 'TLE', 'WA', 'PC', 'CE', 'AC'];

function worstVerdict(cases: CaseResult[]): Verdict {
  for (const verdict of VERDICT_PRIORITY) {
    if (cases.some((item) => item.verdict === verdict)) {
      return verdict;
    }
  }
  return 'AC';
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
