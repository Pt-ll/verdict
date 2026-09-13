import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Contestant, Problem } from '../model';
import { isFile } from '../../util/files';
import { toNativeRelative } from '../../util/paths';

/** 目录里优先找这些文件；顺序固定，保证同一场比赛选到的源码可复现。 */
const PREFERRED_SOURCES = [
  'solve.cpp',
  'main.cpp',
  'solution.cpp',
  'solve.cc',
  'solve.cxx',
  'solve.py',
  'main.py',
];

const SOURCE_EXTENSIONS = ['.cpp', '.cc', '.cxx', '.c', '.py'];

/**
 * 找某个选手某道题的源码。
 *
 * 按「先精确后宽泛」的顺序试候选位置（全部相对工作区根目录）：
 *   1. problem.sourceDir（SPEC §6.3 的例子是 players 下的通配目录）里的通配符换成选手目录的最后一段；
 *   2. <选手目录>/<题目 id>：既是目录（里面找约定文件名）也可以直接是文件 <题目 id>.cpp；
 *   3. <选手目录> 本身（一个人一道题一个目录的简单布局）。
 * 每个候选先看是不是文件；是目录就按约定文件名找，再退化成「排序后第一个源码文件」。
 */
export async function findContestantSource(
  rootDir: string,
  contestant: Contestant,
  problem: Problem,
): Promise<string | null> {
  for (const candidate of sourceCandidates(rootDir, contestant, problem)) {
    const found = await pickSourceFile(candidate);
    if (found !== null) {
      return found;
    }
  }
  return null;
}

function sourceCandidates(
  rootDir: string,
  contestant: Contestant,
  problem: Problem,
): string[] {
  const folder = toNativeRelative(contestant.folder);
  const list: string[] = [];

  if (problem.sourceDir !== undefined) {
    // `*` 代表选手目录（SPEC §6.3 的例子是 "players/*/A"）。
    const replaced = problem.sourceDir.replace('*', path.basename(contestant.folder));
    list.push(path.join(rootDir, toNativeRelative(replaced)));
  }

  list.push(path.join(rootDir, folder, problem.id));
  for (const extension of SOURCE_EXTENSIONS) {
    list.push(path.join(rootDir, folder, `${problem.id}${extension}`));
  }
  list.push(path.join(rootDir, folder));
  return list;
}

async function pickSourceFile(target: string): Promise<string | null> {
  const info = await statOrNull(target);
  if (info === null) {
    return null;
  }
  if (info.isFile()) {
    return isSourceName(target) ? target : null;
  }
  if (!info.isDirectory()) {
    return null;
  }

  for (const name of PREFERRED_SOURCES) {
    const candidate = path.join(target, name);
    if (await isFile(candidate)) {
      return candidate;
    }
  }

  // 没有约定文件名就取排序后的第一个：结果必须稳定，否则「同一场比赛两次评测不一样」
  // 会成为最难查的那类问题。
  const entries = (await fs.promises.readdir(target)).filter(isSourceName).sort();
  const first = entries[0];
  return first === undefined ? null : path.join(target, first);
}

function isSourceName(target: string): boolean {
  return SOURCE_EXTENSIONS.includes(path.extname(target).toLowerCase());
}

async function statOrNull(target: string): Promise<fs.Stats | null> {
  try {
    return await fs.promises.stat(target);
  } catch {
    return null;
  }
}
