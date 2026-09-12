import * as fs from 'node:fs';
import {
  compile,
  detectAllToolchains,
  type CompileResult,
  type Toolchain,
} from './core/compiler';
import { Judge, type CaseResult } from './core/judge/judge';
import type {
  CancellationTokenLike,
  ComparatorConfig,
  Limits,
} from './core/model';
import {
  findTestsBesideSource,
  resolveTestFiles,
} from './core/problem/scan';
import { createSandbox } from './core/sandbox/sandbox';

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
}

export type JudgeOutcome =
  | { kind: 'no-tests'; sourcePath: string }
  | { kind: 'no-compiler'; message: string }
  | { kind: 'compile-failed'; compile: CompileResult }
  | {
      kind: 'judged';
      compile: CompileResult;
      cases: CaseResult[];
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

  report('查找测试数据');
  const location = await findTestsBesideSource(sourcePath);
  if (location === null) {
    return { kind: 'no-tests', sourcePath };
  }

  report('探测编译器');
  const toolchain = await resolveToolchain(options.compilerPath);
  if (toolchain === null) {
    return {
      kind: 'no-compiler',
      message: '未找到可用编译器，请安装 g++ / clang++ / cl，或在设置 verdict.compiler 中指定路径。',
    };
  }

  report('编译');
  const compiled = await compile(toolchain, sourcePath, {
    flags: options.flags,
    stackBytes: options.limits.stackMb * 1024 * 1024,
    cacheDir: options.cacheDir,
  });
  if (!compiled.ok) {
    return { kind: 'compile-failed', compile: compiled };
  }

  const judge = new Judge(sandbox, {
    limits: options.limits,
    comparator: options.comparator,
  });

  const warmedUp = await warmUp(compiled, options, token, report);

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

  return {
    kind: 'judged',
    compile: compiled,
    cases,
    dataDir: location.dataDir,
    elapsedMs: Date.now() - startedAt,
    cancelled,
    warmedUp,
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
  options: EngineOptions,
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
    { ...options.limits, timeMs: WARMUP_TIMEOUT_MS },
    token,
  );
  return true;
}

async function readFileOrNull(target: string): Promise<Buffer | null> {
  try {
    return await fs.promises.readFile(target);
  } catch {
    return null;
  }
}
