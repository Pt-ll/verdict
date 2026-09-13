import * as fs from 'node:fs';

/**
 * 读文件；不存在或读不了时返回 null。
 *
 * 测试数据缺失是评测里很常见的情况（数据没准备好、路径写错），
 * 调用方需要把它变成一句「读不到哪个文件」的结论，而不是抛异常中断整场评测。
 */
export async function readFileOrNull(target: string): Promise<Buffer | null> {
  try {
    return await fs.promises.readFile(target);
  } catch {
    return null;
  }
}

/** 存在且是普通文件才为 true（目录、不存在的路径都是 false）。 */
export async function isFile(target: string): Promise<boolean> {
  try {
    return (await fs.promises.stat(target)).isFile();
  } catch {
    return false;
  }
}
