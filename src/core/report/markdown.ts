import type { ProblemResult } from '../model';

/** 单个题目评测结果的 Markdown 摘要（SPEC §5.9），贴进 issue 或聊天窗口就能看。 */
export function reportToMarkdown(result: ProblemResult): string {
  const lines = [
    `# 题目 ${result.problem} 评测结果`,
    '',
    `得分 **${String(result.score)} / ${String(result.maxScore)}**，用时 ${String(result.elapsedMs)}ms。`,
    '',
    '| 测试点 | 判定 | 得分 | 用时 | 内存 | 说明 |',
    '| --- | --- | --- | --- | --- | --- |',
  ];

  for (const item of result.cases) {
    const memory = item.memoryKb > 0 ? `${(item.memoryKb / 1024).toFixed(1)}MB` : 'n/a';
    lines.push(
      `| ${item.test} | ${item.verdict} | ${String(item.score)} | ${String(item.timeMs)}ms | ${memory} | ${item.message ?? ''} |`,
    );
  }

  if (result.subtasks.length > 0) {
    lines.push('', '| 子任务 | 得分 | 满分 | 状态 |', '| --- | --- | --- | --- |');
    for (const item of result.subtasks) {
      lines.push(
        `| ${item.id} | ${String(item.score)} | ${String(item.maxScore)} | ${item.status} |`,
      );
    }
  }

  lines.push('');
  return lines.join('\n');
}
