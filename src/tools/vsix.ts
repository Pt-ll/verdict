import * as fs from 'node:fs';
import * as path from 'node:path';
import { createZip, type ZipEntry } from '../core/zip';

/**
 * 把扩展打包成 VSIX。
 *
 * VSIX 本质就是一个 ZIP：`[Content_Types].xml` + `extension.vsixmanifest` + `extension/**`。
 * 这里用自己写的 ZIP 打包器（core/zip.ts），于是打包不需要任何第三方工具——
 * `vsce` 要联网安装，而这个项目的前提是「完全离线、零依赖」。
 *
 * 放在 src/tools/ 而不是 src/core/：它是构建工具，不会被打进扩展本体
 * （esbuild 只从 src/extension.ts 出发打包，不会带上它）。
 */

/** 打进 VSIX 的东西。够跑就行：源码、测试、样例数据都不该进去。 */
const INCLUDED = [
  'package.json',
  'dist',
  'media',
  'README.md',
  'CHANGELOG.md',
  'LICENSE',
  'LICENSE.txt',
] as const;

interface ManifestJson {
  name: string;
  displayName?: string;
  description?: string;
  version: string;
  publisher?: string;
  engines?: { vscode?: string };
  categories?: string[];
  keywords?: string[];
}

export interface VsixOptions {
  /** 扩展根目录（含 package.json）。 */
  root: string;
  /** 输出文件；缺省 dist/<name>-<version>.vsix。 */
  outFile?: string;
}

export interface VsixResult {
  outFile: string;
  entries: number;
  bytes: number;
  name: string;
  version: string;
}

export async function packageVsix(options: VsixOptions): Promise<VsixResult> {
  const root = path.resolve(options.root);
  const manifest = JSON.parse(
    await fs.promises.readFile(path.join(root, 'package.json'), 'utf8'),
  ) as ManifestJson;

  const entries: ZipEntry[] = [
    { name: 'extension.vsixmanifest', data: Buffer.from(manifestXml(manifest), 'utf8') },
    { name: '[Content_Types].xml', data: Buffer.from(CONTENT_TYPES, 'utf8') },
  ];
  for (const item of INCLUDED) {
    entries.push(...(await collect(root, item, 'extension')));
  }

  const zip = createZip(entries);
  const outFile =
    options.outFile ?? path.join(root, 'dist', `${manifest.name}-${manifest.version}.vsix`);
  await fs.promises.mkdir(path.dirname(outFile), { recursive: true });
  await fs.promises.writeFile(outFile, zip);

  return {
    outFile,
    entries: entries.length,
    bytes: zip.length,
    name: manifest.name,
    version: manifest.version,
  };
}

/** 递归收集；路径在包内一律用 '/'，且统一带上 extension/ 前缀（VSIX 的约定）。 */
async function collect(root: string, relative: string, prefix: string): Promise<ZipEntry[]> {
  const target = path.join(root, ...relative.split('/'));
  const info = await statOrNull(target);
  if (info === null) {
    return [];
  }

  if (info.isFile()) {
    return [{ name: `${prefix}/${relative}`, data: await fs.promises.readFile(target) }];
  }
  if (!info.isDirectory()) {
    return [];
  }

  const entries: ZipEntry[] = [];
  for (const item of await fs.promises.readdir(target, { withFileTypes: true })) {
    if (item.name.startsWith('.')) {
      // .DS_Store 之类不进包；点文件在扩展里也没有用处。
      continue;
    }
    if (item.name.endsWith('.map')) {
      // 开发用的 sourcemap 不进生产包：它体积最大，而且开发构建留下的那份很可能
      // 与这次打进去的代码对不上——错误的 sourcemap 比没有 sourcemap 更糟。
      continue;
    }
    if (item.name.endsWith('.vsix')) {
      // 输出就写在 dist/ 下：不跳过的话会把上一次的包打进这一次的包里（套娃）。
      continue;
    }
    entries.push(...(await collect(root, `${relative}/${item.name}`, prefix)));
  }
  return entries;
}

export function manifestXml(manifest: ManifestJson): string {
  const categories = (manifest.categories ?? []).join(',');
  const tags = (manifest.keywords ?? []).join(',');
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011">',
    '  <Metadata>',
    `    <Identity Language="en-US" Id="${escapeXml(manifest.name)}" Version="${escapeXml(manifest.version)}" Publisher="${escapeXml(manifest.publisher ?? 'unknown')}" />`,
    `    <DisplayName>${escapeXml(manifest.displayName ?? manifest.name)}</DisplayName>`,
    `    <Description xml:space="preserve">${escapeXml(manifest.description ?? '')}</Description>`,
    `    <Categories>${escapeXml(categories)}</Categories>`,
    `    <Tags>${escapeXml(tags)}</Tags>`,
    '    <GalleryFlags>Public</GalleryFlags>',
    '    <Properties>',
    `      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="${escapeXml(manifest.engines?.vscode ?? '*')}" />`,
    '      <Property Id="Microsoft.VisualStudio.Code.ExtensionDependencies" Value="" />',
    '      <Property Id="Microsoft.VisualStudio.Code.ExtensionPack" Value="" />',
    '      <Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="workspace" />',
    '      <Property Id="Microsoft.VisualStudio.Code.LocalizedLanguages" Value="" />',
    '    </Properties>',
    '  </Metadata>',
    '  <Installation>',
    '    <InstallationTarget Id="Microsoft.VisualStudio.Code" />',
    '  </Installation>',
    '  <Dependencies />',
    '  <Assets>',
    '    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" />',
    '  </Assets>',
    '</PackageManifest>',
    '',
  ].join('\n');
}

const CONTENT_TYPES = [
  '<?xml version="1.0" encoding="utf-8"?>',
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
  '  <Default Extension="vsixmanifest" ContentType="text/xml" />',
  '  <Default Extension="json" ContentType="application/json" />',
  '  <Default Extension="js" ContentType="application/javascript" />',
  '  <Default Extension="map" ContentType="application/json" />',
  '  <Default Extension="md" ContentType="text/markdown" />',
  '  <Default Extension="txt" ContentType="text/plain" />',
  '  <Default Extension="png" ContentType="image/png" />',
  '  <Default Extension="svg" ContentType="image/svg+xml" />',
  '  <Default Extension="" ContentType="application/octet-stream" />',
  '</Types>',
  '',
].join('\n');

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function statOrNull(target: string): Promise<fs.Stats | null> {
  try {
    return await fs.promises.stat(target);
  } catch {
    return null;
  }
}
