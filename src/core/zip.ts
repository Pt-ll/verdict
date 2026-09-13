import * as zlib from 'node:zlib';

export interface ZipEntry {
  /** 包内路径，一律用 '/' 分隔（ZIP 规范如此，与平台无关）。 */
  name: string;
  data: Buffer;
}

const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const END_OF_CENTRAL = 0x06054b50;
/** 文件名是 UTF-8（通用标志位第 11 位）：题目 id 里出现中文时不会被解成乱码。 */
const UTF8_NAMES = 0x0800;
/** 固定时间戳：1980-01-01 00:00。同一个输入产出同一份字节，便于校验与复现。 */
const DOS_DATE = 0x0021;
const DOS_TIME = 0;

const CRC_TABLE = ((): Uint32Array => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

export function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * 打包成 ZIP：只用 Node 内置的 zlib，不引任何压缩库（SPEC §6.5）。
 *
 * 压缩后反而变大时改用「存储」方式：小文件的压缩头比省下的字节还多。
 */
export function createZip(entries: ZipEntry[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const crc = crc32(entry.data);
    const deflated = zlib.deflateRawSync(entry.data, { level: 9 });
    const useDeflate = deflated.length < entry.data.length;
    const payload = useDeflate ? deflated : entry.data;
    const method = useDeflate ? 8 : 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_HEADER, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(UTF8_NAMES, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, name, payload);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(CENTRAL_HEADER, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(UTF8_NAMES, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);

    offset += local.length + name.length + payload.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(END_OF_CENTRAL, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralDirectory, end]);
}

export interface ZipDirectoryEntry {
  name: string;
  size: number;
  compressedSize: number;
  method: number;
}

/** 只读目录，不解压数据：用来在不信任来源的情况下先看一眼里面有什么。 */
export function listZip(zip: Buffer): ZipDirectoryEntry[] {
  return readCentralDirectory(zip).map((entry) => ({
    name: entry.name,
    size: entry.size,
    compressedSize: entry.compressedSize,
    method: entry.method,
  }));
}

/**
 * 解开 ZIP。
 *
 * 两道防线：包内路径不许跳出目标目录（zip 是别人给的，不能信），
 * 以及逐条校验 CRC（坏掉的压缩包要当场发现，而不是等到评测时报一堆看不懂的错）。
 */
export function extractZip(zip: Buffer): ZipEntry[] {
  return readCentralDirectory(zip).map((entry) => {
    if (!isSafeName(entry.name)) {
      throw new Error(`压缩包里的路径不安全，已拒绝：${entry.name}`);
    }

    const start = entry.localOffset + 30 + entry.nameLength + entry.extraLength;
    const raw = zip.subarray(start, start + entry.compressedSize);
    let data: Buffer;
    if (entry.method === 0) {
      data = Buffer.from(raw);
    } else if (entry.method === 8) {
      try {
        data = zlib.inflateRawSync(raw);
      } catch (err) {
        throw new Error(`解不开 ${entry.name}：${err instanceof Error ? err.message : String(err)}`);
      }
    } else {
      throw new Error(`${entry.name} 用了不支持的压缩方式（${String(entry.method)}）`);
    }

    if (data.length !== entry.size) {
      throw new Error(`${entry.name} 解出来的长度不对（期望 ${String(entry.size)}，实际 ${String(data.length)}）`);
    }
    if (crc32(data) !== entry.crc) {
      throw new Error(`${entry.name} 校验不过：压缩包可能已经损坏`);
    }
    return { name: entry.name, data };
  });
}

/** 路径不许是绝对的，也不许出现 `..`——否则解压会写到目标目录外面去。 */
export function isSafeName(name: string): boolean {
  const normalized = name.replace(/\\/g, '/');
  if (normalized.length === 0 || normalized.startsWith('/')) {
    return false;
  }
  if (/^[A-Za-z]:/.test(normalized)) {
    return false;
  }
  return !normalized.split('/').includes('..');
}

interface CentralEntry {
  name: string;
  method: number;
  crc: number;
  compressedSize: number;
  size: number;
  nameLength: number;
  extraLength: number;
  localOffset: number;
}

function readCentralDirectory(zip: Buffer): CentralEntry[] {
  const end = findEndOfCentral(zip);
  const count = zip.readUInt16LE(end + 10);
  let cursor = zip.readUInt32LE(end + 16);

  const entries: CentralEntry[] = [];
  for (let index = 0; index < count; index += 1) {
    if (zip.readUInt32LE(cursor) !== CENTRAL_HEADER) {
      throw new Error('压缩包的目录结构不对，可能在传输中损坏了');
    }
    const nameLength = zip.readUInt16LE(cursor + 28);
    const extraLength = zip.readUInt16LE(cursor + 30);
    const commentLength = zip.readUInt16LE(cursor + 32);
    entries.push({
      method: zip.readUInt16LE(cursor + 10),
      crc: zip.readUInt32LE(cursor + 16),
      compressedSize: zip.readUInt32LE(cursor + 20),
      size: zip.readUInt32LE(cursor + 24),
      nameLength,
      extraLength,
      localOffset: zip.readUInt32LE(cursor + 42),
      name: zip.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8'),
    });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function findEndOfCentral(zip: Buffer): number {
  // 结尾记录固定在最后 22 字节处，后面还可能有最多 64KB 的注释。
  const earliest = Math.max(0, zip.length - 22 - 0xffff);
  for (let index = zip.length - 22; index >= earliest; index -= 1) {
    if (zip.readUInt32LE(index) === END_OF_CENTRAL) {
      return index;
    }
  }
  throw new Error('这不是一个 ZIP 文件（找不到结尾记录）');
}
