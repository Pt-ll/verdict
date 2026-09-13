import type { CompareResult, ComparatorInput } from './compare';

/** 行尾空白字符：空格、制表符、CR。 */
const TRAILING_WHITESPACE = new Set([0x20, 0x09, 0x0d]);

/**
 * 按行比较，default 与 line 两种模式共用。
 *
 * 两种模式的判定完全一致，也都会带上首个不同行号：逐行走的时候顺手就算出来了，
 * 而 M2 的「WA 自动打开 diff 并跳过去」正需要它（SPEC §4.5 / §12）。
 * line 因此退化成 default 的显式写法，保留是为了兼容已有的 problem.json。
 *
 * 全程按字节处理而不是先 decode 成字符串：不同的非法字节序列都会被解码成同一个
 * U+FFFD，那样两份本来不同的输出会被判成相同。SPEC §10 要求非 UTF-8 数据不出错。
 */
export function compareLines(input: ComparatorInput): CompareResult {
  const actual = splitLines(input.output);
  const expected = splitLines(input.answer);
  const rowCount = Math.max(actual.length, expected.length);

  for (let i = 0; i < rowCount; i += 1) {
    const got = actual[i];
    const want = expected[i];
    if (got !== undefined && want !== undefined && got.equals(want)) {
      continue;
    }

    const lineNo = i + 1;
    const detail = describeLineDifference(got, want, lineNo);
    return { verdict: 'WA', scoreRatio: 0, detail, firstDiffLine: lineNo };
  }

  return { verdict: 'AC', scoreRatio: 1, detail: '输出一致' };
}

/** 按 \n 切行，去掉行尾空白与末尾空行，因此换行风格与尾随空白不影响判定。 */
function splitLines(buffer: Buffer): Buffer[] {
  const lines: Buffer[] = [];
  let start = 0;
  for (let i = 0; i < buffer.length; i += 1) {
    if (buffer[i] === 0x0a) {
      lines.push(trimLineEnd(buffer.subarray(start, i)));
      start = i + 1;
    }
  }
  if (start < buffer.length) {
    lines.push(trimLineEnd(buffer.subarray(start)));
  }

  while (lines.length > 0 && lines[lines.length - 1].length === 0) {
    lines.pop();
  }
  return lines;
}

function trimLineEnd(line: Buffer): Buffer {
  let end = line.length;
  while (end > 0 && TRAILING_WHITESPACE.has(line[end - 1])) {
    end -= 1;
  }
  return end === line.length ? line : line.subarray(0, end);
}

function describeLineDifference(
  got: Buffer | undefined,
  want: Buffer | undefined,
  lineNo: number,
): string {
  if (want === undefined) {
    return `第 ${lineNo} 行：答案没有这一行，实际输出 "${display(got)}"`;
  }
  if (got === undefined) {
    return `第 ${lineNo} 行：实际输出缺少这一行，答案 "${display(want)}"`;
  }
  return `第 ${lineNo} 行不同：答案 "${display(want)}"，实际 "${display(got)}"`;
}

export function display(buffer: Buffer | undefined, limit = 80): string {
  if (buffer === undefined) {
    return '<无>';
  }
  const text = buffer.toString('utf8').replace(/\r/g, '\\r');
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}
