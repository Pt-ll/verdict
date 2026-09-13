import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { compile, type Toolchain } from '../compiler';
import type { Limits } from '../model';
import type { RunCommand, RunResult, Sandbox } from '../sandbox/sandbox';
import type { CompareResult, ComparatorInput } from './compare';

/**
 * testlib checker 的退出码协议（SPEC §5.4）。
 *
 * 0 → AC；1 → WA；2 → PE（本版按 WA 计，但说明里保留 PE 字样，不然用户不知道自己错在哪）；
 * 3 → UKE（checker 自己失败了，不是选手的错）；7 → PC，分数由 stdout 给出。
 */
export function interpretCheckerExit(
  exitCode: number | null,
  stdout: string,
  stderr: string,
  /** 报错/说明里怎么称呼这个程序：checker 还是交互器。 */
  label = 'checker',
): CompareResult {
  const note = firstLine(stderr) || firstLine(stdout);
  switch (exitCode) {
    case 0:
      return {
        verdict: 'AC',
        scoreRatio: 1,
        detail: note.length > 0 ? note : `${label} 判定通过`,
      };
    case 1:
      return {
        verdict: 'WA',
        scoreRatio: 0,
        detail: note.length > 0 ? note : `${label} 判定错误`,
      };
    case 2:
      return {
        verdict: 'WA',
        scoreRatio: 0,
        detail: `PE（格式错误，本版按 WA 计）${note.length > 0 ? `：${note}` : ''}`,
      };
    case 3:
      return {
        verdict: 'UKE',
        scoreRatio: 0,
        detail: `${label} 自身失败${note.length > 0 ? `：${note}` : ''}`,
      };
    case 7: {
      // 分数一般在 stdout；但交互题的 stdout 是对话通道，分数只能写在 stderr，
      // 所以两个都认——哪边有数字就用哪边。
      const points = hasNumber(stdout) ? parsePoints(stdout) : parsePoints(stderr);
      return {
        verdict: 'PC',
        scoreRatio: points.ratio,
        detail: `${points.detail}${note.length > 0 ? `：${note}` : ''}`,
      };
    }
    default:
      return {
        verdict: 'UKE',
        scoreRatio: 0,
        detail: `checker 退出码 ${String(exitCode)} 不认识${note.length > 0 ? `：${note}` : ''}`,
      };
  }
}

/** 退出码 7 时 checker 会在 stdout 上给一个 0..100 的分数（可能带说明）。 */
export function parsePoints(stdout: string): { ratio: number; detail: string } {
  const match = /^\s*(-?\d+(?:\.\d+)?)/.exec(stdout);
  if (match === null) {
    // 说是部分分却没给分：按 0 分算并把这件事说出来，而不是猜一个分数。
    return { ratio: 0, detail: 'checker 退出码 7 但没有在 stdout 给出分数' };
  }
  const value = Number(match[1]);
  const clamped = Math.min(100, Math.max(0, value));
  return { ratio: clamped / 100, detail: `checker 给了 ${String(clamped)}/100 分` };
}

/**
 * 把一次 checker 运行翻译成判定。
 *
 * 注意顺序：先看「是不是被限额杀掉」，再看退出码。因为退出码 1/2/7 都会让 sandbox
 * 报成 RE（非零退出），而它们恰恰是 checker 的正常表达方式。
 */
export function interpretCheckerRun(run: RunResult): CompareResult {
  if (run.status !== 'OK' && run.status !== 'RE') {
    return {
      verdict: 'UKE',
      scoreRatio: 0,
      detail: `checker 没能正常结束（${run.status}）：${firstLine(run.stderr.toString('utf8'))}`,
    };
  }
  return interpretCheckerExit(
    run.exitCode,
    run.stdout.toString('utf8'),
    run.stderr.toString('utf8'),
  );
}

export interface CheckerContext {
  toolchain: Toolchain;
  sandbox: Sandbox;
  /** checker 的运行限制：它是评测方，给得比选手宽松些（用的是题目的限制 × 系数）。 */
  limits: Limits;
  cacheDir: string;
  /** testlib.h 所在目录，编译时作为 -I（SPEC §6.6）。 */
  includeDir?: string;
}

export type PreparedChecker =
  | { ok: true; compare: (input: ComparatorInput) => Promise<CompareResult>; note: string }
  | { ok: false; message: string };

/**
 * 编译 checker 并准备好调用它。
 *
 * 编译失败**不是** CE：CE 是选手程序的问题，checker 编译不过是出题人的问题，
 * 该记在测试点上为 UKE（SPEC §6.6），不能算到选手头上。
 */
export async function prepareChecker(
  checkerPath: string,
  ctx: CheckerContext,
): Promise<PreparedChecker> {
  const compiled = await compile(ctx.toolchain, checkerPath, {
    flags: ['-O2', '-std=c++17'],
    includeDirs: ctx.includeDir === undefined ? [] : [ctx.includeDir],
    cacheDir: ctx.cacheDir,
  });
  if (!compiled.ok) {
    const first = compiled.diagnostics.find((item) => item.severity === 'error');
    return { ok: false, message: `checker 编译失败：${first?.raw ?? '没有可用的诊断信息'}` };
  }

  const runCmd = compiled.runCmd;
  return {
    ok: true,
    note: `已编译 checker（${path.basename(checkerPath)}）`,
    compare: (input) => runChecker(runCmd, input, ctx),
  };
}

/**
 * testlib 约定：checker 从**文件**读入 three 个参数——输入、选手输出、标准答案。
 *
 * 所以这里要把三个 Buffer 落到临时文件再调用；沙箱只按 stdin/stdout 跑命令，
 * 而 checker 要的是文件名，这个转换躲不掉。
 */
async function runChecker(
  runCmd: RunCommand,
  input: ComparatorInput,
  ctx: CheckerContext,
): Promise<CompareResult> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'verdict-spj-'));
  try {
    const inputPath = path.join(dir, 'input.txt');
    const outputPath = path.join(dir, 'output.txt');
    const answerPath = path.join(dir, 'answer.txt');
    await Promise.all([
      fs.promises.writeFile(inputPath, input.input),
      fs.promises.writeFile(outputPath, input.output),
      fs.promises.writeFile(answerPath, input.answer),
    ]);

    const run = await ctx.sandbox.run(
      { cmd: runCmd.cmd, args: [...runCmd.args, inputPath, outputPath, answerPath] },
      Buffer.alloc(0),
      ctx.limits,
    );
    return interpretCheckerRun(run);
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

function firstLine(text: string): string {
  const line = text
    .split('\n')
    .map((item) => item.trim())
    .find((item) => item.length > 0);
  if (line === undefined) {
    return '';
  }
  return line.length > 200 ? `${line.slice(0, 200)}…` : line;
}

function hasNumber(text: string): boolean {
  return /\d/.test(text);
}
