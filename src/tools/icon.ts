import * as zlib from 'node:zlib';
import { crc32 } from '../core/zip';

// 用代码画扩展图标，而不是塞一张来路不明的图片：
// 图能重新生成、能 review、能改（颜色/尺寸都在下面几个常量里），而且不需要任何图形库——
// PNG 本身就是「zlib 压缩的像素行 + 几个块」，CRC32 我们写 ZIP 时已经有了。

/** 图标尺寸：VS Code 要求至少 128×128 的 PNG。 */
export const ICON_SIZE = 128;

/** 超采样倍数：边缘的平滑靠它，不然圆角和斜线全是锯齿。 */
const SUPERSAMPLE = 4;

const BADGE_INSET = 6;
const BADGE_RADIUS = 26;
/** 底色渐变：深靛蓝到亮蓝，和榜单报告用的是同一套颜色。 */
const TOP_COLOR = { r: 31, g: 62, b: 140 };
const BOTTOM_COLOR = { r: 31, g: 111, b: 235 };
const CHECK_COLOR = { r: 255, g: 255, b: 255 };
/** 对勾的三个折点（按 128 的坐标系给，画的时候按尺寸缩放）。 */
const CHECK_POINTS = [
  { x: 38, y: 67 },
  { x: 56, y: 85 },
  { x: 92, y: 47 },
];
const CHECK_WIDTH = 11;

interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

export function renderIcon(size = ICON_SIZE, supersample = SUPERSAMPLE): Buffer {
  const big = size * supersample;
  const scale = big / ICON_SIZE;
  const pixels = new Uint8Array(big * big * 4);

  for (let y = 0; y < big; y += 1) {
    for (let x = 0; x < big; x += 1) {
      const color = sample(x + 0.5, y + 0.5, scale);
      const index = (y * big + x) * 4;
      pixels[index] = color.r;
      pixels[index + 1] = color.g;
      pixels[index + 2] = color.b;
      pixels[index + 3] = color.a;
    }
  }

  const downsampled = downsample(pixels, big, size, supersample);
  return encodePng(size, size, downsampled);
}

/** 一个采样点的颜色：不在徽章里就透明，在对勾笔画里就白色，其余按纵向渐变。 */
function sample(x: number, y: number, scale: number): Rgba {
  const inset = BADGE_INSET * scale;
  const radius = BADGE_RADIUS * scale;
  const max = ICON_SIZE * scale - inset;

  if (!insideRoundedRect(x, y, inset, inset, max, max, radius)) {
    return { r: 0, g: 0, b: 0, a: 0 };
  }
  if (distanceToCheck(x, y, scale) <= (CHECK_WIDTH * scale) / 2) {
    return { ...CHECK_COLOR, a: 255 };
  }

  const ratio = Math.min(1, Math.max(0, (y - inset) / (max - inset)));
  return {
    r: Math.round(TOP_COLOR.r + (BOTTOM_COLOR.r - TOP_COLOR.r) * ratio),
    g: Math.round(TOP_COLOR.g + (BOTTOM_COLOR.g - TOP_COLOR.g) * ratio),
    b: Math.round(TOP_COLOR.b + (BOTTOM_COLOR.b - TOP_COLOR.b) * ratio),
    a: 255,
  };
}

function insideRoundedRect(
  x: number,
  y: number,
  left: number,
  top: number,
  right: number,
  bottom: number,
  radius: number,
): boolean {
  if (x < left || x > right || y < top || y > bottom) {
    return false;
  }
  // 只在四个角上做圆角判断，边上直接放行。
  const cornerX = x < left + radius ? left + radius : x > right - radius ? right - radius : x;
  const cornerY = y < top + radius ? top + radius : y > bottom - radius ? bottom - radius : y;
  const dx = x - cornerX;
  const dy = y - cornerY;
  return dx * dx + dy * dy <= radius * radius;
}

function distanceToCheck(x: number, y: number, scale: number): number {
  let best = Number.POSITIVE_INFINITY;
  for (let index = 0; index + 1 < CHECK_POINTS.length; index += 1) {
    const from = CHECK_POINTS[index];
    const to = CHECK_POINTS[index + 1];
    if (from === undefined || to === undefined) {
      continue;
    }
    best = Math.min(
      best,
      distanceToSegment(
        x,
        y,
        from.x * scale,
        from.y * scale,
        to.x * scale,
        to.y * scale,
      ),
    );
  }
  return best;
}

function distanceToSegment(
  x: number,
  y: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSquared = dx * dx + dy * dy;
  const ratio =
    lengthSquared === 0
      ? 0
      : Math.min(1, Math.max(0, ((x - ax) * dx + (y - ay) * dy) / lengthSquared));
  const px = ax + dx * ratio;
  const py = ay + dy * ratio;
  return Math.hypot(x - px, y - py);
}

/** 把 big×big 的图按 supersample 取平均，得到 size×size。 */
function downsample(
  pixels: Uint8Array,
  big: number,
  size: number,
  supersample: number,
): Buffer {
  const out = Buffer.alloc(size * size * 4);
  const samples = supersample * supersample;

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < supersample; sy += 1) {
        for (let sx = 0; sx < supersample; sx += 1) {
          const index = ((y * supersample + sy) * big + (x * supersample + sx)) * 4;
          r += pixels[index] ?? 0;
          g += pixels[index + 1] ?? 0;
          b += pixels[index + 2] ?? 0;
          a += pixels[index + 3] ?? 0;
        }
      }
      const target = (y * size + x) * 4;
      out[target] = Math.round(r / samples);
      out[target + 1] = Math.round(g / samples);
      out[target + 2] = Math.round(b / samples);
      out[target + 3] = Math.round(a / samples);
    }
  }
  return out;
}

/** 手写 PNG：签名 + IHDR + IDAT（zlib 压缩的像素行）+ IEND，每行前面加一个过滤器字节。 */
export function encodePng(width: number, height: number, rgba: Buffer): Buffer {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (width * 4 + 1);
    raw[rowStart] = 0;
    rgba.copy(raw, rowStart + 1, y * width * 4, (y + 1) * width * 4);
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // 每通道 8 位
  header[9] = 6; // RGBA
  header[10] = 0;
  header[11] = 0;
  header[12] = 0;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}
