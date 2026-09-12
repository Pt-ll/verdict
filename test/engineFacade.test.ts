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
