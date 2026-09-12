import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  buildCompileArgs,
  compile,
  detectToolchain,
  parseCompileOutput,
  type CompilerKind,
  type Toolchain,
} from '../src/core/compiler';
import { runProcess } from '../src/util/process';

function fakeToolchain(kind: CompilerKind): Toolchain {
  return { kind, command: kind, path: null, version: 'test-version' };
}

describe('parseCompileOutput', () => {
  it('解析 g++/clang++ 带列号的错误', () => {
    const diags = parseCompileOutput('', "main.cpp:3:9: error: 'x' was not declared in this scope");
    expect(diags).toHaveLength(1);
    expect(diags[0]).toMatchObject({
      file: 'main.cpp',
      line: 3,
      column: 9,
      severity: 'error',
      message: "'x' was not declared in this scope",
    });
  });

  it('解析不带列号的错误（模板实例化常见形式）', () => {
    const diags = parseCompileOutput('', "main.cpp:12: error: no matching function for call to 'f(int)'");
    expect(diags).toHaveLength(1);
    expect(diags[0]).toMatchObject({ file: 'main.cpp', line: 12, column: 1, severity: 'error' });
  });

  it('fatal error 归为 error', () => {
    const diags = parseCompileOutput('', "a.cpp:1:10: fatal error: 'vector' file not found");
    expect(diags[0].severity).toBe('error');
    expect(diags[0].column).toBe(10);
  });

  it('区分 warning 与 note', () => {
    const diags = parseCompileOutput(
      '',
      [
        "a.cpp:2:1: warning: unused variable 'y' [-Wunused-variable]",
        'a.cpp:5:3: note: candidate function not viable',
      ].join('\n'),
    );
    expect(diags.map((d) => d.severity)).toEqual(['warning', 'note']);
  });

  it('忽略源码片段与插入符提示行', () => {
    const diags = parseCompileOutput(
      '',
      [
        "main.cpp:3:9: error: 'x' was not declared in this scope",
        '    3 |   return x;',
        '      |          ^',
        '      |',
      ].join('\n'),
    );
    expect(diags).toHaveLength(1);
  });

  it('解析 MSVC 的 file(line,col) 形式', () => {
    const diags = parseCompileOutput('', "main.cpp(7,3): error C2065: 'x': undeclared identifier");
    expect(diags).toHaveLength(1);
    expect(diags[0]).toMatchObject({ file: 'main.cpp', line: 7, column: 3, severity: 'error' });
    expect(diags[0].message).toContain('C2065');
  });

  it('MSVC 缺列号时列号补 1', () => {
    const diags = parseCompileOutput('', "main.cpp(7): error C2065: 'x': undeclared identifier");
    expect(diags[0].column).toBe(1);
  });

  it('识别带盘符的 Windows 路径', () => {
    const diags = parseCompileOutput('', 'C:\\proj\\main.cpp:10:2: error: boom');
    expect(diags[0]).toMatchObject({ file: 'C:\\proj\\main.cpp', line: 10, column: 2 });
  });

  it('去重并按文件/行/列排序', () => {
    const line = "main.cpp:3:9: error: 'x' was not declared in this scope";
    const diags = parseCompileOutput(
      '',
      [line, line, 'other.cpp:1:1: error: first', 'main.cpp:1:1: error: earlier'].join('\n'),
    );
    expect(diags).toHaveLength(3);
    expect(diags.map((d) => d.file)).toEqual(['main.cpp', 'main.cpp', 'other.cpp']);
    expect(diags[0].line).toBe(1);
  });

  it('空输出返回空数组', () => {
    expect(parseCompileOutput('', '')).toEqual([]);
  });
});

describe('buildCompileArgs', () => {
  const base = { flags: ['-O2', '-std=c++17', '-static', '-DONLINE_JUDGE'] };

  it('非 Windows 平台去掉 -static', () => {
    const args = buildCompileArgs(fakeToolchain('clang++'), '/w/main.cpp', '/w/a.out', base, 'darwin');
    expect(args).toContain('-O2');
    expect(args).toContain('-std=c++17');
    expect(args).not.toContain('-static');
    expect(args).toContain('-DONLINE_JUDGE');
    expect(args.slice(-3)).toEqual(['-o', '/w/a.out', '/w/main.cpp']);
  });

  it('MinGW 保留 -static', () => {
    const args = buildCompileArgs(fakeToolchain('g++'), 'C:\\w\\main.cpp', 'C:\\w\\a.exe', base, 'win32');
    expect(args).toContain('-static');
  });

  it('栈大小映射为 -Wl,--stack', () => {
    const args = buildCompileArgs(
      fakeToolchain('g++'),
      'a.cpp',
      'a.exe',
      { stackBytes: 8_388_608 },
      'win32',
    );
    expect(args).toContain('-Wl,--stack,8388608');
  });

  it('非 Windows 平台不带任何栈参数（POSIX 靠运行时 ulimit -s）', () => {
    for (const platform of ['darwin', 'linux'] as NodeJS.Platform[]) {
      const args = buildCompileArgs(
        fakeToolchain('clang++'),
        '/w/a.cpp',
        '/w/a.out',
        { flags: [], stackBytes: 8_388_608 },
        platform,
      );
      expect(args.some((arg) => arg.includes('--stack') || arg.startsWith('/STACK'))).toBe(false);
    }
  });

  it('MSVC 使用 / 开头参数与 /Fe:', () => {
    const args = buildCompileArgs(
      fakeToolchain('cl'),
      'C:\\w\\main.cpp',
      'C:\\w\\a.exe',
      { ...base, stackBytes: 1024 },
      'win32',
    );
    expect(args).toContain('/O2');
    expect(args).toContain('/std:c++17');
    expect(args).toContain('/DONLINE_JUDGE');
    expect(args).toContain('/STACK:1024');
    expect(args).toContain('/Fe:C:\\w\\a.exe');
    expect(args).not.toContain('-static');
  });

  it('附加宏与头文件目录', () => {
    const args = buildCompileArgs(
      fakeToolchain('g++'),
      'a.cpp',
      'a.out',
      { flags: [], defines: { FOO: '1' }, includeDirs: ['/opt/testlib'] },
      'linux',
    );
    expect(args).toContain('-DFOO=1');
    expect(args).toContain('-I/opt/testlib');
  });
});

describe('compile', () => {
  it('python 无需编译，直接给出运行命令', async () => {
    const result = await compile(fakeToolchain('python'), '/w/solve.py');
    expect(result.ok).toBe(true);
    expect(result.exe).toBe('');
    // 期望值也要过一遍 path.resolve：Windows 上 '/w/solve.py' 是「当前盘根目录下的 w」，
    // 会被解析成 D:\w\solve.py，写死字面量只有 POSIX 能过。
    expect(result.runCmd).toEqual({ cmd: 'python', args: [path.resolve('/w/solve.py')] });
  });

  it('源文件不存在时返回诊断而不是抛异常', async () => {
    const result = await compile(fakeToolchain('g++'), '/definitely/not/here.cpp');
    expect(result.ok).toBe(false);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0].message).toContain('无法读取源文件');
  });
});

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verdict-test-'));

afterAll(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});

describe('真实编译（本机无编译器时自动跳过）', () => {
  it('编译 → 运行 → 命中缓存', async () => {
    const toolchain = await detectToolchain();
    if (!toolchain || toolchain.kind === 'python') {
      return;
    }

    const src = path.join(workDir, 'ok.cpp');
    fs.writeFileSync(src, '#include <cstdio>\nint main() { std::printf("ok\\n"); return 0; }\n');
    const cacheDir = path.join(workDir, 'cache');

    const first = await compile(toolchain, src, { cacheDir });
    expect(first.diagnostics).toEqual([]);
    expect(first.ok).toBe(true);
    expect(first.cached).toBe(false);

    const run = await runProcess(first.runCmd.cmd, first.runCmd.args);
    expect(run.stdout.trim()).toBe('ok');

    const second = await compile(toolchain, src, { cacheDir });
    expect(second.cached).toBe(true);
    expect(second.exe).toBe(first.exe);
  });

  it('语法错误能定位到行列', async () => {
    const toolchain = await detectToolchain();
    if (!toolchain || toolchain.kind === 'python') {
      return;
    }

    const src = path.join(workDir, 'bad.cpp');
    fs.writeFileSync(src, '#include <cstdio>\nint main() { std::printf("%d\\n", undefined_symbol); }\n');

    const result = await compile(toolchain, src, { cacheDir: path.join(workDir, 'cache') });
    expect(result.ok).toBe(false);
    expect(result.exe).toBe('');
    expect(result.diagnostics.some((d) => d.severity === 'error' && d.line === 2)).toBe(true);
  });
});
