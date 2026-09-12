import { createComparator, type Comparator } from '../compare/compare';
import type {
  CancellationTokenLike,
  ComparatorConfig,
  Limits,
  RunVerdict,
  Verdict,
} from '../model';
import type { RunCommand, RunResult, Sandbox } from '../sandbox/sandbox';

export interface CaseResult {
  test: string;
  verdict: Verdict;
  score: number;
  timeMs: number;
  memoryKb: number;
  exitCode: number | null;
  signal: string | null;
  message?: string;
  /** 实际输出与答案，供 diff 与报告使用（SPEC 未定义，M2 的 diff 需要）。 */
  output: Buffer;
  answer: Buffer;
  firstDiffLine?: number;
}

export interface JudgeCaseInput {
  testId: string;
  input: Buffer;
  answer: Buffer;
  runCmd: RunCommand;
  /** 该测试点分值；缺省按 1 计，M2 引入子任务后会显式传入。 */
  points?: number;
}

export interface JudgeOptions {
  limits: Limits;
  comparator: ComparatorConfig;
}

/**
 * 单测试点判定。
 *
 * 流程严格按 SPEC §5.5：
 *   运行 -> 超时/内存/输出/退出码优先判定 -> 都正常才交给比较器。
 * 编译错误不在这里处理，它由编译阶段单独给出 CE。
 */
export class Judge {
  private readonly comparator: Comparator;

  constructor(
    private readonly sandbox: Sandbox,
    private readonly options: JudgeOptions,
  ) {
    this.comparator = createComparator(options.comparator);
  }

  async judgeCase(
    test: JudgeCaseInput,
    token?: CancellationTokenLike,
  ): Promise<CaseResult> {
    const run = await this.sandbox.run(
      test.runCmd,
      test.input,
      this.options.limits,
      token,
    );
    const points = test.points ?? 1;

    if (run.status !== 'OK') {
      return {
        test: test.testId,
        verdict: runStatusToVerdict(run.status),
        score: 0,
        timeMs: run.wallMs,
        memoryKb: run.peakMemKb,
        exitCode: run.exitCode,
        signal: run.signal,
        message: describeRunFailure(run),
        output: run.stdout,
        answer: test.answer,
      };
    }

    const compared = await this.comparator.compare({
      input: test.input,
      output: run.stdout,
      answer: test.answer,
    });

    return {
      test: test.testId,
      verdict: compared.verdict,
      score: points * compared.scoreRatio,
      timeMs: run.wallMs,
      memoryKb: run.peakMemKb,
      exitCode: run.exitCode,
      signal: run.signal,
      message: compared.detail,
      output: run.stdout,
      answer: test.answer,
      firstDiffLine: compared.firstDiffLine,
    };
  }
}

function runStatusToVerdict(status: RunVerdict): Verdict {
  switch (status) {
    case 'TLE':
      return 'TLE';
    case 'MLE':
      return 'MLE';
    case 'OLE':
      return 'OLE';
    case 'RE':
      return 'RE';
    case 'INTERNAL':
      // 评测流程自身出问题（启动失败等）不是选手程序的错，必须如实上报 UKE。
      return 'UKE';
    case 'OK':
      return 'AC';
  }
}

function describeRunFailure(run: RunResult): string {
  switch (run.status) {
    case 'TLE':
      return `超时（${run.wallMs}ms）`;
    case 'MLE':
      return `内存超限（峰值 ${Math.round(run.peakMemKb / 1024)} MB）`;
    case 'OLE':
      return '输出超限';
    case 'RE':
      return run.signal
        ? `运行时错误（信号 ${run.signal}）`
        : `运行时错误（退出码 ${run.exitCode}）`;
    case 'INTERNAL':
      return firstLine(run.stderr) || '评测内部错误';
    case 'OK':
      return '';
  }
  return '';
}

function firstLine(buffer: Buffer): string {
  const line = buffer
    .toString('utf8')
    .split('\n')
    .map((text) => text.trim())
    .find((text) => text.length > 0);
  if (line === undefined) {
    return '';
  }
  return line.length > 200 ? `${line.slice(0, 200)}…` : line;
}
