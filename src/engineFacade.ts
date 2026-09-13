import * as path from 'node:path';
import {
  compile,
  detectAllToolchains,
  type CompileResult,
  type Toolchain,
} from './core/compiler';
import { Judge, judgeProblem, type CaseResult } from './core/judge/judge';
import { scoreProblem } from './core/judge/score';
import type {
  CancellationTokenLike,
  ComparatorConfig,
  Limits,
  Problem,
  SubtaskResult,
} from './core/model';
import { findProblemRoot, loadProblem, type ProblemPackage } from './core/problem/package';
import {
  findTestsBesideSource,
  resolveTestFiles,
  type TestDataLocation,
} from './core/problem/scan';
import { createSandbox } from './core/sandbox/sandbox';
import { readFileOrNull } from './util/files';

/**
 * UI 与 core 之间唯一的门面（SPEC §13）。
 *
 * 这一层不 import vscode：设置、缓存目录等由 UI 读好后当作参数传进来，
 * 于是整条评测链路可以在纯 Node 下跑测试。
 */

export interface EngineOptions {
  /** 对应设置 verdict.compiler；为空则自动探测。 */
  compilerPath: string;
  flags: string[];
  limits: Limits;
  comparator: ComparatorConfig;
  /** 编译产物缓存目录，由 UI 传入 globalStorageUri/cache。 */
  cacheDir: string;
  /**
   * 工作区根目录。给题目包的向上查找划一条边界，
   * 免得从工作区外面的文件一路找到用户主目录去。
   */
  workspaceRoot?: string;
}

export type JudgeOutcome =
  | { kind: 'no-tests'; sourcePath: string; message?: string }
  | { kind: 'no-compiler'; message: string }
  | { kind: 'compile-failed'; compile: CompileResult }
  | {
      kind: 'judged';
      compile: CompileResult;
      cases: CaseResult[];
      /** 子任务分数；没有题目包（或题目没配子任务）时是空数组。 */
      subtasks: SubtaskResult[];
      score: number;
      maxScore: number;
      /** 来自题目包时才有：题目 id。 */
      problemId?: string;
      dataDir: string;
      elapsedMs: number;
      cancelled: boolean;
      /** 是否在正式评测前做过预热（见 warmUp 的说明）。 */
      warmedUp: boolean;
    };

const sandbox = createSandbox();

/** 预热的时限：只需要让内核完成首次校验，程序本身通常几毫秒就结束。 */
const WARMUP_TIMEOUT_MS = 3000;

let cachedToolchain: { key: string; toolchain: Toolchain | null } | null = null;

/** 清掉编译器探测缓存（用户在设置里改了路径或新装了编译器时调用）。 */
export function clearToolchainCache(): void {
  cachedToolchain = null;
}

export async function resolveToolchain(compilerPath: string): Promise<Toolchain | null> {
  const key = compilerPath.trim();
  if (cachedToolchain !== null && cachedToolchain.key === key) {
    return cachedToolchain.toolchain;
  }
  const found = await detectAllToolchains(key.length > 0 ? { explicitPath: key } : {});
  const toolchain = found[0] ?? null;
  cachedToolchain = { key, toolchain };
  return toolchain;
}

export async function judgeSourceFile(
  sourcePath: string,
  options: EngineOptions,
  token?: CancellationTokenLike,
  onProgress?: (stage: string) => void,
): Promise<JudgeOutcome> {
  const startedAt = Date.now();
  const report = onProgress ?? ((): void => undefined);

  // 题目包优先：它自带限制、比较方式与子任务，比「旁边有什么文件就测什么」可靠。
  // problem.json 有问题时直接抛错，不退回过约定式查找——那会拿错误的分数骗人。
  report('查找题目包');
  const packageRoot = await findProblemRoot(path.dirname(sourcePath), options.workspaceRoot);
  if (packageRoot !== null) {
    const pkg = await loadProblem(packageRoot);
    return judgeWithProblem(sourcePath, pkg, options, token, report, startedAt);
  }

  report('查找测试数据');
  const location = await findTestsBesideSource(sourcePath);
  if (location === null) {
    return { kind: 'no-tests', sourcePath };
  }

  const prepared = await prepareRun(sourcePath, options, options.limits, token, report);
  if (!prepared.ok) {
    return prepared.outcome;
  }
  const compiled = prepared.compiled;

  const judge = new Judge(sandbox, {
    limits: options.limits,
    comparator: options.comparator,
  });

  const cases: CaseResult[] = [];
  let cancelled = false;
  for (const test of location.tests) {
    if (token?.isCancellationRequested === true) {
      cancelled = true;
      break;
    }

    report(`评测 ${test.id}（${cases.length + 1}/${location.tests.length}）`);
    const { inputPath, answerPath } = resolveTestFiles(location, test);
    const input = await readFileOrNull(inputPath);
    const answer = await readFileOrNull(answerPath);

    if (input === null || answer === null) {
      cases.push({
        test: test.id,
        verdict: 'UKE',
        score: 0,
        timeMs: 0,
        memoryKb: 0,
        exitCode: null,
        signal: null,
        message: `无法读取测试数据：${input === null ? inputPath : answerPath}`,
        output: Buffer.alloc(0),
        answer: answer ?? Buffer.alloc(0),
      });
      continue;
    }

    cases.push(
      await judge.judgeCase(
        {
          testId: test.id,
          input,
          answer,
          runCmd: compiled.runCmd,
          points: test.points,
        },
        token,
      ),
    );
  }

  // 约定式数据没有题目包，就捏一个「没有子任务的题目」交给同一套计分逻辑，
  // 这样「AC 1/1」和题目包评测的分数完全同源，不会出现两套算法。
  const scored = scoreProblem(
    problemFromLocation(sourcePath, location, options.limits, options.comparator),
    cases,
  );

  return {
    kind: 'judged',
    compile: compiled,
    cases,
    subtasks: scored.subtasks,
    score: scored.score,
    maxScore: scored.maxScore,
    dataDir: location.dataDir,
    elapsedMs: Date.now() - startedAt,
    cancelled,
    warmedUp: prepared.warmedUp,
  };
}

/**
 * 用指定的题目包评测一份源码。
 *
 * 「从源码位置向上找题目包」在比赛布局下是不够用的：题目包在 .verdict/problems/<id>/ 下，
 * 而选手源码在 players/ 里，两者相距很远。Testing 面板与 M3 的比赛流程都走这个入口。
 */
export async function judgeWithProblem(
  sourcePath: string,
  pkg: ProblemPackage,
  options: EngineOptions,
  token?: CancellationTokenLike,
  onProgress?: (stage: string) => void,
  startedAt: number = Date.now(),
): Promise<JudgeOutcome> {
  const report = onProgress ?? ((): void => undefined);

  if (pkg.problem.tests.length === 0) {
    return {
      kind: 'no-tests',
      sourcePath,
      message:
        `题目包「${pkg.problem.id}」还没有测试点：把 1.in / 1.out 放进 ${pkg.dataDir}，` +
        '或在 problem.json 的 tests 里登记。',
    };
  }

  const prepared = await prepareRun(sourcePath, options, pkg.problem.limits, token, report);
  if (!prepared.ok) {
    return prepared.outcome;
  }

  const result = await judgeProblem(pkg, prepared.compiled.runCmd, sandbox, token, report);
  return {
    kind: 'judged',
    compile: prepared.compiled,
    cases: result.cases,
    subtasks: result.subtasks,
    score: result.score,
    maxScore: result.maxScore,
    problemId: pkg.problem.id,
    dataDir: pkg.dataDir,
    elapsedMs: Date.now() - startedAt,
    cancelled: token?.isCancellationRequested === true,
    warmedUp: prepared.warmedUp,
  };
}

type PreparedRun =
  | { ok: true; compiled: CompileResult; warmedUp: boolean }
  | { ok: false; outcome: JudgeOutcome };

/**
 * 编译 + 预热，两条评测路径共用。
 *
 * 预热和编译绑在一起是有原因的：只有编译这一步知道产物是不是刚写出来的，
 * 而新产物在 macOS 上首次执行要多花 400-900ms（见 warmUp 的说明）。
 */
async function prepareRun(
  sourcePath: string,
  options: EngineOptions,
  limits: Limits,
  token: CancellationTokenLike | undefined,
  report: (stage: string) => void,
): Promise<PreparedRun> {
  report('探测编译器');
  const toolchain = await resolveToolchain(options.compilerPath);
  if (toolchain === null) {
    return {
      ok: false,
      outcome: {
        kind: 'no-compiler',
        message:
          '未找到可用编译器，请安装 g++ / clang++ / cl，或在设置 verdict.compiler 中指定路径。',
      },
    };
  }

  report('编译');
  const compiled = await compile(toolchain, sourcePath, {
    flags: options.flags,
    stackBytes: limits.stackMb * 1024 * 1024,
    cacheDir: options.cacheDir,
  });
  if (!compiled.ok) {
    return { ok: false, outcome: { kind: 'compile-failed', compile: compiled } };
  }

  const warmedUp = await warmUp(compiled, limits, token, report);
  return { ok: true, compiled, warmedUp };
}

/** 约定式数据（SPEC §5.8.1）没有题目包，按文件位置临时捏一个。 */
function problemFromLocation(
  sourcePath: string,
  location: TestDataLocation,
  limits: Limits,
  comparator: ComparatorConfig,
): Problem {
  const id = path.basename(sourcePath, path.extname(sourcePath));
  return {
    id,
    name: id,
    type: 'traditional',
    limits,
    comparator,
    subtasks: [],
    tests: location.tests,
  };
}

/**
 * 预热：新建的可执行文件在 macOS 上首次执行要 400-900ms（内核的代码校验），
 * 之后只要几毫秒。若不预热，一个刚编译好的正确程序在 1 秒时限下会被误判 TLE——
 * 这是「判定必须稳定可信」不能接受的。
 *
 * 因此新编译（非缓存命中）后先空跑一次，用空输入、独立时限，结果整体丢弃。
 * 代价约 0.2 秒；副作用是被测程序多跑一次，OI 程序约定为 stdin 到 stdout 的纯函数，
 * 因此可以接受。
 */
async function warmUp(
  compiled: CompileResult,
  limits: Limits,
  token: CancellationTokenLike | undefined,
  report: (stage: string) => void,
): Promise<boolean> {
  if (compiled.cached || compiled.runCmd.cmd.length === 0) {
    return false;
  }
  report('预热');
  await sandbox.run(
    compiled.runCmd,
    Buffer.alloc(0),
    { ...limits, timeMs: WARMUP_TIMEOUT_MS },
    token,
  );
  return true;
}
