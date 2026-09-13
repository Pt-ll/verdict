import type { ProblemResult } from '../model';

/**
 * 单个题目评测结果的 JSON（SPEC §5.9）。
 *
 * 输出与答案用 base64 而不是默认的 Buffer 序列化：后者是 `{"type":"Buffer","data":[...]}`，
 * 又长又难读，别的语言也解不出来。base64 一行一个字段，谁都认识。
 */
export function reportToJson(result: ProblemResult): string {
  return `${JSON.stringify(
    {
      ...result,
      cases: result.cases.map((item) => ({
        ...item,
        output: item.output.toString('base64'),
        answer: item.answer.toString('base64'),
      })),
    },
    null,
    2,
  )}\n`;
}
