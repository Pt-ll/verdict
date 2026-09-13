import { describe, expect, it } from 'vitest';
import { computeStandings } from '../src/core/contest/standings';
import { standingsToHtml } from '../src/core/report/html';
import { reportToJson } from '../src/core/report/json';
import { reportToMarkdown } from '../src/core/report/markdown';
import {
  DEFAULT_LIMITS,
  type Contest,
  type Problem,
  type ProblemResult,
  type Submission,
  type Verdict,
} from '../src/core/model';

function problemOf(id: string): Problem {
  return {
    id,
    name: id,
    type: 'traditional',
    limits: { ...DEFAULT_LIMITS },
    comparator: { mode: 'default' },
    subtasks: [],
    tests: [{ id: '1', input: 'data/1.in', answer: 'data/1.out', points: 100 }],
  };
}

function contestOf(contestants: { id: string; name: string }[]): Contest {
  return {
    id: 'demo',
    title: '演示赛',
    maxRejudge: 2,
    problems: [problemOf('A'), problemOf('B')],
    contestants: contestants.map((item) => ({ ...item, folder: `players/${item.id}` })),
  };
}

function submissionOf(
  contestant: string,
  problem: string,
  score: number,
  options: { message?: string; verdict?: Verdict } = {},
): Submission {
  const result: ProblemResult = {
    problem,
    score,
    maxScore: 100,
    cases: [
      {
        test: '1',
        verdict: options.verdict ?? (score >= 100 ? 'AC' : 'WA'),
        score,
        timeMs: 12,
        memoryKb: 2048,
        exitCode: 0,
        signal: null,
        ...(options.message === undefined ? {} : { message: options.message }),
        output: Buffer.from('4\n'),
        answer: Buffer.from('3\n'),
      },
    ],
    subtasks: [{ id: '1', score, maxScore: 100, status: score >= 100 ? 'full' : 'none' }],
    elapsedMs: 30,
  };
  return {
    id: `${contestant}-${problem}`,
    contestant,
    problem,
    source: `/w/players/${contestant}/${problem}.cpp`,
    language: 'cpp',
    verdict: options.verdict ?? (score >= 100 ? 'AC' : 'WA'),
    rejudgeCount: 0,
    time: '2026-09-13T00:00:00.000Z',
    result,
  };
}

describe('standingsToHtml', () => {
  const contest = contestOf([{ id: 'alice', name: 'Alice' }, { id: 'bob', name: 'Bob' }]);
  const submissions = [
    submissionOf('alice', 'A', 100),
    submissionOf('bob', 'A', 0, { message: '第 3 行不同' }),
  ];
  const standings = computeStandings(contest, submissions);

  function html(embedData = true): string {
    return standingsToHtml(contest, standings, { theme: 'ioi', embedData }, submissions);
  }

  it('包含标题、选手与题目', () => {
    const output = html();

    expect(output).toContain('演示赛');
    expect(output).toContain('Alice');
    expect(output).toContain('Bob');
    expect(output).toContain('>A</th>');
    expect(output).toContain('>B</th>');
  });

  it('自包含：没有任何外部资源或网络请求（离线双击就能看）', () => {
    const output = html();

    for (const forbidden of ['http://', 'https://', '<link', '<script src', '@import', 'url(', 'cdn']) {
      expect(output).not.toContain(forbidden);
    }
    // 但内联的样式与脚本必须有：不然就不是「自包含」而是「功能阉割」了。
    expect(output).toContain('<style>');
    expect(output).toContain('<script>');
  });

  it('满分与 0 分的格子颜色不同，没有被糊成一类', () => {
    const output = html();

    // 满分用主题里最深的色，0 分留白。
    expect(output).toContain('background:#1f6feb');
    expect(output).toContain('background:#ffffff');
  });

  it('内嵌了逐测试点数据，单元格可点开详情', () => {
    const output = html();
    const embedded = /<script type="application\/json" id="verdict-details">(.*?)<\/script>/s.exec(
      output,
    );

    expect(embedded).not.toBeNull();
    expect(output).toMatch(/<td[^>]*data-cell="alice/);
    const parsed = JSON.parse((embedded?.[1] ?? '').replace(/\\u003c/g, '<')) as {
      contestant: string;
      problem: string;
      cases: { test: string; verdict: string; message?: string }[];
    }[];
    const alice = parsed.find((item) => item.contestant === 'Alice' && item.problem === 'A');
    expect(alice?.cases[0]).toMatchObject({ test: '1', verdict: 'AC' });
    const bob = parsed.find((item) => item.contestant === 'Bob');
    expect(bob?.cases[0]?.message).toBe('第 3 行不同');
  });

  it('embedData=false 时退化成纯静态表格', () => {
    const output = html(false);

    expect(output).not.toContain('verdict-details');
    // 注意只看单元格标签上的属性：样式表里本来就有 td.cell[data-cell] 选择器。
    expect(output).not.toMatch(/<td[^>]*data-cell/);
    expect(output).toContain('演示赛');
  });

  it('选手名字里的 HTML 被转义，不会被当成标签执行', () => {
    const evil = contestOf([{ id: 'alice', name: '<script>alert(1)</script>' }]);
    const output = standingsToHtml(
      evil,
      computeStandings(evil, []),
      { theme: 'plain', embedData: false },
      [],
    );

    expect(output).not.toContain('<script>alert(1)</script>');
    expect(output).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });
});

describe('reportToMarkdown', () => {
  it('给出得分、逐测试点表与子任务表', () => {
    const result = submissionOf('alice', 'A', 30, { message: '第 1 行不同' }).result;
    if (result === undefined) {
      throw new Error('夹具坏了');
    }

    const markdown = reportToMarkdown(result);

    expect(markdown).toContain('得分 **30 / 100**');
    expect(markdown).toContain('| 1 | WA | 30 | 12ms | 2.0MB | 第 1 行不同 |');
    expect(markdown).toContain('| 子任务 | 得分 | 满分 | 状态 |');
    expect(markdown).toContain('| 1 | 30 | 100 | none |');
  });
});

describe('reportToJson', () => {
  it('输出与答案用 base64，能无损还原', () => {
    const result = submissionOf('alice', 'A', 0).result;
    if (result === undefined) {
      throw new Error('夹具坏了');
    }

    const parsed = JSON.parse(reportToJson(result)) as {
      cases: { output: string; answer: string }[];
    };
    const first = parsed.cases[0];

    expect(first?.output).toBe(Buffer.from('4\n').toString('base64'));
    expect(Buffer.from(first?.output ?? '', 'base64').toString()).toBe('4\n');
    expect(Buffer.from(first?.answer ?? '', 'base64').toString()).toBe('3\n');
  });
});
