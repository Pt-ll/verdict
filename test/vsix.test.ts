import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { extractZip, listZip } from '../src/core/zip';
import { manifestXml, packageVsix } from '../src/tools/vsix';

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verdict-vsix-'));

afterAll(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});

/** 造一个「像扩展根目录」的目录：package.json + dist + media + 几个不该进包的东西。 */
function makeExtensionRoot(): string {
  const root = path.join(workDir, 'ext');
  const write = (relative: string, text: string): void => {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, text);
  };
  write(
    'package.json',
    JSON.stringify({
      name: 'verdict',
      displayName: 'Verdict · VSCode 评测系统',
      description: '本地评测系统',
      version: '9.9.9',
      publisher: 'verdict-dev',
      engines: { vscode: '^1.95.0' },
      categories: ['Testing', 'Other'],
      keywords: ['judge'],
    }),
  );
  write('dist/extension.js', '// 打包产物\n');
  write('dist/extension.js.map', '{"version":3}\n');
  write('dist/verdict-0.0.1.vsix', '上一次的包，不该套娃\n');
  write('media/icon.png', 'not-really-a-png');
  write('README.md', '# Verdict\n');
  write('.DS_Store', 'junk');
  write('src/extension.ts', '// 源码不该进包\n');

  return root;
}

describe('packageVsix', () => {
  it('打出的包里有清单、内容类型与扩展文件', async () => {
    const root = makeExtensionRoot();

    const result = await packageVsix({ root });
    const names = listZip(fs.readFileSync(result.outFile)).map((entry) => entry.name);

    expect(result.name).toBe('verdict');
    expect(result.version).toBe('9.9.9');
    expect(names).toContain('extension.vsixmanifest');
    expect(names).toContain('[Content_Types].xml');
    expect(names).toContain('extension/package.json');
    expect(names).toContain('extension/dist/extension.js');
    expect(names).toContain('extension/media/icon.png');
    expect(names).toContain('extension/README.md');
  });

  it('源码、开发 sourcemap、系统垃圾文件与上一次的包都不进 VSIX', async () => {
    const root = makeExtensionRoot();

    const result = await packageVsix({ root });
    const names = listZip(fs.readFileSync(result.outFile)).map((entry) => entry.name);

    expect(names.some((name) => name.endsWith('.map'))).toBe(false);
    expect(names.some((name) => name.endsWith('.vsix'))).toBe(false);
    expect(names.some((name) => name.includes('.DS_Store'))).toBe(false);
    expect(names.some((name) => name.startsWith('extension/src/'))).toBe(false);
  });

  it('清单里的标识与引擎要求来自 package.json', async () => {
    const root = makeExtensionRoot();

    const result = await packageVsix({ root });
    const manifest = extractZip(fs.readFileSync(result.outFile))
      .find((entry) => entry.name === 'extension.vsixmanifest')
      ?.data.toString('utf8');

    expect(manifest).toContain('Id="verdict"');
    expect(manifest).toContain('Version="9.9.9"');
    expect(manifest).toContain('Publisher="verdict-dev"');
    expect(manifest).toContain('Value="^1.95.0"');
    // 安装器靠这一行找到扩展清单；写错了会装不上。
    expect(manifest).toContain('Path="extension/package.json"');
  });
});

describe('manifestXml', () => {
  it('把 XML 特殊字符转义掉（扩展名里带 & 也不能把清单写坏）', () => {
    const xml = manifestXml({ name: 'a&b<c', version: '1.0.0', publisher: 'p"q' });

    expect(xml).toContain('Id="a&amp;b&lt;c"');
    expect(xml).toContain('Publisher="p&quot;q"');
  });
});
