import * as fs from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { ICON_SIZE, encodePng, renderIcon } from '../src/tools/icon';

/** 只解我们关心的部分：IHDR 的尺寸与 IDAT 的像素，够验证这张图是不是我们画的那张。 */
function decodePng(png: Buffer): { width: number; height: number; pixels: Buffer } {
  expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));

  let cursor = 8;
  let width = 0;
  let height = 0;
  const idat: Buffer[] = [];
  for (;;) {
    const length = png.readUInt32BE(cursor);
    const type = png.subarray(cursor + 4, cursor + 8).toString('ascii');
    const data = png.subarray(cursor + 8, cursor + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      expect(data[8]).toBe(8); // 每通道 8 位
      expect(data[9]).toBe(6); // RGBA
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    cursor += 12 + length;
  }

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const pixels = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    expect(raw[y * (width * 4 + 1)]).toBe(0); // 每行一个过滤器字节，图省事都用 0
    raw.copy(pixels, y * width * 4, y * (width * 4 + 1) + 1, (y + 1) * (width * 4 + 1));
  }
  return { width, height, pixels };
}

function pixelAt(pixels: Buffer, width: number, x: number, y: number): number[] {
  const index = (y * width + x) * 4;
  return [pixels[index] ?? 0, pixels[index + 1] ?? 0, pixels[index + 2] ?? 0, pixels[index + 3] ?? 0];
}

describe('扩展图标', () => {
  it('是 128×128 的 RGBA PNG（VS Code 的最低要求）', () => {
    const { width, height } = decodePng(renderIcon());

    expect(width).toBe(ICON_SIZE);
    expect(height).toBe(ICON_SIZE);
  });

  it('四角透明、徽章是蓝的、对勾是白的', () => {
    const { width, pixels } = decodePng(renderIcon());

    // 圆角之外是透明的：图标放在深色/浅色主题上都好看，靠的就是这一点。
    expect(pixelAt(pixels, width, 0, 0)[3]).toBe(0);

    // 左上角内侧：渐变的上半部分，深靛蓝。
    const badge = pixelAt(pixels, width, 24, 24);
    expect(badge[3]).toBe(255);
    expect(badge[2]).toBeGreaterThan(badge[0]);

    // 对勾笔画上（折点附近）应当是白的。
    const check = pixelAt(pixels, width, 56, 85);
    expect(check[0]).toBeGreaterThan(200);
    expect(check[1]).toBeGreaterThan(200);
    expect(check[2]).toBeGreaterThan(200);
  });

  it('media/icon.png 与生成器同步（改了生成器就要重新跑 scripts/icon.js）', () => {
    const onDisk = fs.readFileSync(path.join(__dirname, '..', 'media', 'icon.png'));

    expect(onDisk.equals(renderIcon())).toBe(true);
  });
});

describe('encodePng', () => {
  it('写出的是一个结构完整的 PNG（能被 zlib 解回像素）', () => {
    const rgba = Buffer.alloc(4 * 4 * 4, 0x7f);
    const png = encodePng(4, 4, rgba);

    const { width, height, pixels } = decodePng(png);
    expect([width, height]).toEqual([4, 4]);
    expect(pixelAt(pixels, width, 1, 1)).toEqual([0x7f, 0x7f, 0x7f, 0x7f]);
  });
});
