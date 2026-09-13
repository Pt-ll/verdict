import type { Limits, Problem, Subtask, TestCase } from '../model';
import { scanPackageTests, type ProblemPackage } from './package';

export interface AddTestsPlan {
  /** 这次要登记的新测试点。 */
  added: TestCase[];
  /** 已经登记过、这次跳过的测试点 id。 */
  skipped: string[];
  /**
   * 登记后的完整列表（已有的在前、新加的在后），直接赋给 problem.tests 即可。
   *
   * 顺手给出来是为了堵住一个很容易犯的错：只把 added 赋回去会把已有测试点全丢掉。
   */
  tests: TestCase[];
}

/**
 * 扫描 data/，找出还没登记进 problem.json 的测试点。
 *
 * 按 id 与输入文件双重去重：只比 id 的话，同一份数据换个文件名仍会被重复登记；
 * 只比文件的话，同一份数据换个 id 也会重复。两种都会让 problem.json 变得难读。
 */
export async function planAddTests(pkg: ProblemPackage): Promise<AddTestsPlan> {
  const scanned = await scanPackageTests(pkg.rootDir, pkg.dataDir);
  const knownIds = new Set(pkg.problem.tests.map((test) => test.id));
  const knownInputs = new Set(pkg.problem.tests.map((test) => test.input));

  const added: TestCase[] = [];
  const skipped: string[] = [];
  for (const test of scanned) {
    if (knownIds.has(test.id) || knownInputs.has(test.input)) {
      skipped.push(test.id);
      continue;
    }
    added.push(test);
  }
  return { added, skipped, tests: [...pkg.problem.tests, ...added] };
}

export interface SubtaskPlan {
  subtasks: Subtask[];
  /**
   * 同步更新过 subtask 字段的测试点。
   *
   * 两边说法必须一致，否则下次加载会报错——所以改子任务时必须把测试点一起改，
   * 不能只动一边。
   */
  tests: TestCase[];
}

/**
 * 把测试点按顺序均分成若干子任务：组内 min（全对才给分）、组间互相独立。
 *
 * 这只是把架子摆好。哪几个点属于同一档数据、要不要加依赖，还得人去改 problem.json：
 * 命令替人做这个决定只会帮倒忙。
 */
export function evenSubtasks(tests: TestCase[], groups: number, totalPoints = 100): SubtaskPlan {
  if (tests.length === 0) {
    return { subtasks: [], tests };
  }

  const count = Math.min(Math.max(1, Math.floor(groups) || 1), tests.length);
  const base = Math.floor(tests.length / count);
  const remainder = tests.length % count;

  const subtasks: Subtask[] = [];
  const updated: TestCase[] = [];
  let cursor = 0;
  for (let index = 0; index < count; index += 1) {
    const size = base + (index < remainder ? 1 : 0);
    const slice = tests.slice(cursor, cursor + size);
    cursor += size;

    const id = String(index + 1);
    subtasks.push({
      id,
      name: `第 ${id} 组`,
      points: shareOfPoints(index, count, totalPoints),
      tests: slice.map((test) => test.id),
      dependsOn: [],
      scoring: 'min',
    });
    for (const test of slice) {
      updated.push({ ...test, subtask: id });
    }
  }
  return { subtasks, tests: updated };
}

/** 总分尽量均分，余数给前面的组：30/30/20 比 33/33/34 更像人定的。 */
function shareOfPoints(index: number, count: number, total: number): number {
  const base = Math.floor(total / count);
  const remainder = total % count;
  return index < remainder ? base + 1 : base;
}

/** 清空子任务归属，同时把测试点上的 subtask 字段一并去掉。 */
export function clearSubtasks(tests: TestCase[]): TestCase[] {
  return tests.map((test) => {
    if (test.subtask === undefined) {
      return test;
    }
    const copy: TestCase = { ...test };
    delete copy.subtask;
    return copy;
  });
}

/** 只替换限制里给定的字段，其余原样保留；非法值直接忽略，不会把 undefined 写进 JSON。 */
export function withLimits(problem: Problem, patch: Partial<Limits>): Problem {
  const limits = { ...problem.limits };
  for (const [key, value] of Object.entries(patch) as [keyof Limits, number | undefined][]) {
    if (value !== undefined && Number.isFinite(value)) {
      limits[key] = value;
    }
  }
  return { ...problem, limits };
}
