import { describe, expect, it } from 'vitest';
import { Judge, type CaseResult } from '../src/core/judge/judge';
import { DEFAULT_LIMITS, type ComparatorConfig } from '../src/core/model';
import type { RunResult, Sandbox } from '../src/core/sandbox/sandbox';

function baseRun(overrides: Partial<RunResult> = {}): RunResult {
  return {
    status: 'OK',
    exitCode: 0,
    signal: null,
    stdout: Buffer.alloc(0),
    stderr: Buffer.alloc(0),
    wallMs: 7,
    cpuMs: null,
    peakMemKb: 2048,
    truncated: false,
    ...overrides,
  };
}

function sandboxReturning(result: RunResult): Sandbox {
  return { run: async () => result };
}

async function judgeOne(
  result: RunResult,
  options: { answer?: string; points?: number; comparator?: ComparatorConfig } = {},
): Promise<CaseResult> {
  const judge = new Judge(sandboxReturning(result), {
    limits: DEFAULT_LIMITS,
    comparator: options.comparator ?? { mode: 'default' },
  });
  return judge.judgeCase({
    testId: '1',
    input: Buffer.from('1 2\n', 'utf8'),
    answer: Buffer.from(options.answer ?? '3\n', 'utf8'),
    runCmd: { cmd: '/fake/a.out', args: [] },
    points: options.points,
  });
}

describe('judge：运行层结论直接决定判定', () => {
  it('超时判 TLE 且不计分', async () => {
    const result = await judgeOne(
      baseRun({ status: 'TLE', exitCode: null, signal: 'SIGKILL', wallMs: 300 }),
      { answer: '3\n', points: 30 },
    );
    expect(result.verdict).toBe('TLE');
    expect(result.score).toBe(0);
    expect(result.timeMs).toBe(300);
    expect(result.message).toContain('超时');
  });

  it('内存超限判 MLE 并在信息里给出峰值', async () => {
    const result = await judgeOne(
      baseRun({ status: 'MLE', signal: 'SIGKILL', peakMemKb: 131072 }),
    );
    expect(result.verdict).toBe('MLE');
    expect(result.message).toContain('128 MB');
  });

  it('输出超限判 OLE', async () => {
    const result = await judgeOne(baseRun({ status: 'OLE', truncated: true }));
    expect(result.verdict).toBe('OLE');
    expect(result.message).toBe('输出超限');
  });

  it('崩溃判 RE 并带上信号', async () => {
    const result = await judgeOne(
      baseRun({ status: 'RE', exitCode: null, signal: 'SIGABRT' }),
    );
    expect(result.verdict).toBe('RE');
    expect(result.message).toContain('SIGABRT');
  });

  it('退出码非 0 判 RE 并带上退出码', async () => {
    const result = await judgeOne(baseRun({ status: 'RE', exitCode: 3 }));
    expect(result.verdict).toBe('RE');
    expect(result.message).toContain('3');
  });

  it('评测流程自身出错判 UKE，并把 stderr 当原因', async () => {
    const result = await judgeOne(
      baseRun({
        status: 'INTERNAL',
        exitCode: null,
        stderr: Buffer.from('找不到可执行文件：/fake/a.out\n', 'utf8'),
      }),
    );
    expect(result.verdict).toBe('UKE');
    expect(result.message).toContain('找不到可执行文件');
  });
});

describe('judge：运行正常时交给比较器', () => {
  it('输出与答案一致判 AC 并拿满分', async () => {
    const result = await judgeOne(baseRun({ stdout: Buffer.from('3\n', 'utf8') }));
    expect(result.verdict).toBe('AC');
    expect(result.score).toBe(1);
    expect(result.message).toBe('输出一致');
  });

  it('分值按测试点配置缩放', async () => {
    const result = await judgeOne(baseRun({ stdout: Buffer.from('3\n', 'utf8') }), {
      points: 30,
    });
    expect(result.score).toBe(30);
  });

  it('输出不一致判 WA 且不得分', async () => {
    const result = await judgeOne(baseRun({ stdout: Buffer.from('4\n', 'utf8') }), {
      points: 30,
    });
    expect(result.verdict).toBe('WA');
    expect(result.score).toBe(0);
    expect(result.message).toContain('第 1 行不同');
  });

  it('line 模式把首个不同行号带出来', async () => {
    const result = await judgeOne(
      baseRun({ stdout: Buffer.from('1\nx\n', 'utf8') }),
      { answer: '1\ny\n', comparator: { mode: 'line' } },
    );
    expect(result.firstDiffLine).toBe(2);
  });

  it('real 模式按误差比较', async () => {
    const result = await judgeOne(
      baseRun({ stdout: Buffer.from('1.0000001\n', 'utf8') }),
      { answer: '1\n', comparator: { mode: 'real', absEps: 1e-6, relEps: 1e-6 } },
    );
    expect(result.verdict).toBe('AC');
  });

  it('保留实际输出与答案，供 diff 使用', async () => {
    const result = await judgeOne(baseRun({ stdout: Buffer.from('4\n', 'utf8') }));
    expect(result.output.toString()).toBe('4\n');
    expect(result.answer.toString()).toBe('3\n');
  });
});
