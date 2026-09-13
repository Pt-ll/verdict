import * as path from 'node:path';

/** target 是否在 root 里面（含 root 自身）。用于给「向上查找」划一条边界。 */
export function isInside(target: string, root: string): boolean {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** 把配置里写的 '/' 路径换成当前平台的写法（配置文件一律用 /，见 SPEC §6.3）。 */
export function toNativeRelative(value: string): string {
  return value.split('/').join(path.sep);
}

/** 反过来：把平台路径写成配置里通用的 '/' 形式。 */
export function toPosixRelative(value: string): string {
  return value.split(path.sep).join('/');
}
