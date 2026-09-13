import { describe, expect, it } from 'vitest';
import {
  bestSubmissions,
  canRejudge,
  computeStandings,
  summaryStats,
} from '../src/core/contest/standings';
import {
  DEFAULT_LIMITS,
  type Contest,
  type Problem,
  type ProblemResult,
  type Submission,
  type Verdict,
} from '../src/core/model';

function problemOf(id: string, points = 100): Problem {
  return {
    id,
    name: id,
    type: 'traditional',
    limits: { ...DEFAULT_LIMITS },
    comparator: { mode: 'default' },
    subtasks: [],
    tests: [{ id: '1', input: 'data/1.in', answer: 'data/1.out', points }],
  };
}

function contestOf(problemIds: string[], contestants: string[], maxRejudge = 2): Contest {
  return {
    id: 'demo',
    title: 'demo',
    maxRejudge,
    problems: problemIds.map((id) => problemOf(id)),
    contestants: contestants.map((id) => ({ id, name: id, folder: `players/${id}` })),
  };
}

function submissionOf(
  contestant: string,
  problem: string,
  score: number,
  options: { maxScore?: number; rejudgeCount?: number; time?: string; verdict?: Verdict } = {},
): Submission {
  const maxScore = options.maxScore ?? 100;
  const verdict = options.verdict ?? (score >= maxScore ? 'AC' : 'WA');
  const result: ProblemResult = {
    problem,
    score,
    maxScore,
    cases: [
      {
        test: '1',
        verdict,
        score,
        timeMs: 10,
        memoryKb: 2048,
        exitCode: 0,
        signal: null,
        output: Buffer.alloc(0),
        answer: Buffer.alloc(0),
      },
    ],
    subtasks: [],
    elapsedMs: 12,
  };
  return {
    id: `${contestant}-${problem}-${score}`,
    contestant,
    problem,
    source: `/w/players/${contestant}/${problem}.cpp`,
    language: 'cpp',
    result,
    rejudgeCount: options.rejudgeCount ?? 0,
    time: options.time ?? '2026-01-01T00:00:00Z',
  };
}

describe('computeStandings', () => {
  it('按选手 × 题目铺开，总分与名次正确', () => {
    const contest = contestOf(['A', 'B'], ['alice', 'bob']);

    const standings = computeStandings(contest, [
      submissionOf('alice', 'A', 100),
      submissionOf('alice', 'B', 0, { verdict: 'WA' }),
      submissionOf('bob', 'A', 30),
      submissionOf('bob', 'B', 100),
    ]);

    expect(standings.cells.map((cell) => `${cell.contestant}/${cell.problem}=${cell.score}`)).toEqual([
      'alice/A=100',
      'alice/B=0',
      'bob/A=30',
      'bob/B=100',
    ]);
    expect(standings.cells[1]?.verdict).toBe('WA');
    expect(standings.totals).toEqual([
      { contestant: 'alice', score: 100 },
      { contestant: 'bob', score: 130 },
    ]);
    expect(standings.ranks).toEqual([
      { contestant: 'bob', rank: 1, score: 130 },
      { contestant: 'alice', rank: 2, score: 100 },
    ]);
  });

  it('同分并列名次且跳号（1、1、3）', () => {
    const contest = contestOf(['A'], ['alice', 'bob', 'carol']);

    const standings = computeStandings(contest, [
      submissionOf('alice', 'A', 100),
      submissionOf('bob', 'A', 100),
      submissionOf('carol', 'A', 50),
    ]);

    expect(standings.ranks).toEqual([
      { contestant: 'alice', rank: 1, score: 100 },
      { contestant: 'bob', rank: 1, score: 100 },
      { contestant: 'carol', rank: 3, score: 50 },
    ]);
  });

  it('同一格多次提交取最高分，同分取更早的', () => {
    const contest = contestOf(['A'], ['alice']);

    const standings = computeStandings(contest, [
      submissionOf('alice', 'A', 30, { time: '2026-01-03T00:00:00Z' }),
      submissionOf('alice', 'A', 70, { time: '2026-01-02T00:00:00Z' }),
    ]);

    expect(standings.cells[0]?.score).toBe(70);

    const earlier = submissionOf('alice', 'A', 50, { time: '2026-01-01T00:00:00Z' });
    const later = submissionOf('alice', 'A', 50, { time: '2026-01-05T00:00:00Z' });
    expect(bestSubmissions(contest, [later, earlier]).get(`alice\u0000A`)?.time).toBe(
      '2026-01-01T00:00:00Z',
    );
  });

  it('没提交过的格子是 0 分、判定为 null', () => {
    const contest = contestOf(['A', 'B'], ['alice']);

    const standings = computeStandings(contest, [submissionOf('alice', 'A', 100)]);

    expect(standings.cells[1]).toEqual({
      contestant: 'alice',
      problem: 'B',
      score: 0,
      verdict: null,
    });
  });
});

describe('canRejudge', () => {
  it('没到上限才允许重测', () => {
    const contest = contestOf(['A'], ['alice'], 2);

    expect(canRejudge(submissionOf('alice', 'A', 0, { rejudgeCount: 0 }), contest)).toBe(true);
    expect(canRejudge(submissionOf('alice', 'A', 0, { rejudgeCount: 1 }), contest)).toBe(true);
    expect(canRejudge(submissionOf('alice', 'A', 0, { rejudgeCount: 2 }), contest)).toBe(false);
  });
});

describe('summaryStats', () => {
  it('给出均分/最高/最低、各题通过率与测试点分布', () => {
    const contest = contestOf(['A', 'B'], ['alice', 'bob', 'carol']);

    const stats = summaryStats(contest, [
      submissionOf('alice', 'A', 100),
      submissionOf('alice', 'B', 100),
      submissionOf('bob', 'A', 60),
      submissionOf('bob', 'B', 0, { verdict: 'TLE' }),
      submissionOf('carol', 'A', 100),
    ]);

    expect(stats.scores).toEqual([
      { contestant: 'alice', score: 200 },
      { contestant: 'carol', score: 100 },
      { contestant: 'bob', score: 60 },
    ]);
    expect(stats.highest).toBe(200);
    expect(stats.lowest).toBe(60);
    expect(stats.average).toBe(120);

    // A：三个人都有提交，两人满分；B：两人提交，只有 alice 满分。
    expect(stats.problems).toEqual([
      { problem: 'A', accepted: 2, attempted: 3, averageScore: 86.7 },
      { problem: 'B', accepted: 1, attempted: 2, averageScore: 50 },
    ]);

    // 每个测试点一条记录，供时间/内存散点图使用（SPEC §4.7）。
    expect(stats.cases).toHaveLength(5);
    expect(stats.cases[0]).toMatchObject({ contestant: 'alice', problem: 'A', test: '1' });
  });

  it('一场空比赛不会崩，也不会给出负分', () => {
    const stats = summaryStats(contestOf(['A'], ['alice']), []);

    expect(stats).toMatchObject({ average: 0, highest: 0, lowest: 0 });
    expect(stats.problems).toEqual([{ problem: 'A', accepted: 0, attempted: 0, averageScore: 0 }]);
    expect(stats.cases).toEqual([]);
  });
});
