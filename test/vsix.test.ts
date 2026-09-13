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
      publisher: 'example-publisher',
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
  write('CHANGELOG.md', '# 更新日志\n');
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
    // 市场页面靠它渲染出「Changelog」标签页。
    expect(names).toContain('extension/CHANGELOG.md');
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
    expect(manifest).toContain('Publisher="example-publisher"');
    expect(manifest).toContain('Value="^1.95.0"');
    // 安装器靠这一行找到扩展清单；写错了会装不上。
    expect(manifest).toContain('Path="extension/package.json"');
    // 夹具里没有 LICENSE，这一行就不该出现。
    expect(manifest).not.toContain('<License>');
  });

  it('有 LICENSE 时把它打进包，并在清单里声明（市场页面靠它显示许可证）', async () => {
    const root = makeExtensionRoot();
    fs.writeFileSync(path.join(root, 'LICENSE'), 'MIT License\n\nCopyright (c) 2026 Pt-ll\n');

    const result = await packageVsix({ root });
    const zip = fs.readFileSync(result.outFile);
    const names = listZip(zip).map((entry) => entry.name);
    const manifest = extractZip(zip)
      .find((entry) => entry.name === 'extension.vsixmanifest')
      ?.data.toString('utf8');

    expect(names).toContain('extension/LICENSE');
    expect(manifest).toContain('<License>extension/LICENSE</License>');
  });
});

describe('manifestXml', () => {
  it('把 XML 特殊字符转义掉（扩展名里带 & 也不能把清单写坏）', () => {
    const xml = manifestXml({ name: 'a&b<c', version: '1.0.0', publisher: 'p"q' });

    expect(xml).toContain('Id="a&amp;b&lt;c"');
    expect(xml).toContain('Publisher="p&quot;q"');
  });
});

// 发布前 vsce 会核对这些东西，缺一样就报错或页面难看。本地先钉住，省得在发布那一刻才发现。
describe('发布前置条件', () => {
  const root = path.join(__dirname, '..');
  const manifest = JSON.parse(
    fs.readFileSync(path.join(root, 'package.json'), 'utf8'),
  ) as {
    name: string;
    publisher: string;
    version: string;
    engines: { vscode: string };
    icon: string;
    license: string;
    repository: { url: string };
  };

  it('publisher / name / version / engines.vscode 都在，且格式合规', () => {
    expect(manifest.publisher).toMatch(/^[A-Za-z0-9][A-Za-z0-9-]*$/);
    expect(manifest.name).toMatch(/^[a-z0-9-]+$/);
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(manifest.engines.vscode).toMatch(/^\^?\d+\.\d+\.\d+$/);
  });

  it('repository 写了（vsce 的硬要求），license 与 LICENSE 文件对得上', () => {
    expect(manifest.repository.url).toContain('github.com');
    expect(manifest.license).toBe('MIT');
    expect(fs.existsSync(path.join(root, 'LICENSE'))).toBe(true);
  });

  it('图标是 128×128，README 也在（市场页面的门面）', () => {
    const icon = fs.readFileSync(path.join(root, manifest.icon));

    expect(icon.readUInt32BE(16)).toBe(128);
    expect(icon.readUInt32BE(20)).toBe(128);
    expect(fs.existsSync(path.join(root, 'README.md'))).toBe(true);
  });

  it('CHANGELOG.md 在（发版记录，市场页面的 Changelog 标签页靠它）', () => {
    const changelog = path.join(root, 'CHANGELOG.md');
    expect(fs.existsSync(changelog)).toBe(true);
    // 最新一版写在最前面，市场页面读到的就是这一段。
    expect(fs.readFileSync(changelog, 'utf8')).toMatch(/^# .+\n\n## \d+\.\d+\.\d+ — \d{4}-\d{2}-\d{2}/);
  });
});
