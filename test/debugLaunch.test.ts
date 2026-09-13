import { describe, expect, it } from 'vitest';
import {
  buildDebugSession,
  debugFlags,
  debuggerExtensionId,
  debuggerTypeOf,
  type DebugLaunchInput,
} from '../src/core/debug/launch';

const BASE: DebugLaunchInput = {
  sourcePath: '/w/A/solve.cpp',
  program: '/cache/solve-dbg',
  cwd: '/w/A',
  inputPath: '/w/A/data/1.in',
  kind: 'clang++',
  platform: 'darwin',
  name: 'Verdict：调试 #1',
};

describe('debuggerTypeOf', () => {
  it('Python 用 debugpy、MSVC 用 cppvsdbg、其余用 cppdbg', () => {
    expect(debuggerTypeOf('python', 'darwin')).toBe('debugpy');
    expect(debuggerTypeOf('cl', 'win32')).toBe('cppvsdbg');
    // MinGW 的 g++ 在 Windows 上仍然走 cppdbg（它是 gdb，不是 MSVC 调试器）。
    expect(debuggerTypeOf('g++', 'win32')).toBe('cppdbg');
    expect(debuggerTypeOf('g++', 'linux')).toBe('cppdbg');
    expect(debuggerTypeOf('clang++', 'darwin')).toBe('cppdbg');
  });

  it('扩展 id 与调试器类型对应', () => {
    expect(debuggerExtensionId('cppdbg')).toBe('ms-vscode.cpptools');
    expect(debuggerExtensionId('cppvsdbg')).toBe('ms-vscode.cpptools');
    expect(debuggerExtensionId('debugpy')).toBe('ms-python.debugpy');
  });
});

describe('buildDebugSession', () => {
  it('macOS 用 lldb 的输入重定向命令，且失败不影响会话启动', () => {
    const config = buildDebugSession(BASE);

    expect(config.type).toBe('cppdbg');
    expect(config.MIMode).toBe('lldb');
    expect(config.program).toBe('/cache/solve-dbg');
    expect(config.cwd).toBe('/w/A');
    expect(config.setupCommands?.[0]?.text).toBe(
      'settings set target.input-path "/w/A/data/1.in"',
    );
    expect(config.setupCommands?.[0]?.ignoreFailures).toBe(true);
    // stdin 已经指向文件，不需要外部终端再来抢输入。
    expect(config.externalConsole).toBe(false);
  });

  it('Linux 与 Windows-MinGW 用 gdb 的写法', () => {
    const linux = buildDebugSession({ ...BASE, platform: 'linux' });
    expect(linux.MIMode).toBe('gdb');
    expect(linux.setupCommands?.[0]?.text).toBe('set inferior-tty "/w/A/data/1.in"');
    expect(buildDebugSession({ ...BASE, platform: 'win32' }).MIMode).toBe('gdb');
  });

  it('没有测试点输入时不注入', () => {
    expect(buildDebugSession({ ...BASE, inputPath: undefined }).setupCommands).toBeUndefined();
  });

  it('MSVC 用 cppvsdbg，且不带 MIMode 与注入命令（它没有对应能力）', () => {
    const config = buildDebugSession({
      ...BASE,
      kind: 'cl',
      platform: 'win32',
      program: 'C:\\cache\\solve.exe',
    });

    expect(config.type).toBe('cppvsdbg');
    expect(config.MIMode).toBeUndefined();
    expect(config.setupCommands).toBeUndefined();
  });

  it('Python 走 debugpy，直接跑源码', () => {
    const config = buildDebugSession({
      ...BASE,
      kind: 'python',
      sourcePath: '/w/A/solve.py',
      program: undefined,
    });

    expect(config.type).toBe('debugpy');
    expect(config.program).toBe('/w/A/solve.py');
    expect(config.extra).toEqual({ justMyCode: false });
  });

  it('Windows 路径的反斜杠按调试器命令语法转义', () => {
    const config = buildDebugSession({
      ...BASE,
      platform: 'win32',
      inputPath: 'C:\\w\\A\\data\\1.in',
    });

    expect(config.setupCommands?.[0]?.text).toBe(
      'set inferior-tty "C:\\\\w\\\\A\\\\data\\\\1.in"',
    );
  });
});

describe('debugFlags', () => {
  it('去掉优化、加上调试信息，其余参数原样保留', () => {
    expect(debugFlags('g++', ['-O2', '-std=c++17', '-DONLINE_JUDGE'])).toEqual([
      '-std=c++17',
      '-DONLINE_JUDGE',
      '-g',
      '-O0',
    ]);
    expect(debugFlags('clang++', ['-O3', '-std=c++17'])).toEqual(['-std=c++17', '-g', '-O0']);
  });

  it('MSVC 用 /Zi /Od /DEBUG', () => {
    expect(debugFlags('cl', ['/O2', '/std:c++17'])).toEqual([
      '/std:c++17',
      '/Zi',
      '/Od',
      '/DEBUG',
    ]);
  });
});
