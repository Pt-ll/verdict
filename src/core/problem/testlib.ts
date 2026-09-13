import * as path from 'node:path';
import { isFile } from '../../util/files';

export const TESTLIB_FILE = 'testlib.h';

/**
 * 找不到 testlib.h 时给用户看的话（SPEC §6.6）。
 *
 * 扩展不捆绑、也不联网下载：checker 编译不过时，直接照着这句话放文件就行，
 * 不然用户会陷在一堆「No such file or directory: testlib.h」里猜。
 */
export const TESTLIB_HINT =
  '没有找到 testlib.h。请把它放进题目包的 extra/ 目录（推荐：跟着题目包走，换台机器也能用），' +
  '或放进工作区 .verdict/testlib/，或在设置 verdict.testlibPath 里指定所在目录。';

/** 工作区里放 testlib.h 的约定位置（SPEC §6.6 的第 2 顺位）。 */
export function workspaceTestlibDir(workspaceRoot: string): string {
  return path.join(workspaceRoot, '.verdict', 'testlib');
}

/**
 * 按 SPEC §6.6 的顺序找 testlib.h 所在目录。
 *
 * 候选值可以是目录，也可以直接指向 testlib.h 这个文件（用户填设置时两种都会写）。
 * 顺序由调用方给出：题目包 extra/ → 工作区 .verdict/testlib/ → 用户设置。
 */
export async function resolveTestlibDir(
  candidates: (string | undefined)[],
): Promise<string | null> {
  for (const candidate of candidates) {
    if (candidate === undefined || candidate.length === 0) {
      continue;
    }
    const dir = path.extname(candidate).toLowerCase() === '.h' ? path.dirname(candidate) : candidate;
    if (await isFile(path.join(dir, TESTLIB_FILE))) {
      return dir;
    }
  }
  return null;
}
