import type {
  Contest,
  ContestStats,
  Standings,
  StandingsCell,
  Submission,
  Verdict,
} from '../model';
import { summarizeVerdict } from '../model';

/** 「选手 × 题目」的唯一键：榜单取最优、提交记录合并都用它。 */
export function submissionKey(contestant: string, problem: string): string {
  return `${contestant}\u0000${problem}`;
}

function scoreOf(submission: Submission): number {
  return submission.result?.score ?? 0;
}

/**
 * 每个「选手 × 题目」只留最好的一次提交。
 *
 * OI 赛制取最高分（同分取更早的那次）：重测是改写同一条提交而不是新增，
 * 所以这里比的是分数加时间，而不是简单地取最后一次。
 */
export function bestSubmissions(
  _contest: Contest,
  submissions: Submission[],
): Map<string, Submission> {
  const best = new Map<string, Submission>();
  for (const submission of submissions) {
    const key = submissionKey(submission.contestant, submission.problem);
    const current = best.get(key);
    if (current === undefined || beats(submission, current)) {
      best.set(key, submission);
    }
  }
  return best;
}

function beats(candidate: Submission, current: Submission): boolean {
  if (scoreOf(candidate) !== scoreOf(current)) {
    return scoreOf(candidate) > scoreOf(current);
  }
  // 同分取更早的：先交的那份更能代表当时的水平，榜单也不会因为重测顺序而抖动。
  return candidate.time < current.time;
}

/** 榜单：cells 按「选手顺序 × 题目顺序」铺开，totals/ranks 按分数降序。 */
export function computeStandings(contest: Contest, submissions: Submission[]): Standings {
  const best = bestSubmissions(contest, submissions);

  const cells: StandingsCell[] = [];
  for (const contestant of contest.contestants) {
    for (const problem of contest.problems) {
      const submission = best.get(submissionKey(contestant.id, problem.id));
      cells.push({
        contestant: contestant.id,
        problem: problem.id,
        score: submission === undefined ? 0 : scoreOf(submission),
        verdict: cellVerdict(submission),
      });
    }
  }

  const totals = contest.contestants.map((contestant) => ({
    contestant: contestant.id,
    score: cells
      .filter((cell) => cell.contestant === contestant.id)
      .reduce((sum, cell) => sum + cell.score, 0),
  }));

  return { cells, totals, ranks: rankOf(totals) };
}

function cellVerdict(submission: Submission | undefined): Verdict | null {
  if (submission?.result === undefined) {
    return null;
  }
  return summarizeVerdict(submission.result.cases);
}

/** 并列名次：同分同名次且跳号（1、2、2、4）。 */
function rankOf(
  totals: { contestant: string; score: number }[],
): { contestant: string; rank: number; score: number }[] {
  const sorted = [...totals].sort(
    (left, right) =>
      right.score - left.score || left.contestant.localeCompare(right.contestant, 'en'),
  );

  let previousScore: number | null = null;
  let previousRank = 0;
  return sorted.map((entry, index) => {
    const rank = previousScore !== null && entry.score === previousScore ? previousRank : index + 1;
    previousScore = entry.score;
    previousRank = rank;
    return { contestant: entry.contestant, rank, score: entry.score };
  });
}

/** 重测次数上限（SPEC §5.7）：没到上限才允许重测。 */
export function canRejudge(submission: Submission, contest: Contest): boolean {
  return submission.rejudgeCount < contest.maxRejudge;
}

export function summaryStats(contest: Contest, submissions: Submission[]): ContestStats {
  const standings = computeStandings(contest, submissions);
  const scores = [...standings.totals].sort(
    (left, right) =>
      right.score - left.score || left.contestant.localeCompare(right.contestant, 'en'),
  );
  const values = scores.map((entry) => entry.score);

  const problems = contest.problems.map((problem) => {
    const best = bestSubmissions(
      contest,
      submissions.filter((submission) => submission.problem === problem.id),
    );
    const perContestant = [...best.values()];
    const accepted = perContestant.filter((submission) => {
      const result = submission.result;
      return result !== undefined && result.maxScore > 0 && result.score >= result.maxScore;
    }).length;
    return {
      problem: problem.id,
      accepted,
      attempted: perContestant.length,
      averageScore: round1(
        perContestant.length === 0
          ? 0
          : perContestant.reduce((sum, submission) => sum + scoreOf(submission), 0) /
              perContestant.length,
      ),
    };
  });

  return {
    scores,
    average: round1(values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length),
    highest: values.length === 0 ? 0 : Math.max(...values),
    lowest: values.length === 0 ? 0 : Math.min(...values),
    problems,
    cases: submissions.flatMap((submission) =>
      (submission.result?.cases ?? []).map((item) => ({
        contestant: submission.contestant,
        problem: submission.problem,
        test: item.test,
        timeMs: item.timeMs,
        memoryKb: item.memoryKb,
        verdict: item.verdict,
      })),
    ),
  };
}

/** 分数保留一位小数：均分 66.66666 那样的小数在榜单上只会碍眼。 */
function round1(value: number): number {
  return Math.round(value * 10) / 10;
}
