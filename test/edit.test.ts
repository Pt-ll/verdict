import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { DEFAULT_LIMITS, type Problem, type TestCase } from '../src/core/model';
import {
  clearSubtasks,
  evenSubtasks,
  planAddTests,
  withLimits,
} from '../src/core/problem/edit';
import { PROBLEM_FILE, loadProblem, saveProblem } from '../src/core/problem/package';

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verdict-edit-'));

afterAll(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});

let counter = 0;

function makePackage(files: Record<string, string>): string {
  const dir = path.join(workDir, `pkg-${counter++}`);
  for (const [relative, text] of Object.entries(files)) {
    const target = path.join(dir, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, text);
  }
  return dir;
}

function testOf(id: string, points = 1): TestCase {
  return { id, input: `data/${id}.in`, answer: `data/${id}.out`, points };
}

function problemOf(tests: TestCase[]): Problem {
  return {
    id: 'A',
    name: 'A',
    type: 'traditional',
    limits: { ...DEFAULT_LIMITS },
    comparator: { mode: 'default' },
    subtasks: [],
    tests,
  };
}

describe('planAddTests', () => {
  it('只挑没登记过的数据，已登记的原样跳过', async () => {
    const dir = makePackage({
      [PROBLEM_FILE]: JSON.stringify({
        id: 'A',
        tests: [{ id: '1', input: 'data/1.in', answer: 'data/1.out' }],
      }),
      'data/1.in': '1\n',
      'data/1.out': '1\n',
      'data/2.in': '2\n',
      'data/2.out': '2\n',
      'data/3.in': '3\n',
      'data/3.ans': '3\n',
    });

    const plan = await planAddTests(await loadProblem(dir));

    expect(plan.added.map((test) => test.id)).toEqual(['2', '3']);
    expect(plan.added.map((test) => test.input)).toEqual(['data/2.in', 'data/3.in']);
    // .ans 也是合法答案后缀，登记时按实际文件名写进去。
    expect(plan.added[1]?.answer).toBe('data/3.ans');
    expect(plan.skipped).toEqual(['1']);
  });

  it('id 撞车但文件不同的数据也算已登记，避免写出重复 id 的 problem.json', async () => {
    const dir = makePackage({
      [PROBLEM_FILE]: JSON.stringify({
        id: 'A',
        tests: [{ id: 'sample', input: 'data/other.in', answer: 'data/other.out' }],
      }),
      'data/sample.in': '1\n',
      'data/sample.out': '1\n',
    });

    const plan = await planAddTests(await loadProblem(dir));

    expect(plan.added).toEqual([]);
    expect(plan.skipped).toEqual(['sample']);
  });
});

describe('evenSubtasks', () => {
  it('按顺序均分，余数给前面的组', () => {
    const plan = evenSubtasks([testOf('1'), testOf('2'), testOf('3'), testOf('4'), testOf('5')], 2);

    expect(plan.subtasks.map((item) => item.tests)).toEqual([['1', '2', '3'], ['4', '5']]);
    expect(plan.subtasks.map((item) => item.points)).toEqual([50, 50]);
    // 组间独立：OI 的分档通常是各自独立计分，依赖要人去显式加。
    expect(plan.subtasks.map((item) => item.dependsOn)).toEqual([[], []]);
    expect(plan.subtasks.map((item) => item.scoring)).toEqual(['min', 'min']);
  });

  it('总分除不尽时余数给前面的组', () => {
    const plan = evenSubtasks([testOf('1'), testOf('2'), testOf('3')], 3, 100);

    expect(plan.subtasks.map((item) => item.points)).toEqual([34, 33, 33]);
  });

  it('组数超过测试点数时按测试点数分组', () => {
    const plan = evenSubtasks([testOf('1'), testOf('2')], 5);

    expect(plan.subtasks).toHaveLength(2);
    expect(plan.subtasks.map((item) => item.tests)).toEqual([['1'], ['2']]);
  });

  it('同步更新测试点上的 subtask 字段（两边必须一致，否则加载会报错）', () => {
    const plan = evenSubtasks([testOf('1'), testOf('2')], 2);

    expect(plan.tests.map((test) => test.subtask)).toEqual(['1', '2']);
  });

  it('没有测试点时返回空计划', () => {
    expect(evenSubtasks([], 3)).toEqual({ subtasks: [], tests: [] });
  });
});

describe('clearSubtasks', () => {
  it('去掉 subtask 字段，其他字段不动', () => {
    const tests: TestCase[] = [
      { ...testOf('1'), subtask: '1' },
      testOf('2'),
    ];

    const cleared = clearSubtasks(tests);

    expect(cleared[0]?.subtask).toBeUndefined();
    expect(cleared[0]?.input).toBe('data/1.in');
    expect(cleared[1]?.subtask).toBeUndefined();
  });
});

describe('withLimits', () => {
  it('只改给定的字段', () => {
    const problem = problemOf([]);

    const updated = withLimits(problem, { timeMs: 2000, memoryMb: 512 });

    expect(updated.limits.timeMs).toBe(2000);
    expect(updated.limits.memoryMb).toBe(512);
    expect(updated.limits.outputKb).toBe(DEFAULT_LIMITS.outputKb);
    // 原对象不被改动：调用方可能还握着它做别的事。
    expect(problem.limits.timeMs).toBe(DEFAULT_LIMITS.timeMs);
  });

  it('非法值直接忽略，不会把 undefined 或 NaN 写进 problem.json', () => {
    const updated = withLimits(problemOf([]), {
      timeMs: Number.NaN,
      outputKb: undefined,
    });

    expect(updated.limits.timeMs).toBe(DEFAULT_LIMITS.timeMs);
    expect(updated.limits.outputKb).toBe(DEFAULT_LIMITS.outputKb);
  });
});

describe('编辑后能重新读回来', () => {
  it('均分子任务 -> 保存 -> 加载，不报错且内容正确', async () => {
    const dir = makePackage({
      // 显式登记了 1：这样 2 才是「新数据」，两个命令的真实顺序也才跑得通。
      // （若完全不写 tests，加载时就会自动扫描 data/，那 addTests 就没有活可干了。）
      [PROBLEM_FILE]: JSON.stringify({
        id: 'A',
        tests: [{ id: '1', input: 'data/1.in', answer: 'data/1.out' }],
      }),
      'data/1.in': '1\n',
      'data/1.out': '1\n',
      'data/2.in': '2\n',
      'data/2.out': '2\n',
    });
    const pkg = await loadProblem(dir);

    // 先把数据登记进来，再分组——这正是两个命令的真实使用顺序。
    pkg.problem.tests = (await planAddTests(pkg)).tests;
    const grouped = evenSubtasks(pkg.problem.tests, 2);
    pkg.problem.subtasks = grouped.subtasks;
    pkg.problem.tests = grouped.tests;
    await saveProblem(pkg);

    const reloaded = await loadProblem(dir);

    expect(reloaded.problem.tests.map((test) => test.id)).toEqual(['1', '2']);
    expect(reloaded.problem.subtasks.map((item) => item.tests)).toEqual([['1'], ['2']]);
    expect(reloaded.problem.subtasks.map((item) => item.points)).toEqual([50, 50]);
  });
});
