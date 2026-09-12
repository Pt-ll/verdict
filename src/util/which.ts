import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * 在 PATH 中查找可执行文件，返回绝对路径；找不到返回 null。
 *
 * 与直接 spawn 相比，这里的作用是拿到「到底用了哪个编译器」的绝对路径，
 * 便于在输出通道里明确告知用户。跨平台：Windows 会按 PATHEXT 补后缀。
 */
export function which(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const isWindows = process.platform === 'win32';
  const extensions = isWindows
    ? (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD')
        .split(';')
        .map((ext) => ext.trim())
        .filter((ext) => ext.length > 0)
    : [''];

  const looksLikePath =
    path.isAbsolute(command) || command.includes('/') || command.includes('\\');

  const candidates: string[] = [];
  if (looksLikePath) {
    candidates.push(...withExtensions(command, extensions));
  } else {
    const pathValue = env.PATH ?? env.Path ?? '';
    for (const dir of pathValue.split(path.delimiter)) {
      if (dir.length === 0) {
        continue;
      }
      candidates.push(...withExtensions(path.join(dir, command), extensions));
    }
  }

  for (const candidate of candidates) {
    try {
      if (!fs.statSync(candidate).isFile()) {
        continue;
      }
      if (!isWindows) {
        fs.accessSync(candidate, fs.constants.X_OK);
      }
      return candidate;
    } catch {
      // 不存在或不可执行：继续找下一个候选
    }
  }
  return null;
}

function withExtensions(file: string, extensions: string[]): string[] {
  const result: string[] = [];
  const lower = file.toLowerCase();
  for (const ext of extensions) {
    if (ext === '' || lower.endsWith(ext.toLowerCase())) {
      result.push(file);
    } else {
      result.push(file + ext);
    }
  }
  return result;
}
