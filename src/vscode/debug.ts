import * as path from 'node:path';
import * as vscode from 'vscode';
import { compile } from '../core/compiler';
import {
  buildDebugSession,
  debugFlags,
  debuggerExtensionId,
  debuggerTypeOf,
  type DebugSessionConfig,
} from '../core/debug/launch';
import { findProblemRoot, loadProblem, resolveTestPath } from '../core/problem/package';
import { findTestsBesideSource, resolveTestFiles } from '../core/problem/scan';
import { resolveToolchain } from '../engineFacade';
import { readEngineOptions } from './config';
import type { VerdictOutput } from './output';
import { workspaceRoot } from './workspace';

export interface DebugDeps {
  context: vscode.ExtensionContext;
  output: VerdictOutput;
}

/**
 * 调试请求的结果。
 *
 * 做成结构化返回值，是为了让集成测试能断言「没装调试扩展」这条路径——它恰恰是最容易出问题、
 * 也最需要给用户看得懂提示的那条。
 */
export type DebugResult =
  | {
      kind: 'started';
      testId: string;
      program: string;
      inputPath?: string;
      /** 是否成功把测试点输入接到了 stdin（MSVC 的调试器不支持自动接）。 */
      injected: boolean;
    }
  | { kind: 'no-source'; message: string }
  | { kind: 'no-tests'; message: string }
  | { kind: 'no-debugger'; extensionId: string; message: string }
  | { kind: 'compile-failed'; message: string }
  | { kind: 'failed'; message: string };

export interface DebugTarget {
  /** 指定题目包（Testing 面板点进来的）；不给就按源码位置向上找。 */
  problemRoot?: string;
  /** 指定测试点；不给就用第一个，也就是 SPEC §4.1 的「调试首测点」。 */
  testId?: string;
}

// 与评测的区别有两处，都是有意的：
//   1. 用调试版参数编译（关优化、加 -g），否则单步会跳、变量会被优化没；
//   2. 工作目录设成题目包根目录，程序读相对路径的数据文件时与出题人的预期一致
//      （评测时 cwd 继承扩展宿主，SPEC 没规定，也就不该指望它）。
/** 用某个测试点的输入起一个调试会话（SPEC §4.8）。 */
export async function startDebug(
  deps: DebugDeps,
  document: vscode.TextDocument,
  target: DebugTarget = {},
): Promise<DebugResult> {
  if (document.uri.scheme !== 'file') {
    return { kind: 'no-source', message: '请先打开一个已保存到磁盘的源码文件。' };
  }
  if (document.isDirty) {
    // 调试的也必须是磁盘上的内容，否则断点行号会和实际运行的代码对不上。
    await document.save();
  }

  const sourcePath = document.uri.fsPath;
  const engine = readEngineOptions(deps.context);

  const found = await findDebugTarget(sourcePath, target);
  if ('message' in found) {
    return found;
  }

  const toolchain = await resolveToolchain(engine.compilerPath);
  if (toolchain === null) {
    return {
      kind: 'failed',
      message:
        '未找到可用编译器，请安装 g++ / clang++ / cl，或在设置 verdict.compiler 中指定路径。',
    };
  }

  const type = debuggerTypeOf(toolchain.kind, process.platform);
  const extensionId = debuggerExtensionId(type);
  if (vscode.extensions.getExtension(extensionId) === undefined) {
    // 先把扩展挡在前面：否则 startDebugging 只会抛一句用户看不懂的 "no debug adapter"。
    const friendly = type === 'debugpy' ? 'Python' : 'C/C++';
    return {
      kind: 'no-debugger',
      extensionId,
      message:
        `没有找到调试扩展 ${extensionId}。请先在扩展面板里安装「${friendly}」` +
        '，再重新调试。',
    };
  }

  const compiled = await compile(toolchain, sourcePath, {
    flags: debugFlags(toolchain.kind, engine.flags),
    stackBytes: engine.limits.stackMb * 1024 * 1024,
    cacheDir: engine.cacheDir,
  });
  if (!compiled.ok) {
    const first = compiled.diagnostics.find((item) => item.severity === 'error');
    return {
      kind: 'compile-failed',
      message:
        first === undefined
          ? '调试版编译失败，详见问题面板。'
          : `调试版编译失败：${first.file}:${first.line}:${first.column} ${first.message}`,
    };
  }

  const config = buildDebugSession({
    sourcePath,
    program: toolchain.kind === 'python' ? undefined : compiled.exe,
    cwd: found.cwd,
    inputPath: found.inputPath,
    kind: toolchain.kind,
    platform: process.platform,
    name: `Verdict：调试 #${found.testId}`,
  });

  const program = toolchain.kind === 'python' ? sourcePath : compiled.exe;
  try {
    const folder = vscode.workspace.getWorkspaceFolder(document.uri);
    const started = await vscode.debug.startDebugging(folder, toDebugConfiguration(config));
    if (!started) {
      return {
        kind: 'failed',
        message: '调试会话没有启动起来：调试器没有接受这份配置，详见调试面板。',
      };
    }
  } catch (err) {
    return { kind: 'failed', message: `启动调试失败：${messageOf(err)}` };
  }

  const injected = config.setupCommands !== undefined;
  deps.output.info(`开始调试：测试点 #${found.testId}，程序 ${program}`);
  deps.output.info(`工作目录：${found.cwd}`);
  if (found.inputPath !== undefined) {
    deps.output.info(
      injected
        ? `输入文件：${found.inputPath}（已尝试接到 stdin）`
        : `输入文件：${found.inputPath}（这个调试器不支持自动接输入，必要时手动喂）`,
    );
  }

  return {
    kind: 'started',
    testId: found.testId,
    program,
    ...(found.inputPath === undefined ? {} : { inputPath: found.inputPath }),
    injected,
  };
}

interface DebugTargetFiles {
  testId: string;
  inputPath?: string;
  cwd: string;
}

async function findDebugTarget(
  sourcePath: string,
  target: DebugTarget,
): Promise<DebugTargetFiles | { kind: 'no-tests'; message: string }> {
  const root =
    target.problemRoot ?? (await findProblemRoot(path.dirname(sourcePath), workspaceRoot()));

  if (root !== null) {
    const pkg = await loadProblem(root);
    const test =
      target.testId === undefined
        ? pkg.problem.tests[0]
        : pkg.problem.tests.find((item) => item.id === target.testId);
    if (test === undefined) {
      return {
        kind: 'no-tests',
        message:
          target.testId === undefined
            ? `题目包「${pkg.problem.id}」里还没有测试点，先导入数据再调试。`
            : `题目包「${pkg.problem.id}」里没有测试点「${target.testId}」。`,
      };
    }
    return {
      testId: test.id,
      inputPath: resolveTestPath(pkg, test).inputPath,
      cwd: pkg.rootDir,
    };
  }

  const location = await findTestsBesideSource(sourcePath);
  if (location === null) {
    return {
      kind: 'no-tests',
      message:
        '没有找到测试数据。把 1.in / 1.out 放进题目包的 data/，' +
        '或让源文件旁边有同名的一对 .in / .out。',
    };
  }
  const test =
    target.testId === undefined
      ? location.tests[0]
      : (location.tests.find((item) => item.id === target.testId) ?? location.tests[0]);
  if (test === undefined) {
    return { kind: 'no-tests', message: '这个文件旁边没有可用的测试点。' };
  }
  return {
    testId: test.id,
    inputPath: resolveTestFiles(location, test).inputPath,
    cwd: location.dataDir,
  };
}

/** 调试配置是各调试器自定义的字段集合，只能交给调试器解释（SPEC §4.8）。 */
function toDebugConfiguration(config: DebugSessionConfig): vscode.DebugConfiguration {
  const { extra, ...rest } = config;
  return { ...rest, ...(extra ?? {}) } as vscode.DebugConfiguration;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 失败时给用户看的那句话；成功（起了调试会话）返回 null。 */
export function debugFailureText(result: DebugResult): string | null {
  return result.kind === 'started' ? null : result.message;
}
