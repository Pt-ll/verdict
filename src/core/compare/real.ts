import type { ComparatorConfig } from '../model';
import { display } from './default';
import type { CompareResult, ComparatorInput } from './compare';

const DEFAULT_EPS = 1e-6;

const WHITESPACE = new Set([0x20, 0x09, 0x0a, 0x0d, 0x0b, 0x0c]);
const NUMERIC = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
const INFINITY = /^[+-]?inf(inity)?$/;

type TokenValue =
  | { kind: 'nan' }
  | { kind: 'infinite'; sign: 1 | -1 }
  | { kind: 'finite'; value: number }
  | { kind: 'text'; text: string };

/**
 * 实数比较：按 token 逐个当作数值比较。
 *
 * 误差判据用 SPEC §5.4 给出的公式（绝对误差或相对误差满足其一即可）；
 * 该节正文写作「同时满足」，与紧随其后的公式矛盾，这里以公式为准。
 * 相对误差以答案侧为基准，避免用实际输出的量级去放大容忍度。
 */
export function compareReal(
  input: ComparatorInput,
  config: ComparatorConfig,
): CompareResult {
  const absEps = config.absEps ?? DEFAULT_EPS;
  const relEps = config.relEps ?? DEFAULT_EPS;

  const got = tokenize(input.output);
  const want = tokenize(input.answer);

  if (got.length !== want.length) {
    return {
      verdict: 'WA',
      scoreRatio: 0,
      detail: `数值个数不同：答案 ${want.length} 个，实际 ${got.length} 个`,
    };
  }

  for (let i = 0; i < want.length; i += 1) {
    if (equalsWithinEps(parseToken(got[i]), parseToken(want[i]), absEps, relEps)) {
      continue;
    }
    return {
      verdict: 'WA',
      scoreRatio: 0,
      detail: `第 ${i + 1} 个数值不同：答案 ${display(want[i])}，实际 ${display(got[i])}`,
    };
  }

  return {
    verdict: 'AC',
    scoreRatio: 1,
    detail: `实数比较通过（绝对误差 ${absEps}，相对误差 ${relEps}）`,
  };
}

/** 按空白字符切 token；与行比较一致，全程在字节上操作。 */
function tokenize(buffer: Buffer): Buffer[] {
  const tokens: Buffer[] = [];
  let start = -1;
  for (let i = 0; i < buffer.length; i += 1) {
    if (WHITESPACE.has(buffer[i])) {
      if (start >= 0) {
        tokens.push(buffer.subarray(start, i));
        start = -1;
      }
    } else if (start < 0) {
      start = i;
    }
  }
  if (start >= 0) {
    tokens.push(buffer.subarray(start));
  }
  return tokens;
}

/**
 * 把 token 归类。
 *
 * nan / inf 必须单独识别：Number('inf') 是 NaN，直接当数值处理会把
 * 「答案 inf、实际 1e9」这种明显不同的输出混进误差比较里。
 */
function parseToken(token: Buffer): TokenValue {
  const text = token.toString('utf8');
  const lower = text.toLowerCase();

  if (lower === 'nan' || lower === '+nan' || lower === '-nan') {
    return { kind: 'nan' };
  }
  if (INFINITY.test(lower)) {
    return { kind: 'infinite', sign: lower.startsWith('-') ? -1 : 1 };
  }
  if (NUMERIC.test(text)) {
    const value = Number(text);
    if (Number.isFinite(value)) {
      return { kind: 'finite', value };
    }
  }
  return { kind: 'text', text };
}

function equalsWithinEps(
  got: TokenValue,
  want: TokenValue,
  absEps: number,
  relEps: number,
): boolean {
  if (got.kind === 'nan' || want.kind === 'nan') {
    return got.kind === 'nan' && want.kind === 'nan';
  }
  if (got.kind === 'infinite' || want.kind === 'infinite') {
    return (
      got.kind === 'infinite' && want.kind === 'infinite' && got.sign === want.sign
    );
  }
  if (got.kind === 'finite' && want.kind === 'finite') {
    const diff = Math.abs(got.value - want.value);
    return diff <= absEps || diff <= relEps * Math.abs(want.value);
  }
  if (got.kind === 'text' && want.kind === 'text') {
    return got.text === want.text;
  }
  return false;
}
