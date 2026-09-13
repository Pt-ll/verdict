import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { detectToolchain } from '../src/core/compiler';
import { DEFAULT_LIMITS, type Limits } from '../src/core/model';
import { judgeSourceFile, type EngineOptions, type JudgeOutcome } from '../src/engineFacade';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'verdict-e2e-'));
const cacheDir = path.join(root, 'cache');
const sourcePath = path.join(root, 'solve.cpp');

let available = false;

beforeAll(async () => {
  const toolchain = await detectToolchain();
  available = toolchain !== null && toolchain.kind !== 'python';
  fs.writeFileSync(path.join(root, 'solve.in'), '1 2\n');
  fs.writeFileSync(path.join(root, 'solve.out'), '3\n');
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function options(limits: Partial<Limits> = {}): EngineOptions {
  return {
    compilerPath: '',
    flags: ['-O2', '-std=c++17'],
    limits: { ...DEFAULT_LIMITS, ...limits },
    comparator: { mode: 'default' },
    cacheDir,
  };
}

async function judge(source: string, limits: Partial<Limits> = {}): Promise<JudgeOutcome> {
  fs.writeFileSync(sourcePath, source);
  return judgeSourceFile(sourcePath, options(limits));
}

const SUM_PROGRAM = [
  '#include <cstdio>',
  'int main() {',
  '  int a = 0, b = 0;',
  '  if (std::scanf("%d %d", &a, &b) != 2) return 1;',
  '  std::printf("%d\\n", a + b);',
  '  return 0;',
  '}',
  '',
].join('\n');

describe('engineFacade：编译 -> 运行 -> 比较 的完整链路', () => {
  it('正确程序判 AC', async () => {
    if (!available) {
      return;
    }
    const outcome = await judge(SUM_PROGRAM);
    expect(outcome.kind).toBe('judged');
    if (outcome.kind !== 'judged') {
      return;
    }
    expect(outcome.cases).toHaveLength(1);
    expect(outcome.cases[0]).toMatchObject({ test: 'solve', verdict: 'AC', score: 1 });
    expect(outcome.compile.cached).toBe(false);
  });

  it('结果错误判 WA，并给出实际输出', async () => {
    if (!available) {
      return;
    }
    const wrong = SUM_PROGRAM.replace('a + b', 'a - b');
    const outcome = await judge(wrong);
    if (outcome.kind !== 'judged') {
      throw new Error(`期望 judged，实际 ${outcome.kind}`);
    }
    expect(outcome.cases[0].verdict).toBe('WA');
    expect(outcome.cases[0].output.toString().trim()).toBe('-1');
  });

  it('死循环判 TLE', async () => {
    if (!available) {
      return;
    }
    const outcome = await judge('int main() { for (;;) {} }\n', { timeMs: 300 });
    if (outcome.kind !== 'judged') {
      throw new Error(`期望 judged，实际 ${outcome.kind}`);
    }
    expect(outcome.cases[0].verdict).toBe('TLE');
  });

  it('崩溃判 RE', async () => {
    if (!available) {
      return;
    }
    // macOS 上 abort() 会等系统写完崩溃报告（实测约 260ms，机器繁忙时更久），
    // 这里给足时限，避免把「崩溃」误测成「超时」。
    const outcome = await judge('#include <cstdlib>\nint main() { std::abort(); }\n', {
      timeMs: 10_000,
    });
    if (outcome.kind !== 'judged') {
      throw new Error(`期望 judged，实际 ${outcome.kind}`);
    }
    expect(outcome.cases[0].verdict).toBe('RE');
  });

  it('编译失败返回结构化诊断，而不是抛异常', async () => {
    if (!available) {
      return;
    }
    const outcome = await judge('#include <cstdio>\nint main() { return undefined_symbol; }\n');
    expect(outcome.kind).toBe('compile-failed');
    if (outcome.kind !== 'compile-failed') {
      return;
    }
    expect(outcome.compile.diagnostics.some((d) => d.severity === 'error')).toBe(true);
  });

  it('新编译的产物先预热一次，命中缓存则跳过', async () => {
    if (!available) {
      return;
    }
    // 换一份内容不同的源码，保证这一次是新编译而不是命中已有缓存。
    const fresh = `// 预热用例\n${SUM_PROGRAM}`;

    const first = await judge(fresh);
    if (first.kind !== 'judged') {
      throw new Error(`期望 judged，实际 ${first.kind}`);
    }
    expect(first.compile.cached).toBe(false);
    expect(first.warmedUp).toBe(true);

    const second = await judge(fresh);
    if (second.kind !== 'judged') {
      throw new Error(`期望 judged，实际 ${second.kind}`);
    }
    expect(second.compile.cached).toBe(true);
    expect(second.warmedUp).toBe(false);
    expect(second.cases[0].verdict).toBe('AC');
  });
});

describe('engineFacade：找不到测试数据', () => {
  it('返回 no-tests 并带上源文件路径', async () => {
    const bareDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verdict-e2e-bare-'));
    const bareSource = path.join(bareDir, 'alone.cpp');
    try {
      fs.writeFileSync(bareSource, SUM_PROGRAM);
      const outcome = await judgeSourceFile(bareSource, options());
      expect(outcome.kind).toBe('no-tests');
      if (outcome.kind === 'no-tests') {
        expect(outcome.sourcePath).toBe(bareSource);
      }
    } finally {
      fs.rmSync(bareDir, { recursive: true, force: true });
    }
  });
});

describe('engineFacade：题目包', () => {
  const problemRoot = path.join(root, 'problems', 'A');
  const packageSource = path.join(problemRoot, 'solve.cpp');

  function writePackage(files: Record<string, string>): void {
    fs.rmSync(problemRoot, { recursive: true, force: true });
    for (const [relative, text] of Object.entries(files)) {
      const target = path.join(problemRoot, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, text);
    }
  }

  async function judgePackage(): Promise<JudgeOutcome> {
    fs.writeFileSync(packageSource, SUM_PROGRAM);
    return judgeSourceFile(packageSource, options());
  }

  it('源文件在题目包里时按题目包评测，而不是旁边同名的 .in/.out', async () => {
    if (!available) {
      return;
    }
    writePackage({
      'problem.json': JSON.stringify({
        id: 'A',
        name: 'A. 求和',
        limits: { timeMs: 5000, memoryMb: 256, stackMb: 256, outputKb: 4096 },
        tests: [
          { id: '1', input: 'data/1.in', answer: 'data/1.out', points: 30 },
          { id: '2', input: 'data/2.in', answer: 'data/2.out', points: 70 },
        ],
      }),
      'data/1.in': '1 2\n',
      'data/1.out': '3\n',
      'data/2.in': '4 5\n',
      'data/2.out': '9\n',
      // 同名的一对也在，但题目包优先，所以它不该被用上。
      'solve.in': '1 2\n',
      'solve.out': '3\n',
    });

    const outcome = await judgePackage();

    if (outcome.kind !== 'judged') {
      throw new Error(`期望 judged，实际 ${outcome.kind}`);
    }
    expect(outcome.problemId).toBe('A');
    expect(outcome.cases.map((item) => item.test)).toEqual(['1', '2']);
    expect(outcome.cases.map((item) => item.verdict)).toEqual(['AC', 'AC']);
    expect(outcome.score).toBe(100);
    expect(outcome.maxScore).toBe(100);
    expect(outcome.subtasks).toEqual([]);
  });

  it('依赖未满分时，后继子任务被 skip 并计 0 分（M2 验收点）', async () => {
    if (!available) {
      return;
    }
    writePackage({
      'problem.json': JSON.stringify({
        id: 'A',
        limits: { timeMs: 5000 },
        subtasks: [
          { id: '1', points: 30, tests: ['1'], dependsOn: [], scoring: 'min' },
          { id: '2', points: 70, tests: ['2'], dependsOn: ['1'], scoring: 'min' },
        ],
        tests: [
          { id: '1', input: 'data/1.in', answer: 'data/1.out', points: 30, subtask: '1' },
          { id: '2', input: 'data/2.in', answer: 'data/2.out', points: 70, subtask: '2' },
        ],
      }),
      // 第 1 组故意对不上：它挂了，于是依赖它的第 2 组应当被跳过。
      'data/1.in': '1 2\n',
      'data/1.out': '999\n',
      // 第 2 组本身是对的，但不该因此拿到分。
      'data/2.in': '4 5\n',
      'data/2.out': '9\n',
    });

    const outcome = await judgePackage();

    if (outcome.kind !== 'judged') {
      throw new Error(`期望 judged，实际 ${outcome.kind}`);
    }
    expect(outcome.cases.map((item) => item.verdict)).toEqual(['WA', 'AC']);
    expect(outcome.subtasks).toEqual([
      { id: '1', score: 0, maxScore: 30, status: 'none' },
      { id: '2', score: 0, maxScore: 70, status: 'skipped' },
    ]);
    expect(outcome.score).toBe(0);
    expect(outcome.maxScore).toBe(100);
  });

  it('限制以题目包为准，而不是编辑器设置', async () => {
    if (!available) {
      return;
    }
    writePackage({
      'problem.json': JSON.stringify({
        id: 'A',
        // 题目包的时限宽裕得多；如果实现错误地用了设置里的 50ms，这个程序会被判 TLE。
        limits: { timeMs: 5000 },
        tests: [{ id: '1', input: 'data/1.in', answer: 'data/1.out' }],
      }),
      'data/1.in': '1 2\n',
      'data/1.out': '3\n',
    });
    // 算完之后空转到 300ms：设置里的 50ms 一定不够，题目包的 5000ms 绰绰有余。
    fs.writeFileSync(
      packageSource,
      [
        '#include <cstdio>',
        '#include <chrono>',
        'int main() {',
        '  int a = 0, b = 0;',
        '  if (std::scanf("%d %d", &a, &b) != 2) return 1;',
        '  std::printf("%d\\n", a + b);',
        '  const auto deadline =',
        '      std::chrono::steady_clock::now() + std::chrono::milliseconds(300);',
        '  while (std::chrono::steady_clock::now() < deadline) {}',
        '  return 0;',
        '}',
        '',
      ].join('\n'),
    );

    const outcome = await judgeSourceFile(packageSource, options({ timeMs: 50 }));

    if (outcome.kind !== 'judged') {
      throw new Error(`期望 judged，实际 ${outcome.kind}`);
    }
    expect(outcome.cases[0]?.verdict).toBe('AC');
  });

  it('题目包里还没有数据时，提示该往哪里放，而不是含糊的「未找到测试数据」', async () => {
    writePackage({ 'problem.json': JSON.stringify({ id: 'A' }) });

    const outcome = await judgePackage();

    expect(outcome.kind).toBe('no-tests');
    if (outcome.kind !== 'no-tests') {
      return;
    }
    expect(outcome.message).toContain('还没有测试点');
    expect(outcome.message).toContain(path.join(problemRoot, 'data'));
  });
});
