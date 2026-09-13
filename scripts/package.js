'use strict';

// 打包 VSIX：先做生产构建，再用 src/tools/vsix.ts 打成 VSIX。
//
// 为什么不用 vsce：它要联网安装，而这个项目的前提是「完全离线、零依赖」。
// 打包器只有几十行（VSIX 就是 ZIP），复用的是扩展自己的 ZIP 实现，不存在两套格式代码。
// vsix.ts 是 TypeScript，这里用 esbuild（已是开发依赖）临时打成一个 CJS 文件再 require。

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const esbuild = require('esbuild');

const root = path.resolve(__dirname, '..');

function build() {
  const result = spawnSync(process.execPath, ['esbuild.js', '--production'], {
    cwd: root,
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    throw new Error('生产构建失败（node esbuild.js --production）');
  }
}

function loadPacker() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verdict-pack-'));
  const outfile = path.join(dir, 'vsix.cjs');
  esbuild.buildSync({
    entryPoints: [path.join(root, 'src', 'tools', 'vsix.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    outfile,
    logLevel: 'warning',
  });
  return require(outfile);
}

async function main() {
  build();
  const { packageVsix } = loadPacker();
  const result = await packageVsix({ root });
  const kiloBytes = (result.bytes / 1024).toFixed(1);
  console.log(`已打包：${path.relative(root, result.outFile)}（${result.entries} 个文件，${kiloBytes}KB）`);
  console.log('安装：code --install-extension ' + path.relative(root, result.outFile));
}

main().catch((err) => {
  console.error(`打包失败：${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
