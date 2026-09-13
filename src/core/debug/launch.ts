import type { CompilerKind } from '../compiler';

/** VS Code 的调试器类型（SPEC §4.8）。 */
export type DebuggerType = 'cppdbg' | 'cppvsdbg' | 'debugpy';

export interface DebugSetupCommand {
  description: string;
  text: string;
  ignoreFailures: boolean;
}

export interface DebugSessionConfig {
  type: DebuggerType;
  request: 'launch';
  name: string;
  program: string;
  args: string[];
  cwd: string;
  externalConsole: boolean;
  console: 'internalConsole' | 'integratedTerminal';
  MIMode?: 'gdb' | 'lldb';
  setupCommands?: DebugSetupCommand[];
  /** 调试器特有的额外字段（例如 debugpy 的 justMyCode）。 */
  extra?: Record<string, unknown>;
}

export interface DebugLaunchInput {
  /** 源码绝对路径（Python 直接跑它）。 */
  sourcePath: string;
  /** 编译出来的可执行文件；解释型语言不用。 */
  program?: string;
  /** 工作目录，一般给题目包根目录。 */
  cwd: string;
  /** 测试点输入文件；给了就尝试把它接到被测程序的 stdin 上。 */
  inputPath?: string;
  kind: CompilerKind;
  platform: NodeJS.Platform;
  /** 调试会话显示名，例如 "Verdict：调试 #1"。 */
  name: string;
}

export function debuggerTypeOf(
  kind: CompilerKind,
  platform: NodeJS.Platform = process.platform,
): DebuggerType {
  if (kind === 'python') {
    return 'debugpy';
  }
  // Windows 上 cl 用 MSVC 自己的调试器，MinGW 的 g++ 仍走 cppdbg。
  return kind === 'cl' && platform === 'win32' ? 'cppvsdbg' : 'cppdbg';
}

export function debuggerExtensionId(type: DebuggerType): string {
  return type === 'debugpy' ? 'ms-python.debugpy' : 'ms-vscode.cpptools';
}

/**
 * 生成一份临时调试配置（SPEC §4.8）。
 *
 * 关于 stdin：cppdbg / debugpy 都没有「把某个文件接到 stdin」的配置字段，
 * 只能借调试器自己的命令来做（见 stdinCommand）。
 * 这里拼的是**调试器命令文本**，不是 shell 字符串——AGENTS 三平台约定第 3 条禁止的是拼 shell，
 * 因为那才会带来注入与转义问题；调试器命令只在调试器进程里解释。
 */
export function buildDebugSession(input: DebugLaunchInput): DebugSessionConfig {
  if (input.kind === 'python') {
    return {
      type: 'debugpy',
      request: 'launch',
      name: input.name,
      program: input.sourcePath,
      args: [],
      cwd: input.cwd,
      externalConsole: false,
      console: 'integratedTerminal',
      // 竞赛代码没有「库代码」的概念，跳过 justMyCode 免得单步时被拦在库里。
      extra: { justMyCode: false },
    };
  }

  const msvc = debuggerTypeOf(input.kind, input.platform) === 'cppvsdbg';
  const miMode: 'gdb' | 'lldb' = input.platform === 'darwin' ? 'lldb' : 'gdb';
  // MSVC 的调试器没有对应的注入命令，只能靠人工输入——上层会把输入文件路径告诉用户。
  const setup =
    msvc || input.inputPath === undefined
      ? undefined
      : [stdinCommand(miMode, input.inputPath)];

  return {
    type: msvc ? 'cppvsdbg' : 'cppdbg',
    request: 'launch',
    name: input.name,
    program: input.program ?? '',
    args: [],
    cwd: input.cwd,
    // 用内部调试控制台：stdin 已经指向文件，不需要终端再抢输入；
    // 万一注入没生效，在调试控制台里也能手动输入。
    externalConsole: false,
    console: 'internalConsole',
    ...(msvc ? {} : { MIMode: miMode }),
    ...(setup === undefined ? {} : { setupCommands: setup }),
  };
}

function stdinCommand(miMode: 'gdb' | 'lldb', inputPath: string): DebugSetupCommand {
  const quoted = `"${inputPath.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  return {
    description: '把测试点输入接到 stdin（SPEC §4.8）',
    text:
      miMode === 'lldb'
        ? `settings set target.input-path ${quoted}`
        : `set inferior-tty ${quoted}`,
    // 两个调试器对这套命令的支持程度随版本而变：注入失败不该让整个会话起不来，
    // 上层会把输入文件路径一并告诉用户，实在不行手动喂。
    ignoreFailures: true,
  };
}

const GCC_OPTIMIZATION = /^-O/;
const MSVC_OPTIMIZATION = /^\/O/i;

/**
 * 调试版编译参数：去掉优化、加上调试信息。
 *
 * 优化过的代码单步会跳来跳去、变量常被优化没，所以调试必须关优化；
 * 其余参数（-std、-DONLINE_JUDGE、-I）原样保留，否则调试的就不是评测的那个程序了。
 */
export function debugFlags(kind: CompilerKind, flags: string[]): string[] {
  if (kind === 'cl') {
    return [...flags.filter((flag) => !MSVC_OPTIMIZATION.test(flag)), '/Zi', '/Od', '/DEBUG'];
  }
  return [...flags.filter((flag) => !GCC_OPTIMIZATION.test(flag)), '-g', '-O0'];
}
