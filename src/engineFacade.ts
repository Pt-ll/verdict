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
    };

const sandbox = createSandbox();

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
  };
}

async function readFileOrNull(target: string): Promise<Buffer | null> {
  try {
    return await fs.promises.readFile(target);
  } catch {
    return null;
  }
}
