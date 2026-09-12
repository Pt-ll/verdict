import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  findTestsBesideSource,
  resolveTestFiles,
  scanTests,
} from '../src/core/problem/scan';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'verdict-scan-'));

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function makeDir(name: string, files: string[]): string {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  for (const file of files) {
    const target = path.join(dir, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, '');
  }
  return dir;
}

describe('scanTests', () => {
  it('识别多种命名约定并保持数字顺序', async () => {
    const dir = makeDir('naming', [
      '10.in',
      '10.out',
      '1.in',
      '1.out',
      '2.in',
      '2.ans',
      'test3.in',
      'test3.out',
      'sample4.in',
      'sample4.expected',
    ]);
    const tests = await scanTests(dir);
    expect(tests.map((t) => t.id)).toEqual(['1', '2', '10', 'sample4', 'test3']);
    expect(tests[1]).toMatchObject({ input: '2.in', answer: '2.ans' });
    expect(tests[3]).toMatchObject({ input: 'sample4.in', answer: 'sample4.expected' });
  });

  it('没有配对答案的 .in 会被忽略', async () => {
    const dir = makeDir('orphan', ['1.in', '1.out', '2.in']);
    const tests = await scanTests(dir);
    expect(tests.map((t) => t.id)).toEqual(['1']);
  });

  it('忽略隐藏文件与子目录', async () => {
    const dir = makeDir('hidden', ['.1.in', '.1.out', '2.in', '2.out']);
    fs.mkdirSync(path.join(dir, '3.in'), { recursive: true });
    const tests = await scanTests(dir);
    expect(tests.map((t) => t.id)).toEqual(['2']);
  });

  it('空目录与不存在的目录都返回空数组', async () => {
    const dir = makeDir('empty', []);
    expect(await scanTests(dir)).toEqual([]);
    expect(await scanTests(path.join(root, 'not-exist'))).toEqual([]);
  });
});

describe('findTestsBesideSource', () => {
  it('优先用与源文件同名的配对', async () => {
    const dir = makeDir('sibling', ['solve.cpp', 'solve.in', 'solve.out', '1.in', '1.out']);
    const found = await findTestsBesideSource(path.join(dir, 'solve.cpp'));
    expect(found?.dataDir).toBe(dir);
    expect(found?.tests.map((t) => t.id)).toEqual(['solve']);
  });

  it('没有同名配对时用 tests/ 目录', async () => {
    const dir = makeDir('with-tests', ['solve.cpp', 'tests/1.in', 'tests/1.out']);
    const found = await findTestsBesideSource(path.join(dir, 'solve.cpp'));
    expect(found?.dataDir).toBe(path.join(dir, 'tests'));
    expect(found?.tests.map((t) => t.id)).toEqual(['1']);
  });

  it('兜底用源文件所在目录', async () => {
    const dir = makeDir('flat', ['solve.cpp', '1.in', '1.out', '2.in', '2.out']);
    const found = await findTestsBesideSource(path.join(dir, 'solve.cpp'));
    expect(found?.dataDir).toBe(dir);
    expect(found?.tests).toHaveLength(2);
  });

  it('找不到任何测试数据时返回 null', async () => {
    const dir = makeDir('bare', ['solve.cpp']);
    expect(await findTestsBesideSource(path.join(dir, 'solve.cpp'))).toBeNull();
  });
});

describe('resolveTestFiles', () => {
  it('把相对文件名还原成绝对路径', () => {
    const location = { dataDir: path.join(root, 'resolve'), tests: [] };
    const resolved = resolveTestFiles(location, {
      id: '1',
      input: '1.in',
      answer: '1.out',
    });
    expect(resolved.inputPath).toBe(path.join(location.dataDir, '1.in'));
    expect(resolved.answerPath).toBe(path.join(location.dataDir, '1.out'));
  });
});
