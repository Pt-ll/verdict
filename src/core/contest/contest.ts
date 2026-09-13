import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Contest, Contestant, Problem } from '../model';
import { loadProblem } from '../problem/package';
import { SOURCE_EXTENSIONS } from './sources';
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
/** 选手源码目录：里面每个含源码的子目录都会被自动当成一名选手（见 scanPlayerFolders）。 */
export const PLAYERS_DIR = 'players';
export const CONTEST_JSON_VERSION = 1;

export interface ContestPackage {
  contest: Contest;
  /** 工作区根目录，也就是 .verdict 所在的那一层。 */
  rootDir: string;
  /** .verdict 目录。 */
  verdictDir: string;
  /** 题目 id -> 题目包根目录（.verdict/problems/<id>）。 */
  problemDirs: Map<string, string>;
  /**
   * 由 players/ 自动发现、没有写进 contest.json 的选手 id。
   *
   * 记着它只是为了让 saveContest 不把它们写回文件：自动发现是「读的时候顺手算出来」的，
   * 不该因为改了一道题就把它们变成用户配置的一部分。
   */
  autoContestants: string[];
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

  // problems 允许为空：刚建出来的比赛就是这样（先建比赛、再加题）。以前这里当成配置错误，
  // 后果是「新建比赛之后整条比赛链路都打不开」——面板空白，新建题目也加不进比赛。
  const problemIds = readStringArray(raw.problems, 'problems', issues);
  const configured = readContestants(raw.contestants, issues);
  const { problems, problemDirs } = await loadProblems(resolved, problemIds, issues);

  // players/ 下的目录自动算选手：程序放进去就能出现在榜单与整场评测里，不必手写 contestants。
  // contest.json 里显式写过的以它为准（可以自定义显示名与目录）。
  const known = new Set(configured.map((item) => item.id));
  const discovered = (await scanPlayerFolders(resolved)).filter((item) => !known.has(item.id));

  issues.throwIfAny(file);

  return {
    contest: {
      id,
      title,
      problems,
      contestants: [...configured, ...discovered],
      maxRejudge,
      _raw: raw,
    },
    rootDir: resolved,
    verdictDir,
    problemDirs,
    autoContestants: discovered.map((item) => item.id),
  };
}

/** 只写 contest.json：题目包、数据与选手源码都不归这个函数管（SPEC §5.8 的同一条规矩）。 */
export async function saveContest(pkg: ContestPackage): Promise<void> {
  const file = contestPath(pkg.rootDir);
  // 自动发现的选手不写回文件：它们随时能从 players/ 重新算出来，
  // 写进去只会让「改了一道题」顺带变成一次选手列表的改动。
  const auto = new Set(pkg.autoContestants);
  const contest = {
    ...pkg.contest,
    contestants: pkg.contest.contestants.filter((item) => !auto.has(item.id)),
  };
  const text = `${JSON.stringify(serializeContest(contest), null, 2)}\n`;
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  await fs.promises.writeFile(file, text, 'utf8');
}

function readContestants(raw: unknown, issues: ConfigIssues): Contestant[] {
  if (raw === undefined) {
    // 不写也合法：players/ 下的目录会被自动当成选手（见 scanPlayerFolders）。
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

/**
 * 扫 players/ 下的一级目录，把「里面有源码的目录」当作选手。
 *
 * 这是「我只把程序放进 players/」这条要求的落点：不必去写 contest.json 的 contestants。
 * id 与显示名都取目录名，顺序按数字感知排序（1、2、10），与显式配置的选手合起来用。
 */
export async function scanPlayerFolders(rootDir: string): Promise<Contestant[]> {
  const dir = path.join(rootDir, PLAYERS_DIR);
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    // 没有 players/ 目录不是错误，就是不打算用这条约定。
    return [];
  }

  const found: Contestant[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) {
      continue;
    }
    // 空目录不算选手：建了个文件夹但还没放程序，不该在榜单上凭空多出一行。
    if (!(await hasSourceFile(path.join(dir, entry.name), 0))) {
      continue;
    }
    found.push({
      id: entry.name,
      name: entry.name,
      folder: toPosixRelative(path.join(PLAYERS_DIR, entry.name)),
    });
  }
  return found.sort((left, right) => left.id.localeCompare(right.id, 'en', { numeric: true }));
}

/** 目录里（递归，最多 3 层）有没有源码文件。 */
async function hasSourceFile(dir: string, depth: number): Promise<boolean> {
  if (depth > 3) {
    return false;
  }
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) {
      continue;
    }
    const target = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (await hasSourceFile(target, depth + 1)) {
        return true;
      }
      continue;
    }
    if (entry.isFile() && SOURCE_EXTENSIONS.includes(path.extname(entry.name).toLowerCase())) {
      return true;
    }
  }
  return false;
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
