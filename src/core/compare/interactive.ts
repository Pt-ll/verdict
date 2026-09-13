import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { CancellationTokenLike, Limits, Verdict } from '../model';
import { compile, type Toolchain } from '../compiler';
import type { RunCommand, RunResult, Sandbox } from '../sandbox/sandbox';
import { interpretCheckerExit } from './spj';

/**
 * 交互题的判定结果。
 *
 * 不复用 CompareResult：那个类型的 verdict 只有 AC/WA/PC/UKE——在单进程流程里，
 * TLE/MLE/OLE/RE 是「运行状态」给出的，发生在比较之前。交互题把运行也包进来了，
 * 所以这里必须能表达这些判定，否则选手超时只能被硬塞成 WA。
 */
export interface InteractiveOutcome {
  verdict: Verdict;
  scoreRatio: number;
  detail: string;
}

/** 交互题：起选手程序并与 interactor 对接（SPEC §5.6）。 */
export interface InteractiveRunner {
  run(
    contestant: RunCommand,
    input: Buffer,
    answer: Buffer,
    limits: Limits,
    token?: CancellationTokenLike,
  ): Promise<InteractiveRunOutcome>;
}

export interface InteractiveRunOutcome {
  result: InteractiveOutcome;
  run: RunResult;
  /**
   * 两个方向的字节流。调试交互题时靠 toPrimary 重放：把交互器发给选手的那串输入
   * 喂给调试会话，就能在真实输入下断点单步（前提是选手的反应与录制时一致）。
   */
  transcript: { toPrimary: Buffer; fromPrimary: Buffer };
}

// 交互题的判定规则。顺序是有讲究的：
//   1. 选手被限额杀 -> TLE / MLE / OLE（SPEC §8.5 的优先级最高，交互题也不例外）；
//   2. 选手自己崩了，而交互器只是说「答案不对」-> RE。
//      交互器看到 EOF 就会判错，如果照它报 WA，程序崩溃这个真正的根因就被藏住了；
//   3. 其余情况以交互器的退出码为准（testlib 约定，与 checker 同一套码）；
//   4. 交互器没能正常结束 -> UKE：那是出题人的问题，不能算到选手头上。
export function decideInteractiveVerdict(
  primary: RunResult,
  secondary: RunResult & { killed: boolean },
): InteractiveOutcome {
  if (primary.status === 'TLE' || primary.status === 'MLE' || primary.status === 'OLE') {
    return {
      verdict: primary.status,
      scoreRatio: 0,
      detail: describePrimaryFailure(primary),
    };
  }
  if (primary.status === 'INTERNAL') {
    return {
      verdict: 'UKE',
      scoreRatio: 0,
      detail: `选手程序没能启动：${firstLine(primary.stderr)}`,
    };
  }
  if (secondary.killed || secondary.status === 'INTERNAL') {
    return {
      verdict: 'UKE',
      scoreRatio: 0,
      detail: `交互器没能正常结束${secondary.killed ? '（触发限额被杀）' : ''}：${firstLine(secondary.stderr)}`,
    };
  }

  const judged = interpretCheckerExit(
    secondary.exitCode,
    // 交互器的 stdout 是对话通道，我们看不到也不该去解析它；分数与说明只看 stderr。
    '',
    secondary.stderr.toString('utf8'),
    '交互器',
  );
  if (primary.status === 'RE' && judged.verdict === 'WA') {
    return {
      verdict: 'RE',
      scoreRatio: 0,
      detail: `${describePrimaryFailure(primary)}；交互器的判定是「${judged.detail}」，但程序崩溃才是根因`,
    };
  }
  if (judged.verdict === 'UKE') {
    return {
      verdict: 'UKE',
      scoreRatio: 0,
      detail: `${judged.detail}（选手程序：${primary.status}）`,
    };
  }
  return judged;
}

function describePrimaryFailure(run: RunResult): string {
  switch (run.status) {
    case 'TLE':
      return `超时（${String(run.wallMs)}ms）`;
    case 'MLE':
      return `内存超限（峰值 ${String(Math.round(run.peakMemKb / 1024))} MB）`;
    case 'OLE':
      return '交互过程中输出过多';
    case 'RE':
      return run.signal === null
        ? `运行时错误（退出码 ${String(run.exitCode)}）`
        : `运行时错误（信号 ${run.signal}）`;
    default:
      return firstLine(run.stderr);
  }
}

export interface InteractiveContext {
  toolchain: Toolchain;
  sandbox: Sandbox;
  cacheDir: string;
  /** 题目的限制：交互的墙钟时间按它算（选手的表现决定交互多久）。 */
  limits: Limits;
  /** testlib.h 所在目录，编译 interactor 时作为 -I（SPEC §6.6）。 */
  includeDir?: string;
}

export type PreparedInteractor =
  | { ok: true; runner: InteractiveRunner; note: string }
  | { ok: false; message: string };

/**
 * 编译 interactor 并准备好调用它。
 *
 * testlib 约定：interactor 从命令行收两个文件参数（输入、标准答案），
 * 与选手程序的对话走 stdin / stdout。
 */
export async function prepareInteractor(
  interactorPath: string,
  ctx: InteractiveContext,
): Promise<PreparedInteractor> {
  const compiled = await compile(ctx.toolchain, interactorPath, {
    flags: ['-O2', '-std=c++17'],
    includeDirs: ctx.includeDir === undefined ? [] : [ctx.includeDir],
    cacheDir: ctx.cacheDir,
  });
  if (!compiled.ok) {
    const first = compiled.diagnostics.find((item) => item.severity === 'error');
    return { ok: false, message: `interactor 编译失败：${first?.raw ?? '没有可用的诊断信息'}` };
  }

  const runCmd = compiled.runCmd;
  return {
    ok: true,
    note: `已编译 interactor（${path.basename(interactorPath)}）`,
    runner: {
      run: async (contestant, input, answer, limits, token) => {
        const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'verdict-itr-'));
        try {
          const inputPath = path.join(dir, 'input.txt');
          const answerPath = path.join(dir, 'answer.txt');
          await Promise.all([
            fs.promises.writeFile(inputPath, input),
            fs.promises.writeFile(answerPath, answer),
          ]);

          const connected = await ctx.sandbox.runConnected(
            contestant,
            { cmd: runCmd.cmd, args: [...runCmd.args, inputPath, answerPath] },
            limits,
            // ctx.limits 已经是放宽过的交互器限制（准备时由调用方给）。
            ctx.limits,
            token,
          );
          return {
            result: decideInteractiveVerdict(connected.primary, connected.secondary),
            run: connected.primary,
            transcript: connected.transcript,
          };
        } finally {
          await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => undefined);
        }
      },
    },
  };
}

function firstLine(buffer: Buffer): string {
  const line = buffer
    .toString('utf8')
    .split('\n')
    .map((item) => item.trim())
    .find((item) => item.length > 0);
  if (line === undefined) {
    return '';
  }
  return line.length > 200 ? `${line.slice(0, 200)}…` : line;
}
