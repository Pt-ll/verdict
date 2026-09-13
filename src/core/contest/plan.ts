import path from 'node:path';
import type { Contestant, Problem } from '../model';
import type { ContestPackage } from './contest';
import { findContestantSource } from './sources';

export interface ContestTask {
  contestant: Contestant;
  problem: Problem;
  /** 题目包根目录（judgeProblem 需要它来还原测试点路径）。 */
  problemRoot: string;
  /** 选手源码的绝对路径。 */
  source: string;
}

export interface ContestPlan {
  tasks: ContestTask[];
  /** 找不到源码的格子。这不是错误，而是「还没交」——榜单上就该是空的。 */
  missing: { contestant: string; problem: string }[];
}

/**
 * 规划整场比赛要评测什么：选手 × 题目，逐个找源码。
 *
 * 顺序固定（选手按 contest.json 的顺序，题目同理），这样进度显示、
 * 增量保存与「重跑一次结果一样」都成立。
 */
export async function planContest(pkg: ContestPackage): Promise<ContestPlan> {
  const tasks: ContestTask[] = [];
  const missing: { contestant: string; problem: string }[] = [];

  for (const contestant of pkg.contest.contestants) {
    for (const problem of pkg.contest.problems) {
      const problemRoot = pkg.problemDirs.get(problem.id);
      if (problemRoot === undefined) {
        // loadContest 已经拦过这种配置错误，这里只是防御。
        missing.push({ contestant: contestant.id, problem: problem.id });
        continue;
      }
      const source = await findContestantSource(pkg.rootDir, contestant, problem);
      if (source === null) {
        missing.push({ contestant: contestant.id, problem: problem.id });
        continue;
      }
      tasks.push({ contestant, problem, problemRoot, source });
    }
  }
  return { tasks, missing };
}

/** 由源码后缀推断语言（Submission.language）。 */
export function languageOf(source: string): string {
  const extension = path.extname(source).toLowerCase();
  if (extension === '.py') {
    return 'python';
  }
  if (['.cpp', '.cc', '.cxx', '.c'].includes(extension)) {
    return 'cpp';
  }
  return extension.replace('.', '') || 'unknown';
}
