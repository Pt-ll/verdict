import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { compile, detectToolchain, type Toolchain } from '../src/core/compiler';
import { interpretCheckerExit, interpretCheckerRun, parsePoints } from '../src/core/compare/spj';
import { resolveTestlibDir } from '../src/core/problem/testlib';
import { loadProblem } from '../src/core/problem/package';
import { createSandbox, type RunResult } from '../src/core/sandbox/sandbox';
import { judgeProblem } from '../src/core/judge/judge';
import type { JudgeOutcome } from '../src/engineFacade';

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verdict-spj-'));
const cacheDir = path.join(workDir, 'cache');
const sandbox = createSandbox();

let toolchain: Toolchain | null = null;
let available = false;

beforeAll(async () => {
  toolchain = await detectToolchain();
  available = toolchain !== null && toolchain.kind !== 'python';
});

afterAll(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});

let counter = 0;

function makeDir(files: Record<string, string>): string {
  const dir = path.join(workDir, `pkg-${counter++}`);
  for (const [relative, text] of Object.entries(files)) {
    const target = path.join(dir, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, text);
  }
  return dir;
}

function runResult(partial: Partial<RunResult>): RunResult {
  return {
    status: 'OK',
    exitCode: 0,
    signal: null,
    stdout: Buffer.alloc(0),
    stderr: Buffer.alloc(0),
    wallMs: 1,
    cpuMs: null,
    peakMemKb: 0,
    truncated: false,
    ...partial,
  };
}

describe('interpretCheckerExit：退出码协议（SPEC §5.4）', () => {
  it('0 是 AC，1 是 WA，stderr 作为说明', () => {
    expect(interpretCheckerExit(0, '', '')).toMatchObject({ verdict: 'AC', scoreRatio: 1 });
    expect(interpretCheckerExit(1, '', '第 3 个数字不对')).toMatchObject({
      verdict: 'WA',
      scoreRatio: 0,
      detail: '第 3 个数字不对',
    });
  });

  it('2 是 PE，本版按 WA 计但保留 PE 字样', () => {
    const result = interpretCheckerExit(2, '', '多余的空白');

    expect(result.verdict).toBe('WA');
    expect(result.scoreRatio).toBe(0);
    expect(result.detail).toContain('PE');
  });

  it('3 是 checker 自己失败，记 UKE 而不是选手的错', () => {
    const result = interpretCheckerExit(3, '', '读不到答案文件');

    expect(result.verdict).toBe('UKE');
    expect(result.detail).toContain('checker 自身失败');
  });

  it('7 是部分分，分数从 stdout 取并折算成比例', () => {
    const result = interpretCheckerExit(7, '65\n', '65/100 个点对');

    expect(result.verdict).toBe('PC');
    expect(result.scoreRatio).toBeCloseTo(0.65, 5);
    expect(result.detail).toContain('65/100');
  });

  it('其他退出码不认识，记 UKE', () => {
    expect(interpretCheckerExit(42, '', '')).toMatchObject({ verdict: 'UKE', scoreRatio: 0 });
  });
});

describe('parsePoints', () => {
  it('取第一个数字并夹到 0..100', () => {
    expect(parsePoints('30').ratio).toBeCloseTo(0.3, 5);
    expect(parsePoints('  120\n').ratio).toBe(1);
    expect(parsePoints('-5').ratio).toBe(0);
  });

  it('说了部分分却没给分数时按 0 分算，并把这件事说出来', () => {
    const parsed = parsePoints('没有数字');

    expect(parsed.ratio).toBe(0);
    expect(parsed.detail).toContain('没有在 stdout 给出分数');
  });
});

describe('interpretCheckerRun', () => {
  it('退出码 1/2/7 在沙箱里都算 RE，必须按退出码解释而不是当成崩溃', () => {
    const result = interpretCheckerRun(
      runResult({ status: 'RE', exitCode: 7, stdout: Buffer.from('40\n') }),
    );

    expect(result.verdict).toBe('PC');
    expect(result.scoreRatio).toBeCloseTo(0.4, 5);
  });

  it('被限额杀掉是 checker 没能正常结束 -> UKE', () => {
    const result = interpretCheckerRun(
      runResult({ status: 'TLE', exitCode: null, stderr: Buffer.from('超时') }),
    );

    expect(result.verdict).toBe('UKE');
    expect(result.detail).toContain('没能正常结束');
  });
});

describe('resolveTestlibDir：按 SPEC §6.6 的顺序找 testlib.h', () => {
  it('目录与直接指向文件两种写法都认，并按给定顺序取第一个命中的', async () => {
    const first = makeDir({ 'testlib.h': '// first' });
    const second = makeDir({ 'testlib.h': '// second' });
    const empty = makeDir({ 'readme.md': 'hi' });

    expect(await resolveTestlibDir([empty, second, first])).toBe(second);
    expect(await resolveTestlibDir([undefined, path.join(first, 'testlib.h')])).toBe(first);
    expect(await resolveTestlibDir([empty, undefined])).toBeNull();
  });
});

// 手写的「testlib 协议」checker：不需要真的 testlib.h，验的是我们这半边的契约。
const PROTOCOL_CHECKER = [
  '#include <cstdio>',
  '#include <fstream>',
  '#include <sstream>',
  '#include <string>',
  'static std::string slurp(const char* path) {',
  '  std::ifstream in(path, std::ios::binary);',
  '  std::ostringstream buffer;',
  '  buffer << in.rdbuf();',
  '  return buffer.str();',
  '}',
  'int main(int argc, char** argv) {',
  '  if (argc < 4) { std::fprintf(stderr, "usage: checker input output answer\\n"); return 3; }',
  '  const std::string output = slurp(argv[2]);',
  '  const std::string answer = slurp(argv[3]);',
  '  if (output.find("PE") != std::string::npos) { std::fprintf(stderr, "格式不对\\n"); return 2; }',
  '  // 按 token 比较而不是按字节：Windows 上 printf 会把 \\n 写成 \\r\\n，',
  '  // 按字节比会把一份完全正确的输出判成 WA（真实的 testlib checker 也是读 token 的）。',
  '  int same = 0;',
  '  int total = 0;',
  '  std::istringstream got(output);',
  '  std::istringstream want(answer);',
  '  std::string left;',
  '  std::string right;',
  '  for (;;) {',
  '    const bool hasLeft = static_cast<bool>(got >> left);',
  '    const bool hasRight = static_cast<bool>(want >> right);',
  '    if (!hasLeft && !hasRight) break;',
  '    total += 1;',
  '    if (hasLeft && hasRight && left == right) same += 1;',
  '  }',
  '  if (total > 0 && same == total) { return 0; }',
  '  if (total > 0 && same > 0) {',
  '    std::printf("%d\\n", (same * 100) / total);',
  '    std::fprintf(stderr, "%d/%d 个数字对\\n", same, total);',
  '    return 7;',
  '  }',
  '  std::fprintf(stderr, "答案不匹配\\n");',
  '  return 1;',
  '}',
  '',
].join('\n');

const program = (body: string): string =>
  ['#include <cstdio>', 'int main() {', body, '  return 0;', '}', ''].join('\n');

function makeSpjProblem(options: { checker?: string; testlibStub?: string } = {}): string {
  return makeDir({
    'problem.json': JSON.stringify({
      id: 'S',
      name: 'S. 三个数',
      limits: { timeMs: 5000, memoryMb: 256, stackMb: 256, outputKb: 4096 },
      comparator: { mode: 'spj', spj: 'extra/checker.cpp' },
      tests: [{ id: '1', input: 'data/1.in', answer: 'data/1.out', points: 100 }],
    }),
    'data/1.in': '1 2 3\n',
    'data/1.out': '1 2 3\n',
    'extra/checker.cpp': options.checker ?? PROTOCOL_CHECKER,
    ...(options.testlibStub === undefined ? {} : { 'extra/testlib.h': options.testlibStub }),
  });
}

async function judgeWith(
  root: string,
  source: string,
  options: { testlibPath?: string } = {},
): Promise<JudgeOutcome> {
  const packageDir = await loadProblem(root);
  const sourcePath = path.join(root, 'solve.cpp');
  fs.writeFileSync(sourcePath, source);

  if (toolchain === null) {
    throw new Error('没有编译器');
  }
  const compiled = await compile(toolchain, sourcePath, { cacheDir });
  if (!compiled.ok) {
    throw new Error(`选手程序编译失败：${compiled.diagnostics.map((item) => item.raw).join(' | ')}`);
  }

  const result = await judgeProblem(packageDir, {
    runCmd: compiled.runCmd,
    toolchain,
    sandbox,
    cacheDir,
    testlibDir: await resolveTestlibDir([packageDir.extraDir, options.testlibPath]),
  });
  return {
    kind: 'judged',
    compile: compiled,
    cases: result.cases,
    subtasks: result.subtasks,
    score: result.score,
    maxScore: result.maxScore,
    problemId: result.problem,
    dataDir: packageDir.dataDir,
    elapsedMs: result.elapsedMs,
    cancelled: false,
    warmedUp: false,
  };
}

describe('SPJ 端到端（真编译）', () => {
  it('checker 判 AC / WA / PE / 部分分', async () => {
    if (!available) {
      return;
    }
    const root = makeSpjProblem();

    const accepted = await judgeWith(root, program('  std::printf("1 2 3\\n");'));
    expect(accepted.kind === 'judged' ? accepted.cases[0]?.verdict : null).toBe('AC');

    const wrong = await judgeWith(root, program('  std::printf("9 9 9\\n");'));
    expect(wrong.kind === 'judged' ? wrong.cases[0]?.verdict : null).toBe('WA');

    const partial = await judgeWith(root, program('  std::printf("1 2 4\\n");'));
    if (partial.kind !== 'judged') {
      throw new Error('应当是 judged');
    }
    expect(partial.cases[0]?.verdict).toBe('PC');
    // 3 个数字里对了 2 个 -> checker 给 66 分 -> 100 分的测试点拿 66 分。
    expect(partial.cases[0]?.score).toBe(66);
    expect(partial.score).toBe(66);

    const formatError = await judgeWith(root, program('  std::printf("PE\\n");'));
    if (formatError.kind !== 'judged') {
      throw new Error('应当是 judged');
    }
    expect(formatError.cases[0]?.verdict).toBe('WA');
    expect(formatError.cases[0]?.message).toContain('PE');
  });

  it('checker 编译不过时记 UKE（不是 CE，也不把选手判挂）', async () => {
    if (!available) {
      return;
    }
    const root = makeSpjProblem({
      checker: '#include <cstdio>\nint main() { return undefined_symbol; }\n',
    });

    const outcome = await judgeWith(root, program('  std::printf("1 2 3\\n");'));

    if (outcome.kind !== 'judged') {
      throw new Error('应当是 judged');
    }
    expect(outcome.cases[0]?.verdict).toBe('UKE');
    expect(outcome.cases[0]?.message).toContain('checker 编译失败');
    expect(outcome.maxScore).toBe(100);
    expect(outcome.score).toBe(0);
  });

  it('checker 不受行尾风格影响（模拟 Windows 的 \\r\\n）', async () => {
    if (!available) {
      return;
    }
    const root = makeSpjProblem();

    // Windows 上 printf 的 "\n" 会变成 "\r\n"；这里显式打印同样的字节，
    // 于是在任何平台上都能复现那次「Windows 上把正确输出判成 WA」的失败条件。
    const outcome = await judgeWith(root, program('  std::printf("1 2 3\\r\\n");'));

    if (outcome.kind !== 'judged') {
      throw new Error('应当是 judged');
    }
    expect(outcome.cases[0]?.verdict).toBe('AC');
  });

  it('缺 testlib.h 时给出提示，放进 extra/ 后就能编过', async () => {
    if (!available) {
      return;
    }
    const needsTestlib = [
      '#include "testlib.h"',
      '#ifndef VERDICT_TESTLIB_STUB',
      '#error "include 到的不是我们放在 extra/ 里的桩头文件"',
      '#endif',
      '#include <cstdio>',
      'int main(int argc, char** argv) {',
      '  if (argc < 4) return 3;',
      '  return 0;',
      '}',
      '',
    ].join('\n');

    const missing = makeSpjProblem({ checker: needsTestlib });
    const first = await judgeWith(missing, program('  std::printf("1 2 3\\n");'));
    if (first.kind !== 'judged') {
      throw new Error('应当是 judged');
    }
    expect(first.cases[0]?.verdict).toBe('UKE');
    expect(first.cases[0]?.message).toContain('testlib.h');
    expect(first.cases[0]?.message).toContain('extra/');

    const provided = makeSpjProblem({
      checker: needsTestlib,
      testlibStub: '#pragma once\n#define VERDICT_TESTLIB_STUB 1\n',
    });
    const second = await judgeWith(provided, program('  std::printf("1 2 3\\n");'));
    if (second.kind !== 'judged') {
      throw new Error('应当是 judged');
    }
    expect(second.cases[0]?.verdict).toBe('AC');
  });

  it('verdict.testlibPath 指到的目录也能顶上来', async () => {
    if (!available) {
      return;
    }
    const needsTestlib = [
      '#include "testlib.h"',
      '#ifndef VERDICT_TESTLIB_STUB',
      '#error "还没找到桩"',
      '#endif',
      '#include <cstdio>',
      'int main(int argc, char** argv) {',
      '  if (argc < 4) return 3;',
      '  return 0;',
      '}',
      '',
    ].join('\n');
    const root = makeSpjProblem({ checker: needsTestlib });
    const testlibDir = makeDir({ 'testlib.h': '#pragma once\n#define VERDICT_TESTLIB_STUB 1\n' });

    const outcome = await judgeWith(root, program('  std::printf("1 2 3\\n");'), {
      testlibPath: testlibDir,
    });

    if (outcome.kind !== 'judged') {
      throw new Error('应当是 judged');
    }
    expect(outcome.cases[0]?.verdict).toBe('AC');
  });
});
