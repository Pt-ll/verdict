import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Contest, Contestant, Problem } from '../model';
import { loadProblem } from '../problem/package';
import { isFile } from '../../util/files';
import { isInside, toPosixRelative } from '../../util/paths';
import {
  ConfigIssues,
  describe,
  isObject,
  messageOf,
  readJsonObject,
  readNonNegative,
  readString,
  readStringArray,
} from '../../util/json';

export const VERDICT_DIR = '.verdict';
export const CONTEST_FILE = 'contest.json';
export const PROBLEMS_DIR = 'problems';
export const CONTEST_JSON_VERSION = 1;

export interface ContestPackage {
  contest: Contest;
  /** 工作区根目录，也就是 .verdict 所在的那一层。 */
  rootDir: string;
  /** .verdict 目录。 */
  verdictDir: string;
  /** 题目 id -> 题目包根目录（.verdict/problems/<id>）。 */
  problemDirs: Map<string, string>;
}

export function contestPath(rootDir: string): string {
  return path.join(rootDir, VERDICT_DIR, CONTEST_FILE);
}

export function problemDir(rootDir: string, problemId: string): string {
  return path.join(rootDir, VERDICT_DIR, PROBLEMS_DIR, problemId);
}

/**
 * 从 startDir 向上找 .verdict/contest.json，返回工作区根目录，找不到返回 null。
 *
 * 与 findProblemRoot 一个思路：比赛文件固定放在工作区根的 .verdict 下，
 * 从当前文件往上找比让用户填路径可靠。给 stopDir 就只在它里面找。
 */
export async function findContestRoot(
  startDir: string,
  stopDir?: string,
): Promise<string | null> {
  let dir = path.resolve(startDir);
  const stop = stopDir === undefined ? null : path.resolve(stopDir);

  for (;;) {
    if (stop !== null && !isInside(dir, stop)) {
      return null;
    }
    if (await isFile(contestPath(dir))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      return null;
    }
    dir = parent;
  }
}

/** 读比赛：contest.json 里的题目 id 会被展开成真正的题目包（SPEC §6.1）。 */
export async function loadContest(rootDir: string): Promise<ContestPackage> {
  const resolved = path.resolve(rootDir);
  const verdictDir = path.join(resolved, VERDICT_DIR);
  const file = contestPath(resolved);
  const raw = await readJsonObject(file, (target) => fs.promises.readFile(target, 'utf8'));

  const issues = new ConfigIssues();
  const id = readString(raw.id) ?? path.basename(resolved);
  const title = readString(raw.title) ?? id;

  const maxRejudge = readNonNegative(raw.maxRejudge, 'maxRejudge', issues) ?? 0;
  if (!Number.isInteger(maxRejudge)) {
    issues.add(`maxRejudge 必须是整数，现在是 ${describe(raw.maxRejudge)}`);
  }

  const problemIds = readStringArray(raw.problems, 'problems', issues);
  if (problemIds.length === 0) {
    issues.add('problems 至少要写一道题（写题目 id，题目包放在 .verdict/problems/<id>/）');
  }
  const contestants = readContestants(raw.contestants, issues);
  const { problems, problemDirs } = await loadProblems(resolved, problemIds, issues);

  issues.throwIfAny(file);

  return {
    contest: { id, title, problems, contestants, maxRejudge, _raw: raw },
    rootDir: resolved,
    verdictDir,
    problemDirs,
  };
}

/** 只写 contest.json：题目包、数据与选手源码都不归这个函数管（SPEC §5.8 的同一条规矩）。 */
export async function saveContest(pkg: ContestPackage): Promise<void> {
  const file = contestPath(pkg.rootDir);
  const text = `${JSON.stringify(serializeContest(pkg.contest), null, 2)}\n`;
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  await fs.promises.writeFile(file, text, 'utf8');
}

function readContestants(raw: unknown, issues: ConfigIssues): Contestant[] {
  if (raw === undefined) {
    issues.add('contestants 是必填的（选手列表）');
    return [];
  }
  if (!Array.isArray(raw)) {
    issues.add(`contestants 必须是数组，现在是 ${describe(raw)}`);
    return [];
  }

  const contestants: Contestant[] = [];
  const seen = new Set<string>();
  raw.forEach((item, index) => {
    const where = `contestants[${index}]`;
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
      issues.add(`选手 id "${id}" 重复了`);
      return;
    }
    seen.add(id);

    const folder = readString(item.folder);
    if (folder === undefined) {
      issues.add(`${where}（选手 ${id}）缺少 folder，例如 "players/${id}"`);
      return;
    }
    contestants.push({ id, name: readString(item.name) ?? id, folder: toPosixRelative(folder) });
  });
  return contestants;
}

async function loadProblems(
  rootDir: string,
  ids: string[],
  issues: ConfigIssues,
): Promise<{ problems: Problem[]; problemDirs: Map<string, string> }> {
  const problems: Problem[] = [];
  const problemDirs = new Map<string, string>();
  const seen = new Set<string>();

  for (const id of ids) {
    if (seen.has(id)) {
      issues.add(`problems 里题目 id "${id}" 重复了`);
      continue;
    }
    seen.add(id);

    try {
      const pkg = await loadProblem(problemDir(rootDir, id));
      if (pkg.problem.id !== id) {
        // 不一致会让榜单、导出 HTML 与目录对不上号，属于必须当场纠正的配置错误。
        issues.add(
          `题目 "${id}" 的 problem.json 里写的是 id "${pkg.problem.id}"，两边要一致`,
        );
        continue;
      }
      problems.push(pkg.problem);
      problemDirs.set(id, pkg.rootDir);
    } catch (err) {
      // 题目包自己的报错很长（一次列全部问题），这里只留第一行并点出文件位置，
      // 用户打开那个 problem.json 就能看到完整清单。
      const first = messageOf(err).split('\n')[0];
      issues.add(`题目 "${id}" 无法加载：${first}`);
    }
  }
  return { problems, problemDirs };
}

function serializeContest(contest: Contest): Record<string, unknown> {
  // 与 problem.json 同样的策略：先摊开 _raw 再覆盖已知字段（SPEC §6.5）。
  return {
    ...(contest._raw ?? {}),
    version: CONTEST_JSON_VERSION,
    id: contest.id,
    title: contest.title,
    maxRejudge: contest.maxRejudge,
    problems: contest.problems.map((problem) => problem.id),
    contestants: contest.contestants,
  };
}
