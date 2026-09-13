import * as path from 'node:path';
import type { ComparatorConfig } from '../model';
import { isFile } from '../../util/files';
import { TESTLIB_HINT } from '../problem/testlib';
import { createComparator, type Comparator } from './compare';
import { prepareChecker, type CheckerContext } from './spj';

export interface PreparedComparator {
  comparator: Comparator;
  /** 需要告诉用户的一句话（例如「已编译 checker」），没有就不写。 */
  note?: string;
}

export interface PrepareOptions extends Omit<CheckerContext, 'includeDir'> {
  /** 题目包根目录：problem.json 里的 spj / interactor 路径都相对它。 */
  packageRoot: string;
  /** testlib.h 所在目录；null 表示没找到（不使用 testlib 的 checker 不受影响）。 */
  testlibDir: string | null;
}

// 为一场评测准备好比较器（SPEC §5.4 / §5.6）。
//
// default / line / real 是纯函数，直接返回；spj 要先编译 checker，所以这里是异步的。
// interactive 在下一步落地。准备失败返回 error 而不是抛异常：调用方要把「出题人配置有问题」
// 如实变成该测试点的 UKE，而不是让整场评测崩掉。
export async function prepareComparator(
  config: ComparatorConfig,
  options: PrepareOptions,
): Promise<PreparedComparator | { error: string }> {
  switch (config.mode) {
    case 'default':
    case 'line':
    case 'real':
      return { comparator: createComparator(config) };

    case 'spj': {
      if (config.spj === undefined || config.spj.length === 0) {
        return { error: 'comparator 是 spj 模式，但没有写 spj 字段（checker 源码路径）' };
      }
      const checkerPath = resolveInPackage(options.packageRoot, config.spj);
      if (!(await isFile(checkerPath))) {
        return { error: `找不到 checker：${checkerPath}` };
      }

      const prepared = await prepareChecker(checkerPath, {
        toolchain: options.toolchain,
        sandbox: options.sandbox,
        limits: options.limits,
        cacheDir: options.cacheDir,
        ...(options.testlibDir === null ? {} : { includeDir: options.testlibDir }),
      });
      if (!prepared.ok) {
        // 缺 testlib.h 是最常见的一种编译失败，这时把「该放哪儿」一并说清楚（SPEC §6.6）。
        const hint =
          options.testlibDir === null && prepared.message.includes('testlib.h')
            ? `\n${TESTLIB_HINT}`
            : '';
        return { error: `${prepared.message}${hint}` };
      }
      return {
        comparator: { config, compare: (input) => prepared.compare(input) },
        note: prepared.note,
      };
    }

    default:
      return { error: `比较方式 ${config.mode} 尚未实现` };
  }
}

/** problem.json 里的相对路径一律相对题目包根目录；写绝对路径也认。 */
export function resolveInPackage(packageRoot: string, relative: string): string {
  return path.isAbsolute(relative) ? relative : path.join(packageRoot, relative);
}
