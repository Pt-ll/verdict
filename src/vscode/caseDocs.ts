import * as vscode from 'vscode';
import type { CaseResult } from '../core/model';

/** 虚拟文档的 scheme（SPEC §4.6）。 */
export const VERDICT_SCHEME = 'verdict';

type CaseKind = 'output' | 'answer';

/** 单个虚拟文档的长度上限；超出部分截断。输出上限虽然有 outputKb 兜底，
 *  但连跑几十个测试点时全量留着会白占内存。 */
const MAX_CHARS = 512 * 1024;

/** 同时保留的文档数上限，超出就丢最旧的（最坏情况下也就几十 MB，实际远小于此）。 */
const MAX_DOCUMENTS = 64;

/**
 * 评测结果的只读虚拟文档 + 原生 diff（SPEC §4.5 / §4.6）。
 *
 * 只保留最近一次评测：这是给人看的东西，不是数据源。下次评测直接清空，
 * 免得旧结果和新结果混在一起——那比看不到更糟。
 */
export class CaseDocumentStore implements vscode.TextDocumentContentProvider {
  private readonly content = new Map<string, string>();
  private readonly lastCases = new Map<string, CaseResult[]>();

  /** 注册 provider；由 context.subscriptions 负责释放。 */
  register(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
      vscode.workspace.registerTextDocumentContentProvider(VERDICT_SCHEME, this),
    );
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    const parsed = parseCaseUri(uri);
    return parsed === null ? '' : (this.content.get(keyOf(parsed)) ?? '');
  }

  /** 记下一轮评测的全部测试点，供 diff 与「另存」使用。 */
  record(problemId: string, cases: CaseResult[]): void {
    // 只替换同一个题目名下的旧结果：别的题目可能还有开着的 diff 标签页在看着它，
    // 一次性清空会让那些标签页变成空白。
    this.dropOwner(problemId);
    for (const item of cases) {
      this.put(problemId, item.test, 'output', item.output);
      this.put(problemId, item.test, 'answer', item.answer);
    }
    this.evictOldest();
    this.lastCases.set(problemId, cases);
  }

  /** 最近一次评测某个题目的逐点结果；「对比输出」用它列出可选的测试点。 */
  casesOf(problemId: string): CaseResult[] {
    return this.lastCases.get(problemId) ?? [];
  }

  /**
   * 打开「实际输出 ↔ 标准答案」的 diff。
   *
   * firstDiffLine 是 1 起的行号（比较器给的），而 TextDocumentShowOptions 收 0 起的行号。
   * 拿不到行号时退回第 1 行，至少让人看到两份输出。
   */
  async openDiff(problemId: string, testId: string, firstDiffLine?: number): Promise<void> {
    const line = Math.max(0, (firstDiffLine ?? 1) - 1);
    const selection = new vscode.Range(line, 0, line, 0);

    await vscode.commands.executeCommand(
      'vscode.diff',
      this.uriFor(problemId, testId, 'output'),
      this.uriFor(problemId, testId, 'answer'),
      `Verdict：测试点 ${testId} — 实际输出 ↔ 标准答案`,
      { selection, preview: false } satisfies vscode.TextDocumentShowOptions,
    );
  }

  uriFor(problemId: string, testId: string, kind: CaseKind): vscode.Uri {
    const path = ['', 'case', encodeURIComponent(problemId), encodeURIComponent(testId), kind].join(
      '/',
    );
    return vscode.Uri.from({ scheme: VERDICT_SCHEME, path });
  }

  private put(problemId: string, testId: string, kind: CaseKind, bytes: Buffer): void {
    // 展示前统一换行符：比较本来就忽略行尾空白与 CR，若原样渲染，
    // diff 会把「只有 \r\n 不同」的两行显示成不同，反倒误导人。
    const text = bytes.toString('utf8').replace(/\r\n?/g, '\n');
    const clipped = text.length > MAX_CHARS ? `${text.slice(0, MAX_CHARS)}\n…（已截断）` : text;
    this.content.set(keyOf({ problemId, testId, kind }), clipped);
  }

  private dropOwner(problemId: string): void {
    const prefix = `${problemId}\u0000`;
    for (const key of [...this.content.keys()]) {
      if (key.startsWith(prefix)) {
        this.content.delete(key);
      }
    }
  }

  private evictOldest(): void {
    // Map 的遍历顺序就是插入顺序，删最前面的就是删最旧的。
    while (this.content.size > MAX_DOCUMENTS) {
      const oldest = this.content.keys().next();
      if (oldest.done === true) {
        return;
      }
      this.content.delete(oldest.value);
    }
  }
}

interface CaseUri {
  problemId: string;
  testId: string;
  kind: CaseKind;
}

function keyOf(parts: CaseUri): string {
  return `${parts.problemId}\u0000${parts.testId}\u0000${parts.kind}`;
}

/** 解析 verdict://case/<problem>/<test>/<output|answer>；不是这个形状就返回 null。 */
function parseCaseUri(uri: vscode.Uri): CaseUri | null {
  const segments = uri.path.split('/').filter((segment) => segment.length > 0);
  if (segments.length !== 4 || segments[0] !== 'case') {
    return null;
  }
  const kind = segments[3];
  if (kind !== 'output' && kind !== 'answer') {
    return null;
  }
  return {
    problemId: decodeURIComponent(segments[1]),
    testId: decodeURIComponent(segments[2]),
    kind,
  };
}
