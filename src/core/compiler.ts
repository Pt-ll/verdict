import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  DEFAULT_PROCESS_TIMEOUT_MS,
  describeError,
  runProcess,
} from '../util/process';
import { which } from '../util/which';

/**
 * 编译器探测（M1 的一部分）。
 *
 * Core 层约定：不 import `vscode`，只依赖 Node 内置模块，
 * 这样既能在扩展宿主里跑，也能在单元测试里直接跑。
 */

export type CompilerKind = 'g++' | 'clang++' | 'cl' | 'python' | 'custom';

export interface Toolchain {
  /** 编译器家族。macOS 上 `g++` 实际是 clang 的别名，会被识别为 `clang++`。 */
  kind: CompilerKind;
  /** 实际调用时使用的命令（PATH 中的名字或绝对路径）。 */
  command: string;
  /** `which` 解析出的绝对路径，未解析到时为 null。 */
  path: string | null;
  /** 版本横幅首行。 */
  version: string;
}

export interface DetectOptions {
  /** 用户显式指定的可执行文件路径（对应设置项 `verdict.compiler`）。 */
  explicitPath?: string;
  /** 探测超时（毫秒）。 */
  timeoutMs?: number;
}

export interface ProbeResult {
  ok: boolean;
  version: string;
  error?: string;
}

interface Candidate {
  kind: CompilerKind;
  command: string;
  args: string[];
  /** 判定成功的版本行匹配；缺省表示「退出码为 0」即成功。 */
  match?: RegExp;
}

const CANDIDATES: Candidate[] = [
  { kind: 'g++', command: 'g++', args: ['--version'] },
  { kind: 'clang++', command: 'clang++', args: ['--version'] },
  // MSVC 的 cl 不认 --version，直接运行会打印版本横幅，且退出码非 0。
  { kind: 'cl', command: 'cl', args: [], match: /Microsoft|Version/i },
];

/** 依次探测所有候选编译器，返回全部探测成功的结果。 */
export async function detectAllToolchains(
  opts: DetectOptions = {},
): Promise<Toolchain[]> {
  const found: Toolchain[] = [];
  const seen = new Set<string>();

  const explicit = opts.explicitPath?.trim();
  if (explicit) {
    const toolchain = await probeToolchain(explicit, 'custom', opts);
    if (toolchain) {
      found.push(toolchain);
      seen.add(toolchain.path ?? toolchain.command);
    }
  }

  for (const candidate of CANDIDATES) {
    const toolchain = await probeToolchain(
      candidate.command,
      candidate.kind,
      opts,
      candidate,
    );
    if (!toolchain) {
      continue;
    }
    const key = toolchain.path ?? toolchain.command;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    found.push(toolchain);
  }

  return found;
}

/** 探测首个可用的编译器；一个都没有时返回 null。 */
export async function detectToolchain(
  opts: DetectOptions = {},
): Promise<Toolchain | null> {
  const all = await detectAllToolchains(opts);
  return all[0] ?? null;
}

/** 运行一次 `<command> --version` 之类的探测，捕获输出而不抛异常。 */
export async function probeCompiler(
  command: string,
  args: string[] = ['--version'],
  timeoutMs: number = DEFAULT_PROCESS_TIMEOUT_MS,
): Promise<ProbeResult> {
  const result = await runProcess(command, args, timeoutMs);
  const firstLine =
    `${result.stdout}\n${result.stderr}`
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? '';

  if (result.error && result.code === null) {
    return { ok: false, version: '', error: result.error };
  }
  return {
    ok: result.code === 0,
    version: firstLine,
    error: result.code === 0 ? undefined : `退出码 ${result.code}`,
  };
}

async function probeToolchain(
  command: string,
  fallbackKind: CompilerKind,
  opts: DetectOptions,
  candidate?: Candidate,
): Promise<Toolchain | null> {
  const args = candidate?.args ?? ['--version'];
  const probed = await probeCompiler(command, args, opts.timeoutMs);

  const succeeded = candidate?.match
    ? candidate.match.test(probed.version) || probed.ok
    : probed.ok;
  if (!succeeded) {
    return null;
  }

  const resolved = which(command);
  const kind = inferKind(command, probed.version, fallbackKind);
  return {
    kind,
    command: resolved ?? command,
    path: resolved,
    version: probed.version,
  };
}

/**
 * 由命令名与版本横幅推断真实编译器家族。
 *
 * 典型场景：macOS 的 `/usr/bin/g++` 是 clang 的软链，版本行写着
 * "Apple clang version 21.0.0"，此时按 clang++ 处理才符合实际行为。
 */
function inferKind(
  command: string,
  version: string,
  fallback: CompilerKind,
): CompilerKind {
  if (/python/i.test(version)) {
    return 'python';
  }
  if (/clang/i.test(version)) {
    return 'clang++';
  }
  if (/microsoft|msvc/i.test(version)) {
    return 'cl';
  }
  if (/gcc|gnu c\+\+/i.test(version)) {
    return 'g++';
  }

  const base = path.basename(command).toLowerCase().replace(/\.exe$/, '');
  if (base.startsWith('g++') || base.startsWith('gcc')) {
    return 'g++';
  }
  if (base.startsWith('clang')) {
    return 'clang++';
  }
  if (base === 'cl') {
    return 'cl';
  }
  if (base.startsWith('python')) {
    return 'python';
  }
  return fallback;
}

// ---------------------------------------------------------------------------
// 编译（M1）
// ---------------------------------------------------------------------------

/** 默认编译参数，见 SPEC §5.2。 */
export const DEFAULT_FLAGS = ['-O2', '-std=c++17', '-static', '-DONLINE_JUDGE'];

const COMPILE_TIMEOUT_MS = 60_000;
const MAX_DIAGNOSTICS = 200;

export type DiagnosticSeverity = 'error' | 'warning' | 'note';

export interface CompileDiagnostic {
  file: string;
  line: number;
  column: number;
  severity: DiagnosticSeverity;
  message: string;
  /** 编译器原始输出行，便于用户核对。 */
  raw: string;
}

export interface CompileOptions {
  /** 编译参数；缺省用 DEFAULT_FLAGS。 */
  flags?: string[];
  /** 栈大小；MinGW 映射为 -Wl,--stack,<bytes>，MSVC 映射为 /STACK:<bytes>。 */
  stackBytes?: number;
  defines?: Record<string, string>;
  /** 附加头文件目录；SPJ / interactor 注入 testlib.h 所在目录（SPEC §6.6）。 */
  includeDirs?: string[];
  /** 产物缓存目录，由 UI 层传入 globalStorageUri/cache；缺省用系统临时目录。 */
  cacheDir?: string;
  timeoutMs?: number;
}

export interface CompileResult {
  ok: boolean;
  /** 缓存目录中的可执行文件路径；解释型语言为空串。 */
  exe: string;
  runCmd: { cmd: string; args: string[] };
  diagnostics: CompileDiagnostic[];
  compilerVersion: string;
  /** 是否命中缓存（未真正调用编译器）。 */
  cached: boolean;
}

/**
 * 编译一份源码。
 *
 * 约定（SPEC §5.2）：
 * - 编译失败不抛异常，而是返回 `ok: false` + 结构化诊断；
 * - 缓存键 = sha256(源码) + 编译参数 + 编译器版本 + 栈设置；
 * - `-static` 只在 MinGW 下保留，其他平台自动去掉（clang 的 `-static` 反而会报错）。
 */
export async function compile(
  toolchain: Toolchain,
  srcPath: string,
  opts: CompileOptions = {},
): Promise<CompileResult> {
  const sourcePath = path.resolve(srcPath);

  // 解释型语言没有编译阶段，直接给出运行命令。
  if (toolchain.kind === 'python') {
    return {
      ok: true,
      exe: '',
      runCmd: { cmd: toolchain.path ?? toolchain.command, args: [sourcePath] },
      diagnostics: [],
      compilerVersion: toolchain.version,
      cached: false,
    };
  }

  let sourceBytes: Buffer;
  try {
    sourceBytes = await fs.promises.readFile(sourcePath);
  } catch (err) {
    return failed(toolchain, [
      syntheticDiagnostic(sourcePath, `无法读取源文件：${describeError(err)}`),
    ]);
  }

  const flags = opts.flags ?? DEFAULT_FLAGS;
  const cacheKey = hashCacheKey(toolchain, sourceBytes, flags, opts);
  const cacheDir = path.resolve(
    opts.cacheDir ?? path.join(os.tmpdir(), 'verdict-cache'),
  );
  const exeName = `${path.basename(sourcePath, path.extname(sourcePath))}-${cacheKey.slice(0, 16)}${exeSuffix()}`;
  const exePath = path.join(cacheDir, exeName);

  if (await isFile(exePath)) {
    return {
      ok: true,
      exe: exePath,
      runCmd: { cmd: exePath, args: [] },
      diagnostics: [],
      compilerVersion: toolchain.version,
      cached: true,
    };
  }

  try {
    await fs.promises.mkdir(cacheDir, { recursive: true });
  } catch (err) {
    return failed(toolchain, [
      syntheticDiagnostic(
        sourcePath,
        `无法创建缓存目录 ${cacheDir}：${describeError(err)}`,
      ),
    ]);
  }

  const args = buildCompileArgs(toolchain, sourcePath, exePath, opts);
  const proc = await runProcess(toolchain.command, args, opts.timeoutMs ?? COMPILE_TIMEOUT_MS);
  const diagnostics = parseCompileOutput(proc.stdout, proc.stderr);

  if (proc.timedOut) {
    return failed(toolchain, [
      syntheticDiagnostic(sourcePath, proc.error ?? '编译超时'),
    ]);
  }
  if (proc.code === null) {
    return failed(toolchain, [
      syntheticDiagnostic(
        sourcePath,
        proc.error ?? `无法启动编译器 ${toolchain.command}`,
      ),
    ]);
  }

  const ok = proc.code === 0 && (await isFile(exePath));
  if (!ok && diagnostics.length === 0) {
    diagnostics.push(
      syntheticDiagnostic(
        sourcePath,
        `编译失败（退出码 ${proc.code}），但未能解析出具体错误。`,
      ),
    );
  }

  return {
    ok,
    exe: ok ? exePath : '',
    runCmd: ok ? { cmd: exePath, args: [] } : { cmd: '', args: [] },
    diagnostics,
    compilerVersion: toolchain.version,
    cached: false,
  };
}

/**
 * 组装编译器命令行。
 *
 * `platform` 参数只为可测试性存在，默认取本机平台。
 */
export function buildCompileArgs(
  toolchain: Toolchain,
  srcPath: string,
  exePath: string,
  opts: CompileOptions = {},
  platform: NodeJS.Platform = process.platform,
): string[] {
  const isMsvc = toolchain.kind === 'cl';
  const keepStatic = platform === 'win32' && !isMsvc;
  const args: string[] = [];

  for (const flag of opts.flags ?? DEFAULT_FLAGS) {
    if (flag === '-static' && !keepStatic) {
      continue;
    }
    const translated = isMsvc ? translateFlagForMsvc(flag) : flag;
    if (translated.length > 0) {
      args.push(translated);
    }
  }

  for (const [name, value] of Object.entries(opts.defines ?? {})) {
    args.push(isMsvc ? `/D${name}=${value}` : `-D${name}=${value}`);
  }

  for (const dir of opts.includeDirs ?? []) {
    args.push(isMsvc ? `/I${dir}` : `-I${dir}`);
  }

  if (opts.stackBytes !== undefined) {
    args.push(
      isMsvc ? `/STACK:${opts.stackBytes}` : `-Wl,--stack,${opts.stackBytes}`,
    );
  }

  if (isMsvc) {
    args.push(`/Fe:${exePath}`, srcPath);
  } else {
    args.push('-o', exePath, srcPath);
  }
  return args;
}

/**
 * 解析 g++ / clang++ / MSVC 的诊断输出。
 *
 * 只认识「文件:行:列: 级别: 信息」这类结构化行；源码片段（gcc 的 `12 |` 与 `^` 提示行）
 * 会被忽略，因为它们没有文件位置，报进问题面板反而干扰。
 */
export function parseCompileOutput(stdout: string, stderr: string): CompileDiagnostic[] {
  const seen = new Set<string>();
  const diagnostics: CompileDiagnostic[] = [];

  for (const rawLine of `${stdout}\n${stderr}`.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || seen.has(line)) {
      continue;
    }

    const parsed = parseDiagnosticLine(line);
    if (!parsed) {
      continue;
    }
    seen.add(line);
    diagnostics.push(parsed);
    if (diagnostics.length >= MAX_DIAGNOSTICS) {
      break;
    }
  }

  return diagnostics.sort(
    (a, b) =>
      a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column,
  );
}

const GCC_DIAGNOSTIC = /^(.*?):(\d+):(\d+):\s*(fatal error|error|warning|note):\s*(.*)$/;
const GCC_DIAGNOSTIC_NO_COLUMN = /^(.*?):(\d+):\s*(fatal error|error|warning|note):\s*(.*)$/;
const MSVC_DIAGNOSTIC = /^(.*?)\((\d+)(?:,(\d+))?\)\s*:\s*(fatal error|error|warning)\s*([A-Za-z]+\d+)?\s*:\s*(.*)$/;

function parseDiagnosticLine(line: string): CompileDiagnostic | null {
  const gcc = GCC_DIAGNOSTIC.exec(line);
  if (gcc) {
    return {
      file: gcc[1],
      line: Number(gcc[2]),
      column: Number(gcc[3]),
      severity: toSeverity(gcc[4]),
      message: gcc[5].trim(),
      raw: line,
    };
  }

  const gccNoColumn = GCC_DIAGNOSTIC_NO_COLUMN.exec(line);
  if (gccNoColumn) {
    return {
      file: gccNoColumn[1],
      line: Number(gccNoColumn[2]),
      column: 1,
      severity: toSeverity(gccNoColumn[3]),
      message: gccNoColumn[4].trim(),
      raw: line,
    };
  }

  const msvc = MSVC_DIAGNOSTIC.exec(line);
  if (msvc) {
    const code = msvc[5] ? `${msvc[5]}: ` : '';
    return {
      file: msvc[1],
      line: Number(msvc[2]),
      column: msvc[3] ? Number(msvc[3]) : 1,
      severity: toSeverity(msvc[4]),
      message: `${code}${msvc[6].trim()}`,
      raw: line,
    };
  }

  return null;
}

function toSeverity(text: string): DiagnosticSeverity {
  if (text === 'warning') {
    return 'warning';
  }
  if (text === 'note') {
    return 'note';
  }
  return 'error';
}

function hashCacheKey(
  toolchain: Toolchain,
  sourceBytes: Buffer,
  flags: string[],
  opts: CompileOptions,
): string {
  const parts = [
    toolchain.kind,
    toolchain.version,
    ...flags,
    opts.stackBytes === undefined ? '' : `stack=${opts.stackBytes}`,
    ...Object.entries(opts.defines ?? {})
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, value]) => `D${name}=${value}`),
    ...(opts.includeDirs ?? []).map((dir) => `I${path.resolve(dir)}`),
  ];
  return createHash('sha256')
    .update(sourceBytes)
    .update('\0')
    .update(parts.join('\0'))
    .digest('hex');
}

/** MSVC 的参数拼写与 GCC 不同，这里做最小映射；其余原样透传。 */
function translateFlagForMsvc(flag: string): string {
  if (flag.startsWith('-D')) {
    return `/${flag.slice(1)}`;
  }
  if (/^-O\d?$/.test(flag)) {
    return `/${flag.slice(1)}`;
  }
  if (flag.startsWith('-std=')) {
    return `/std:${flag.slice('-std='.length)}`;
  }
  return flag;
}

function exeSuffix(): string {
  return process.platform === 'win32' ? '.exe' : '';
}

async function isFile(target: string): Promise<boolean> {
  try {
    return (await fs.promises.stat(target)).isFile();
  } catch {
    return false;
  }
}

function syntheticDiagnostic(file: string, message: string): CompileDiagnostic {
  return { file, line: 1, column: 1, severity: 'error', message, raw: message };
}

function failed(toolchain: Toolchain, diagnostics: CompileDiagnostic[]): CompileResult {
  return {
    ok: false,
    exe: '',
    runCmd: { cmd: '', args: [] },
    diagnostics,
    compilerVersion: toolchain.version,
    cached: false,
  };
}
