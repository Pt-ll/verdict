'use strict';

// 生成扩展图标：node scripts/icon.js
// 图是画出来的，不是素材——改了 src/tools/icon.ts 里的常量重新跑一次就行。

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const esbuild = require('esbuild');

const root = path.resolve(__dirname, '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verdict-icon-'));
const outfile = path.join(dir, 'icon.cjs');

esbuild.buildSync({
  entryPoints: [path.join(root, 'src', 'tools', 'icon.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  outfile,
  logLevel: 'warning',
});

const { renderIcon, ICON_SIZE } = require(outfile);
const target = path.join(root, 'media', 'icon.png');
fs.mkdirSync(path.dirname(target), { recursive: true });
fs.writeFileSync(target, renderIcon());
console.log(`已生成 ${path.relative(root, target)}（${ICON_SIZE}×${ICON_SIZE}）`);
