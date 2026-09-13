import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  DEFAULT_LIMITS,
  type ComparatorConfig,
  type ComparatorMode,
  type Limits,
  type Problem,
  type ProblemType,
  type Subtask,
  type TestCase,
} from '../model';
import { scanTests } from './scan';
import { topoOrderSubtasks } from './subtasks';
import { isFile } from '../../util/files';
import { isInside } from '../../util/paths';
import {
  ConfigIssues,
  describe,
  isObject,
  isNonNegativeNumber,
  readJsonObject,
  readNonNegative,
  readString,
  readStringArray,
} from '../../util/json';

export const PROBLEM_FILE = 'problem.json';
export const PROBLEM_JSON_VERSION = 1;

/** 题目包：problem.json + data/（测试数据）+ extra/（checker / std / gen）。 */
export interface ProblemPackage {
  problem: Problem;
  /** problem.json 所在目录。 */
  rootDir: string;
  /** 测试数据目录，默认 rootDir/data。 */
  dataDir: string;
  /** checker / interactor / std / gen，默认 rootDir/extra。 */
  extraDir: string;
}

/** 读取题目包。格式有问题时抛出的错误会一次列全部问题，而不是让用户改一处报一次。 */
export async function loadProblem(rootDir: string): Promise<ProblemPackage> {
  const resolved = path.resolve(rootDir);
  const problemPath = path.join(resolved, PROBLEM_FILE);
  const raw = await readJsonObject(problemPath, (target) =>
    fs.promises.readFile(target, 'utf8'),
  );

  const dataDir = path.join(resolved, 'data');
  const issues = new ConfigIssues();
  const problem = await buildProblem(raw, { rootDir: resolved, dataDir, issues });
  issues.throwIfAny(problemPath);

  return { problem, rootDir: resolved, dataDir, extraDir: path.join(resolved, 'extra') };
}

/**
 * 写回 problem.json。
 *
 * 只写这一个文件：写操作限定在题目包内，绝不碰选手源码（SPEC §5.8）。
 * 数据文件（*.in / *.out）不在这里生成，由 addTests 之类的命令负责。
 */
export async function saveProblem(pkg: ProblemPackage): Promise<void> {
  const target = path.join(pkg.rootDir, PROBLEM_FILE);
  const text = `${JSON.stringify(serializeProblem(pkg.problem), null, 2)}\n`;
  await fs.promises.mkdir(pkg.rootDir, { recursive: true });
  await fs.promises.writeFile(target, text, 'utf8');
}

/** 把测试点的相对路径还原成绝对路径（基准是题目包根目录，SPEC §6.3）。 */
export function resolveTestPath(
  pkg: ProblemPackage,
  test: TestCase,
): { inputPath: string; answerPath: string } {
  return {
    inputPath: path.join(pkg.rootDir, test.input),
    answerPath: path.join(pkg.rootDir, test.answer),
  };
}

/**
 * 从 startDir 逐级向上找最近的 problem.json，返回题目包根目录，找不到返回 null。
 *
 * 题目包是自包含的，所以「往上找」比「猜是哪道题」可靠：选手源码可以放在包内任意深度。
 * 给了 stopDir（通常是工作区根）就只在它内部找，避免一路找到用户主目录去。
 */
export async function findProblemRoot(
  startDir: string,
  stopDir?: string,
): Promise<string | null> {
  let dir = path.resolve(startDir);
  const stop = stopDir === undefined ? null : path.resolve(stopDir);

  for (;;) {
    if (stop !== null && !isInside(dir, stop)) {
      return null;
    }
    if (await isFile(path.join(dir, PROBLEM_FILE))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      return null;
    }
    dir = parent;
  }
}

interface BuildContext {
  rootDir: string;
  dataDir: string;
  issues: ConfigIssues;
}

async function buildProblem(raw: Record<string, unknown>, ctx: BuildContext): Promise<Problem> {
  const { issues, rootDir } = ctx;
  const fallbackName = path.basename(rootDir);

  const problem: Problem = {
    // id 缺省就用目录名：题目包自包含，目录名本身就是最自然的标识。
    id: readString(raw.id) ?? fallbackName,
    name: readString(raw.name) ?? readString(raw.id) ?? fallbackName,
    type: readType(raw.type, issues),
    limits: readLimits(raw.limits, issues),
    comparator: readComparator(raw.comparator, issues),
    subtasks: readSubtasks(raw.subtasks, issues),
    tests: await readTests(raw.tests, ctx),
    _raw: raw,
  };

  const sourceDir = readString(raw.sourceDir);
  if (sourceDir !== undefined) {
    problem.sourceDir = sourceDir;
  }
  const answerDir = readString(raw.answerDir);
  if (answerDir !== undefined) {
    problem.answerDir = answerDir;
  }

  validateProblem(problem, issues);
  return problem;
}

function readType(raw: unknown, issues: ConfigIssues): ProblemType {
  if (raw === undefined) {
    return 'traditional';
  }
  if (raw === 'traditional' || raw === 'interactive') {
    return raw;
  }
  issues.add(`type 只能是 "traditional" 或 "interactive"，现在是 ${describe(raw)}`);
  return 'traditional';
}

const LIMIT_KEYS = ['timeMs', 'memoryMb', 'stackMb', 'outputKb'] as const;

const UNSUPPORTED_LIMIT_KEYS = ['procCount'];

function readLimits(raw: unknown, issues: ConfigIssues): Limits {
  const limits: Limits = { ...DEFAULT_LIMITS };
  if (raw === undefined) {
    return limits;
  }
  if (!isObject(raw)) {
    issues.add(`limits 必须是对象，现在是 ${describe(raw)}`);
    return limits;
  }

  for (const key of LIMIT_KEYS) {
    const value = raw[key];
    if (value === undefined) {
      continue;
    }
    if (!isNonNegativeNumber(value)) {
      issues.add(`limits.${key} 必须是非负数，现在是 ${describe(value)}`);
      continue;
    }
    limits[key] = value;
  }
  if (limits.timeMs <= 0) {
    issues.add(`limits.timeMs 必须大于 0，现在是 ${String(raw.timeMs)}`);
    limits.timeMs = DEFAULT_LIMITS.timeMs;
  }

  for (const key of Object.keys(raw)) {
    if ((LIMIT_KEYS as readonly string[]).includes(key)) {
      continue;
    }
    if (UNSUPPORTED_LIMIT_KEYS.includes(key)) {
      // SPEC §5.1 把它列为「尽力而为」，本版确实没有实现——如实告知，别让人以为生效了。
      issues.add(`limits.${key} 目前不支持（本版没有实现进程数限制）`);
      continue;
    }
    issues.add(`limits 里有无法识别的字段 "${key}"，是不是拼错了？`);
  }
  return limits;
}

const COMPARATOR_MODES: readonly ComparatorMode[] = [
  'default',
  'line',
  'real',
  'spj',
  'interactive',
];

function readComparator(raw: unknown, issues: ConfigIssues): ComparatorConfig {
  if (raw === undefined) {
    return { mode: 'default' };
  }
  if (!isObject(raw)) {
    issues.add(`comparator 必须是对象，现在是 ${describe(raw)}`);
    return { mode: 'default' };
  }

  const mode = raw.mode;
  if (mode !== undefined && !COMPARATOR_MODES.includes(mode as ComparatorMode)) {
    issues.add(
      `comparator.mode 只能是 ${COMPARATOR_MODES.join(' / ')}，现在是 ${describe(mode)}`,
    );
    return { mode: 'default' };
  }

  const comparator: ComparatorConfig = {
    mode: mode === undefined ? 'default' : (mode as ComparatorMode),
  };
  const absEps = readNonNegative(raw.absEps, 'comparator.absEps', issues);
  if (absEps !== undefined) {
    comparator.absEps = absEps;
  }
  const relEps = readNonNegative(raw.relEps, 'comparator.relEps', issues);
  if (relEps !== undefined) {
    comparator.relEps = relEps;
  }
  const spj = readString(raw.spj);
  if (spj !== undefined) {
    comparator.spj = spj;
  }
  const interactor = readString(raw.interactor);
  if (interactor !== undefined) {
    comparator.interactor = interactor;
  }
  return comparator;
}

function readSubtasks(raw: unknown, issues: ConfigIssues): Subtask[] {
  if (raw === undefined) {
    return [];
  }
  if (!Array.isArray(raw)) {
    issues.add(`subtasks 必须是数组，现在是 ${describe(raw)}`);
    return [];
  }

  const subtasks: Subtask[] = [];
  const seen = new Set<string>();
  raw.forEach((item, index) => {
    const where = `subtasks[${index}]`;
    if (!isObject(item)) {
      issues.add(`${where} 必须是对象，现在是 ${describe(item)}`);
      return;
    }
    const id = readString(item.id);
    if (id === undefined) {
      issues.add(`${where} 缺少 id`);
      return;
    }
    if (seen.has(id)) {
      issues.add(`子任务 id "${id}" 重复了`);
      return;
    }
    seen.add(id);

    if (!isNonNegativeNumber(item.points)) {
      issues.add(`子任务 "${id}" 缺少 points，或它不是非负数（现在是 ${describe(item.points)}）`);
      return;
    }
    const scoring = item.scoring;
    if (scoring !== undefined && scoring !== 'min' && scoring !== 'sum') {
      issues.add(`子任务 "${id}" 的 scoring 只能是 "min" 或 "sum"，现在是 ${describe(scoring)}`);
      return;
    }

    const subtask: Subtask = {
      id,
      points: item.points,
      tests: readStringArray(item.tests, `子任务 "${id}" 的 tests`, issues),
      dependsOn: readStringArray(item.dependsOn, `子任务 "${id}" 的 dependsOn`, issues),
      // OI 的常见约定是「组内全对才给分」，所以缺省用 min。
      scoring: scoring === 'sum' ? 'sum' : 'min',
    };
    const name = readString(item.name);
    if (name !== undefined) {
      subtask.name = name;
    }
    subtasks.push(subtask);
  });
  return subtasks;
}

async function readTests(raw: unknown, ctx: BuildContext): Promise<TestCase[]> {
  const { issues } = ctx;
  if (raw === undefined) {
    return scanPackageTests(ctx.rootDir, ctx.dataDir);
  }
  if (!Array.isArray(raw)) {
    issues.add(`tests 必须是数组，现在是 ${describe(raw)}`);
    return [];
  }
  if (raw.length === 0) {
    // 空数组按「没写」处理：想自动扫描的人不该因为写了 [] 而没有测试点。
    return scanPackageTests(ctx.rootDir, ctx.dataDir);
  }

  const tests: TestCase[] = [];
  const seen = new Set<string>();
  raw.forEach((item, index) => {
    const where = `tests[${index}]`;
    if (!isObject(item)) {
      issues.add(`${where} 必须是对象，现在是 ${describe(item)}`);
      return;
    }
    const id = readString(item.id);
    if (id === undefined) {
      issues.add(`${where} 缺少 id`);
      return;
    }
    if (seen.has(id)) {
      issues.add(`测试点 id "${id}" 重复了`);
      return;
    }
    seen.add(id);

    const input = readString(item.input);
    const answer = readString(item.answer);
    if (input === undefined) {
      issues.add(`测试点 "${id}" 缺少 input`);
    }
    if (answer === undefined) {
      issues.add(`测试点 "${id}" 缺少 answer`);
    }
    if (input === undefined || answer === undefined) {
      return;
    }

    const test: TestCase = { id, input, answer };
    const points = readNonNegative(item.points, `测试点 "${id}" 的 points`, issues);
    if (points !== undefined) {
      test.points = points;
    }
    const subtask = readString(item.subtask);
    if (subtask !== undefined) {
      test.subtask = subtask;
    }
    const validator = readString(item.validator);
    if (validator !== undefined) {
      test.validator = validator;
    }
    tests.push(test);
  });
  return tests;
}

/**
 * 扫描 data/，返回路径相对题目包根目录的测试点。
 *
 * 没有 problem.json 的 tests 也能用：丢进去 1.in + 1.out 就是一个测试点（约定优于配置）。
 */
export async function scanPackageTests(rootDir: string, dataDir: string): Promise<TestCase[]> {
  const scanned = await scanTests(dataDir);
  return scanned.map((test) => ({
    id: test.id,
    // scanTests 给的是相对 data/ 的名字，统一换算成题目包根目录（SPEC §6.3 写 "data/1.in"）。
    input: toPackageRelative(rootDir, path.join(dataDir, test.input)),
    answer: toPackageRelative(rootDir, path.join(dataDir, test.answer)),
  }));
}

function toPackageRelative(rootDir: string, absolute: string): string {
  // problem.json 要进 git、要跨平台共享，所以统一用 / 分隔（AGENTS「三平台约定」）。
  return path.relative(rootDir, absolute).split(path.sep).join('/');
}

function validateProblem(problem: Problem, issues: ConfigIssues): void {
  const testIds = new Set(problem.tests.map((test) => test.id));
  const subtaskById = new Map(problem.subtasks.map((subtask) => [subtask.id, subtask]));

  // 成员关系只认一个来源（subtask.tests）；只有当它没写时，才用测试点上的 subtask 字段补。
  for (const subtask of problem.subtasks) {
    if (subtask.tests.length > 0) {
      continue;
    }
    subtask.tests = problem.tests
      .filter((test) => test.subtask === subtask.id)
      .map((test) => test.id);
    if (subtask.tests.length === 0) {
      issues.add(
        `子任务 "${subtask.id}" 没有任何测试点：在它的 tests 里列出测试点 id，` +
          `或在测试点的 subtask 字段里写上 "${subtask.id}"`,
      );
    }
  }

  for (const subtask of problem.subtasks) {
    for (const testId of subtask.tests) {
      if (!testIds.has(testId)) {
        issues.add(`子任务 "${subtask.id}" 引用了不存在的测试点 "${testId}"`);
      }
    }
  }

  for (const test of problem.tests) {
    if (test.subtask === undefined) {
      continue;
    }
    const owner = subtaskById.get(test.subtask);
    if (owner === undefined) {
      issues.add(`测试点 "${test.id}" 的 subtask 字段指向不存在的子任务 "${test.subtask}"`);
      continue;
    }
    if (!owner.tests.includes(test.id)) {
      issues.add(
        `测试点 "${test.id}" 说自己属于子任务 "${owner.id}"，但那个子任务的 tests 里没有它——两边要一致`,
      );
    }
  }

  try {
    topoOrderSubtasks(problem.subtasks);
  } catch (err) {
    issues.add(err instanceof Error ? err.message : String(err));
  }
}

function serializeProblem(problem: Problem): Record<string, unknown> {
  // 先摊开 _raw 再覆盖已知字段：原文件里被改过的旧值不会盖掉新值，未知字段也不会丢（SPEC §6.5）。
  return {
    ...(problem._raw ?? {}),
    version: PROBLEM_JSON_VERSION,
    id: problem.id,
    name: problem.name,
    type: problem.type,
    limits: problem.limits,
    comparator: problem.comparator,
    subtasks: problem.subtasks,
    tests: problem.tests,
    ...(problem.sourceDir === undefined ? {} : { sourceDir: problem.sourceDir }),
    ...(problem.answerDir === undefined ? {} : { answerDir: problem.answerDir }),
  };
}
