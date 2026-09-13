import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { compile, detectToolchain, type Toolchain } from '../src/core/compiler';
import { decideInteractiveVerdict } from '../src/core/compare/interactive';
import { prepareComparator } from '../src/core/compare/prepare';
import { loadProblem } from '../src/core/problem/package';
import { createSandbox, type ConnectedRunResult, type RunResult } from '../src/core/sandbox/sandbox';
import { judgeProblem } from '../src/core/judge/judge';
import { checkerLimits } from '../src/core/model';
import type { JudgeOutcome } from '../src/engineFacade';

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verdict-interactive-'));
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

describe('decideInteractiveVerdict：交互题的判定规则', () => {
  const ok = runResult({});
  const secondaryOk = { ...runResult({}), killed: false };

  it('选手被限额杀时优先报 TLE / MLE / OLE（§8.5 的优先级最高）', () => {
    expect(decideInteractiveVerdict(runResult({ status: 'TLE' }), secondaryOk).verdict).toBe('TLE');
    expect(decideInteractiveVerdict(runResult({ status: 'MLE' }), secondaryOk).verdict).toBe('MLE');
    expect(decideInteractiveVerdict(runResult({ status: 'OLE' }), secondaryOk).verdict).toBe('OLE');
  });

  it('交互器退出码就是判定（0=AC / 1=WA / 7=部分分）', () => {
    expect(decideInteractiveVerdict(ok, secondaryOk).verdict).toBe('AC');
    expect(
      decideInteractiveVerdict(ok, { ...runResult({ exitCode: 1, status: 'RE' }), killed: false })
        .verdict,
    ).toBe('WA');
    const partial = decideInteractiveVerdict(ok, {
      // 交互题的分数只能在 stderr 上：它的 stdout 是对话通道。
      ...runResult({ exitCode: 7, status: 'RE', stderr: Buffer.from('40\n') }),
      killed: false,
    });
    expect(partial.verdict).toBe('PC');
    expect(partial.scoreRatio).toBeCloseTo(0.4, 5);
  });

  it('选手崩了而交互器只说「答案不对」时报 RE，别把根因藏起来', () => {
    const result = decideInteractiveVerdict(
      runResult({ status: 'RE', signal: 'SIGSEGV', exitCode: null }),
      { ...runResult({ exitCode: 1, status: 'RE' }), killed: false },
    );

    expect(result.verdict).toBe('RE');
    expect(result.detail).toContain('程序崩溃才是根因');
  });

  it('交互器自己出问题记 UKE', () => {
    expect(
      decideInteractiveVerdict(ok, { ...runResult({ status: 'TLE' }), killed: true }).verdict,
    ).toBe('UKE');
    expect(
      decideInteractiveVerdict(ok, { ...runResult({ exitCode: 3, status: 'RE' }), killed: false })
        .verdict,
    ).toBe('UKE');
  });
});

// 手写的交互器：读 argv[1] 里的秘密数字，与选手程序猜数字。
// 协议与 testlib 一致（对话走 stdin/stdout，退出码表达判定），但不需要真的 testlib.h。
const INTERACTOR = [
  '#include <fstream>',
  '#include <iostream>',
  '#include <string>',
  'int main(int argc, char** argv) {',
  '  if (argc < 3) { std::cerr << "usage: interactor input answer" << std::endl; return 3; }',
  '  long long secret = 0;',
  '  std::ifstream in(argv[1]);',
  '  if (!(in >> secret)) { std::cerr << "读不到输入" << std::endl; return 3; }',
  '  int guesses = 0;',
  '  for (;;) {',
  '    long long guess = 0;',
  '    if (!(std::cin >> guess)) { std::cerr << "选手的输出不是数字，或提前结束" << std::endl; return 2; }',
  '    guesses += 1;',
  '    if (guess == secret) { std::cout << "ok" << std::endl; return 0; }',
  '    if (guesses > 20) { std::cerr << "猜的次数太多" << std::endl; return 1; }',
  '    std::cout << (guess < secret ? "bigger" : "smaller") << std::endl;',
  '  }',
  '}',
  '',
].join('\n');

const BINARY_SEARCH = [
  '#include <iostream>',
  '#include <string>',
  'int main() {',
  '  long long low = 1;',
  '  long long high = 100;',
  '  for (;;) {',
  '    const long long mid = (low + high) / 2;',
  '    std::cout << mid << std::endl;',
  '    std::string reply;',
  '    if (!(std::cin >> reply)) return 0;',
  '    if (reply == "ok") return 0;',
  '    if (reply == "bigger") low = mid + 1; else high = mid - 1;',
  '  }',
  '}',
  '',
].join('\n');

const ALWAYS_ONE = [
  '#include <iostream>',
  '#include <string>',
  'int main() {',
  '  for (;;) {',
  '    std::cout << 1 << std::endl;',
  '    std::string reply;',
  '    if (!(std::cin >> reply)) return 0;',
  '    if (reply == "ok") return 0;',
  '  }',
  '}',
  '',
].join('\n');

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

function makeInteractiveProblem(options: { limitMs?: number } = {}): string {
  return makeDir({
    'problem.json': JSON.stringify({
      id: 'C',
      name: 'C. 猜数字',
      type: 'interactive',
      limits: { timeMs: options.limitMs ?? 5000, memoryMb: 256, stackMb: 256, outputKb: 4096 },
      comparator: { mode: 'interactive', interactor: 'extra/interactor.cpp' },
      tests: [{ id: '1', input: 'data/1.in', answer: 'data/1.out', points: 100 }],
    }),
    'data/1.in': '42\n',
    'data/1.out': '42\n',
    'extra/interactor.cpp': INTERACTOR,
  });
}

async function judgeWith(root: string, source: string): Promise<JudgeOutcome> {
  const pkg = await loadProblem(root);
  const sourcePath = path.join(root, 'solve.cpp');
  fs.writeFileSync(sourcePath, source);

  if (toolchain === null) {
    throw new Error('没有编译器');
  }
  const compiled = await compile(toolchain, sourcePath, { cacheDir });
  if (!compiled.ok) {
    throw new Error(`选手程序编译失败：${compiled.diagnostics.map((item) => item.raw).join(' | ')}`);
  }

  const result = await judgeProblem(pkg, {
    runCmd: compiled.runCmd,
    toolchain,
    sandbox,
    cacheDir,
  });
  return {
    kind: 'judged',
    compile: compiled,
    cases: result.cases,
    subtasks: result.subtasks,
    score: result.score,
    maxScore: result.maxScore,
    problemId: result.problem,
    dataDir: pkg.dataDir,
    elapsedMs: result.elapsedMs,
    cancelled: false,
    warmedUp: false,
  };
}

describe('交互题端到端（真对拍）', () => {
  it('录得下交互记录：调试交互题就靠它重放（交互器发来的提示）', async () => {
    if (!available || toolchain === null) {
      return;
    }
    const root = makeInteractiveProblem();
    const pkg = await loadProblem(root);
    const prepared = await prepareComparator(pkg.problem.comparator, {
      packageRoot: pkg.rootDir,
      toolchain,
      sandbox,
      limits: checkerLimits(pkg.problem.limits),
      cacheDir,
      testlibDir: null,
    });
    if ('error' in prepared || prepared.interactive === undefined) {
      throw new Error('交互器没准备好');
    }

    const sourcePath = path.join(root, 'solve.cpp');
    fs.writeFileSync(sourcePath, BINARY_SEARCH);
    const compiled = await compile(toolchain, sourcePath, { cacheDir });
    if (!compiled.ok) {
      throw new Error('选手程序编译失败');
    }

    const outcome = await prepared.interactive.run(
      compiled.runCmd,
      Buffer.from('42\n'),
      Buffer.from('42\n'),
      pkg.problem.limits,
    );

    // 交互器发给选手的那串提示就是要重放的内容：最后一定是 "ok"（猜中了）。
    const tape = outcome.transcript.toPrimary.toString('utf8');
    expect(tape).toContain('bigger');
    expect(tape.trim().endsWith('ok')).toBe(true);
    // 选手发出去的内容也在记录里，复盘时两边都看得到。
    expect(outcome.transcript.fromPrimary.toString('utf8')).toContain('50');
  });

  it('二分猜数字判 AC', async () => {
    if (!available) {
      return;
    }
    const outcome = await judgeWith(makeInteractiveProblem(), BINARY_SEARCH);

    if (outcome.kind !== 'judged') {
      throw new Error('应当是 judged');
    }
    expect(outcome.cases[0]?.verdict).toBe('AC');
    expect(outcome.score).toBe(100);
  });

  it('一直猜 1 判 WA（交互器说次数太多）', async () => {
    if (!available) {
      return;
    }
    const outcome = await judgeWith(makeInteractiveProblem(), ALWAYS_ONE);

    if (outcome.kind !== 'judged') {
      throw new Error('应当是 judged');
    }
    expect(outcome.cases[0]?.verdict).toBe('WA');
    expect(outcome.cases[0]?.message).toContain('次数太多');
  });

  it('输出非数字判 PE（本版按 WA 计，说明里保留 PE）', async () => {
    if (!available) {
      return;
    }
    const chatty = [
      '#include <iostream>',
      'int main() {',
      '  std::cout << "你好呀" << std::endl;',
      '  return 0;',
      '}',
      '',
    ].join('\n');

    const outcome = await judgeWith(makeInteractiveProblem(), chatty);

    if (outcome.kind !== 'judged') {
      throw new Error('应当是 judged');
    }
    expect(outcome.cases[0]?.verdict).toBe('WA');
    expect(outcome.cases[0]?.message).toContain('PE');
  });

  it('选手崩溃时报 RE，而不是交互器的 WA', async () => {
    if (!available) {
      return;
    }
    const crashing = [
      '#include <cstdlib>',
      'int main() {',
      '  std::abort();',
      '}',
      '',
    ].join('\n');

    const outcome = await judgeWith(makeInteractiveProblem({ limitMs: 10_000 }), crashing);

    if (outcome.kind !== 'judged') {
      throw new Error('应当是 judged');
    }
    expect(outcome.cases[0]?.verdict).toBe('RE');
  });

  it('选手死循环时判 TLE，并且两边都被收掉（不留孤儿进程）', async () => {
    if (!available) {
      return;
    }
    const looping = [
      '#include <iostream>',
      'int main() {',
      '  for (;;) { }',
      '}',
      '',
    ].join('\n');

    const startedAt = Date.now();
    const outcome = await judgeWith(makeInteractiveProblem({ limitMs: 600 }), looping);

    if (outcome.kind !== 'judged') {
      throw new Error('应当是 judged');
    }
    expect(outcome.cases[0]?.verdict).toBe('TLE');
    // 时限 600ms：要是没收干净，这里会明显超时（交互器在等一个永不出声的选手）。
    expect(Date.now() - startedAt).toBeLessThan(10_000);
  });
});

describe('runConnected 的基本行为', () => {
  it('两边没有可执行文件时给出 INTERNAL 而不是抛异常', async () => {
    const result: ConnectedRunResult = await sandbox.runConnected(
      { cmd: 'definitely-not-here-1', args: [] },
      { cmd: 'definitely-not-here-2', args: [] },
      { ...{ timeMs: 1000, memoryMb: 64, stackMb: 64, outputKb: 64 } },
      { timeMs: 1000, memoryMb: 64, stackMb: 64, outputKb: 64 },
    );

    expect(result.primary.status).toBe('INTERNAL');
    expect(result.secondary.status).toBe('INTERNAL');
  });
});
