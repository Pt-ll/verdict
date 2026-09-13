import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

// AGENTS 的两条硬约束：完全离线、运行时依赖为 0。
//
// 这种事值得让 CI 机械地检查，而不是靠每次写代码时记得——所以扫一遍源码。
// 注意别把 XML/SVG 的命名空间标识符（xmlns="http://..."、createElementNS('http://www.w3.org/2000/svg')
// 这类）当成网络调用：它们是格式规定的名字，永远不会被请求。
const FORBIDDEN_PATTERNS: { pattern: RegExp; why: string }[] = [
  { pattern: /\bfetch\s*\(/, why: '禁止 fetch' },
  { pattern: /\bXMLHttpRequest\b/, why: '禁止 XMLHttpRequest' },
  { pattern: /\bnew\s+WebSocket\b/, why: '禁止 WebSocket' },
  {
    pattern: /(?:require\(|from\s+)['"]node:(?:http|https|net|dns|tls|http2)['"]/,
    why: '禁止引入网络相关模块',
  },
];

function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    const target = path.join(dir, item.name);
    if (item.isDirectory()) {
      found.push(...sourceFiles(target));
      continue;
    }
    if (item.isFile() && item.name.endsWith('.ts')) {
      found.push(target);
    }
  }
  return found;
}

describe('完全离线（AGENTS 硬约束）', () => {
  it('源码里没有任何网络调用', () => {
    const files = sourceFiles(path.join(__dirname, '..', 'src'));
    expect(files.length).toBeGreaterThan(20);

    const offenders: string[] = [];
    for (const file of files) {
      const text = fs.readFileSync(file, 'utf8');
      for (const { pattern, why } of FORBIDDEN_PATTERNS) {
        if (pattern.test(text)) {
          offenders.push(`${path.relative(process.cwd(), file)}：${why}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it('运行时不依赖任何第三方包（dependencies 为空）', () => {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'),
    ) as { dependencies?: Record<string, string> };

    expect(Object.keys(manifest.dependencies ?? {})).toEqual([]);
  });
});
