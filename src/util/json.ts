/**
 * 读取手写 JSON 配置时的共用工具。
 *
 * 题目包（problem.json）与比赛（contest.json）都是给人手写的，校验就该按同一套规矩来：
 * 一次列全部问题、报错说清楚是哪个字段、非法值不静默修正。
 */
export class ConfigIssues {
  private readonly messages: string[] = [];

  add(message: string): void {
    this.messages.push(message);
  }

  get count(): number {
    return this.messages.length;
  }

  /** 有问题就抛出；文件路径写进出错信息，用户才知道该改哪个文件。 */
  throwIfAny(file: string): void {
    if (this.messages.length === 0) {
      return;
    }
    const detail = this.messages.map((message) => `  · ${message}`).join('\n');
    throw new Error(`${file} 有 ${this.messages.length} 处问题：\n${detail}`);
  }
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

export function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

export function readNonNegative(
  value: unknown,
  label: string,
  issues: ConfigIssues,
): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isNonNegativeNumber(value)) {
    issues.add(`${label} 必须是非负数，现在是 ${describe(value)}`);
    return undefined;
  }
  return value;
}

export function readStringArray(
  value: unknown,
  label: string,
  issues: ConfigIssues,
): string[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    issues.add(`${label} 必须是字符串数组，现在是 ${describe(value)}`);
    return [];
  }
  const result: string[] = [];
  for (const item of value) {
    const text = readString(item);
    if (text === undefined) {
      issues.add(`${label} 里有不是字符串的项：${describe(item)}`);
      continue;
    }
    result.push(text);
  }
  return result;
}

/** 把任意值描述成一句人话，用在报错信息里。 */
export function describe(value: unknown): string {
  if (value === undefined) {
    return '未填写';
  }
  if (value === null) {
    return 'null';
  }
  if (Array.isArray(value)) {
    return '数组';
  }
  switch (typeof value) {
    case 'object':
      return '对象';
    case 'string':
      return `"${value}"`;
    default:
      return String(value);
  }
}

/** 读一个 JSON 对象；文件不存在或格式不对时抛出的错误里带文件名。 */
export async function readJsonObject(
  file: string,
  readFile: (target: string) => Promise<string>,
): Promise<Record<string, unknown>> {
  let text: string;
  try {
    text = await readFile(file);
  } catch (err) {
    throw new Error(`读不到配置文件：${file}（${messageOf(err)}）`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`${file} 不是合法 JSON：${messageOf(err)}`);
  }
  if (!isObject(parsed)) {
    throw new Error(`${file} 的顶层必须是一个对象`);
  }
  return parsed;
}

export function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
