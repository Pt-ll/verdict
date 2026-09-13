import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createZip, crc32, extractZip, isSafeName, listZip } from '../src/core/zip';
import { runProcess } from '../src/util/process';

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verdict-zip-'));

afterAll(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});

describe('createZip / extractZip', () => {
  it('文本、二进制、嵌套路径与空文件都能原样来回', () => {
    const entries = [
      { name: 'problem.json', data: Buffer.from('{"id":"A"}\n', 'utf8') },
      { name: 'data/1.in', data: Buffer.from('1 2\n', 'utf8') },
      { name: 'data/1.out', data: Buffer.from('3\n', 'utf8') },
      { name: 'extra/checker.cpp', data: Buffer.from('#include <cstdio>\n', 'utf8') },
      // 非 UTF-8 的字节要按字节保留，不能被当成文本处理（AGENTS 三平台约定第 4 条）。
      { name: 'data/binary.bin', data: Buffer.from([0x00, 0xff, 0x10, 0x80, 0x0a]) },
      { name: 'data/empty', data: Buffer.alloc(0) },
      { name: 'data/压缩率很低.txt', data: Buffer.from('a'.repeat(2000), 'utf8') },
    ];

    const zip = createZip(entries);
    const back = extractZip(zip);

    expect(back.map((item) => item.name)).toEqual(entries.map((item) => item.name));
    for (const [index, entry] of entries.entries()) {
      expect(back[index]?.data.equals(entry.data)).toBe(true);
    }
  });

  it('同一份输入产出同一份字节（时间戳固定，便于校验与复现）', () => {
    const entries = [{ name: 'a.txt', data: Buffer.from('你好', 'utf8') }];

    expect(createZip(entries).equals(createZip(entries))).toBe(true);
  });

  it('列目录不解压数据', () => {
    const zip = createZip([{ name: 'a.txt', data: Buffer.from('hello', 'utf8') }]);
    const listed = listZip(zip);

    expect(listed).toHaveLength(1);
    expect(listed[0]?.name).toBe('a.txt');
    expect(listed[0]?.size).toBe(5);
  });

  it('数据被改动过时当场报错（CRC 校验）', () => {
    const zip = createZip([{ name: 'a.txt', data: Buffer.from('hello world', 'utf8') }]);
    // 改动压缩数据里的一个字节：不能等到评测时才以「读出来的东西不对」的形式暴露。
    const corrupted = Buffer.from(zip);
    corrupted[40] = corrupted[40] ^ 0xff;

    expect(() => extractZip(corrupted)).toThrow();
  });

  it('不是 ZIP 时给出人话', () => {
    expect(() => extractZip(Buffer.from('这显然不是压缩包'))).toThrow(/不是.*ZIP/);
  });
});

describe('isSafeName：压缩包里的路径不能跳出目标目录', () => {
  it('拒绝绝对路径与 ..', () => {
    expect(isSafeName('data/1.in')).toBe(true);
    expect(isSafeName('a/b/c.txt')).toBe(true);
    expect(isSafeName('../evil.txt')).toBe(false);
    expect(isSafeName('data/../../evil.txt')).toBe(false);
    expect(isSafeName('/etc/passwd')).toBe(false);
    expect(isSafeName('C:\\windows\\system32\\evil.dll')).toBe(false);
    expect(isSafeName('')).toBe(false);
  });

  it('解压时拒绝带 .. 的条目', () => {
    const zip = createZip([{ name: '../evil.txt', data: Buffer.from('x') }]);

    expect(() => extractZip(zip)).toThrow(/不安全/);
  });
});

describe('与其他工具的兼容性', () => {
  it('系统 unzip 能认出我们写的压缩包（本机没有 unzip 时跳过）', async () => {
    const probe = await runProcess('unzip', ['-v'], 5000).catch(() => null);
    if (probe === null || probe.code !== 0) {
      return;
    }
    const probe2 = await runProcess('unzip', ['-h'], 5000).catch(() => null);
    if (probe2 === null) {
      return;
    }

    const zipPath = path.join(workDir, 'sample.zip');
    fs.writeFileSync(
      zipPath,
      createZip([
        { name: 'problem.json', data: Buffer.from('{"id":"A"}\n', 'utf8') },
        { name: 'data/1.in', data: Buffer.from('1 2\n', 'utf8') },
      ]),
    );

    const tested = await runProcess('unzip', ['-t', zipPath], 20_000);
    expect(tested.stdout + tested.stderr).toContain('No errors detected');

    const extracted = await runProcess('unzip', ['-d', path.join(workDir, 'out'), zipPath], 20_000);
    expect(extracted.code).toBe(0);
    expect(fs.readFileSync(path.join(workDir, 'out', 'data', '1.in'), 'utf8')).toBe('1 2\n');
  });
});

describe('crc32', () => {
  it('与已知值一致（"hello world" 的标准 CRC32）', () => {
    expect(crc32(Buffer.from('hello world', 'utf8'))).toBe(0x0d4a1185);
    expect(crc32(Buffer.alloc(0))).toBe(0);
  });
});
