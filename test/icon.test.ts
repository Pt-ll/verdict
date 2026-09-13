import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

// 图标是选定的素材，不是生成出来的（源图在 assets/icon-source.png）。
// 这条测试只钉住 VS Code 对图标的硬要求，免得有人拿别的图替换、或者不小心让它退化。
describe('扩展图标', () => {
  const iconPath = path.join(__dirname, '..', 'media', 'icon.png');

  it('是 128×128 的 RGBA PNG（VS Code 的要求）', () => {
    const png = fs.readFileSync(iconPath);

    expect(png.subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
    expect(png.subarray(12, 16).toString('ascii')).toBe('IHDR');
    expect(png.readUInt32BE(16)).toBe(128);
    expect(png.readUInt32BE(20)).toBe(128);
    expect(png[24]).toBe(8);
    expect(png[25]).toBe(6);
    // 结尾块在：图是完整的，不是被截断的半张。
    expect(png.subarray(png.length - 8, png.length - 4).toString('ascii')).toBe('IEND');
  });

  it('体积正常（别把几 MB 的源图直接当成图标）', () => {
    const bytes = fs.statSync(iconPath).size;

    expect(bytes).toBeGreaterThan(1000);
    expect(bytes).toBeLessThan(200 * 1024);
  });

  it('源图留档在 assets/，改图标时有地方下手', () => {
    const source = path.join(__dirname, '..', 'assets', 'icon-source.png');

    expect(fs.existsSync(source)).toBe(true);
    expect(fs.readFileSync(source).subarray(1, 4).toString('ascii')).toBe('PNG');
  });
});
