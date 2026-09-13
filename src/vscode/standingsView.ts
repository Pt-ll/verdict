import * as vscode from 'vscode';
import type { ContestStats, Standings, Submission } from '../core/model';

export interface StandingsViewData {
  title: string;
  contestId: string;
  maxRejudge: number;
  contestants: { id: string; name: string }[];
  problems: { id: string; name: string }[];
  standings: Standings;
  stats: ContestStats;
  submissions: Submission[];
}

/**
 * 榜单 WebView（SPEC §4.7）。
 *
 * 安全上按 SPEC 的要求走严格路线：
 *   - CSP 是 default-src 'none'，脚本与样式靠 nonce 放行，没有任何网络来源；
 *   - 数据不在 HTML 里内联，而是 webview 就绪后由扩展 postMessage 注入。
 *     于是「选手名里带引号或尖括号」这类问题在结构上就不存在——脚本用
 *     createElement/ textContent 建 DOM，从不拼 HTML 字符串。
 * 图表用原生 SVG 手写，不引任何图表库。
 */
export function showStandingsView(
  context: vscode.ExtensionContext,
  data: StandingsViewData,
): void {
  const panel = vscode.window.createWebviewPanel(
    'verdictStandings',
    `Verdict：${data.title} 榜单`,
    vscode.ViewColumn.Beside,
    { enableScripts: true, retainContextWhenHidden: true },
  );
  context.subscriptions.push(panel);

  const nonce = createNonce();
  panel.webview.html = shell(data.title, nonce);

  panel.webview.onDidReceiveMessage((message: unknown) => {
    if (
      typeof message === 'object' &&
      message !== null &&
      (message as { type?: unknown }).type === 'ready'
    ) {
      void panel.webview.postMessage({ type: 'data', payload: payload(data) });
    }
  });
}

function payload(data: StandingsViewData): Record<string, unknown> {
  return {
    title: data.title,
    contestId: data.contestId,
    maxRejudge: data.maxRejudge,
    contestants: data.contestants,
    problems: data.problems,
    ranks: data.standings.ranks,
    cells: data.standings.cells,
    totals: data.standings.totals,
    stats: data.stats,
    submissions: data.submissions.map((item) => ({
      contestant: item.contestant,
      problem: item.problem,
      score: item.result?.score ?? 0,
      maxScore: item.result?.maxScore ?? 0,
      verdict: item.verdict ?? '—',
      message: item.message ?? '',
      rejudgeCount: item.rejudgeCount,
      cases: (item.result?.cases ?? []).map((entry) => ({
        test: entry.test,
        verdict: entry.verdict,
        timeMs: entry.timeMs,
        memoryKb: entry.memoryKb,
        message: entry.message ?? '',
      })),
    })),
  };
}

/** 每次打开都用新的 nonce；CSP 因此只认这一份脚本。 */
function createNonce(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let nonce = '';
  for (let index = 0; index < 32; index += 1) {
    nonce += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
  }
  return nonce;
}

function shell(title: string, nonce: string): string {
  const csp = [
    "default-src 'none'",
    `style-src 'nonce-${nonce}'`,
    `script-src 'nonce-${nonce}'`,
  ].join('; ');

  return [
    '<!DOCTYPE html>',
    '<html lang="zh-CN">',
    '<head>',
    '<meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${csp}">`,
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(title)} · 榜单</title>`,
    `<style nonce="${nonce}">${STYLE}</style>`,
    '</head>',
    '<body>',
    '<div id="root"><p class="loading">正在读取榜单…</p></div>',
    `<script nonce="${nonce}">${SCRIPT}</script>`,
    '</body>',
    '</html>',
  ].join('\n');
}

const STYLE = `
body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); margin: 16px; }
h1 { font-size: 18px; margin: 0 0 4px; }
h2 { font-size: 14px; margin: 20px 0 8px; }
.meta { color: var(--vscode-descriptionForeground); font-size: 12px; margin: 0 0 12px; }
table { border-collapse: collapse; font-size: 13px; }
th, td { border: 1px solid var(--vscode-panel-border); padding: 4px 10px; text-align: center; }
td.name, th.name { text-align: left; }
td.cell { cursor: pointer; }
td.cell:hover { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
.score { font-weight: 600; }
.max { font-weight: 400; opacity: 0.7; font-size: 11px; }
.verdict { display: block; font-size: 10px; opacity: 0.8; }
.stats { display: flex; gap: 24px; flex-wrap: wrap; }
.stats div { font-size: 13px; }
.stats strong { font-size: 16px; }
.bar { display: inline-block; height: 10px; background: var(--vscode-charts-blue); vertical-align: middle; }
#detail { margin-top: 8px; }
.loading { color: var(--vscode-descriptionForeground); }
`;

// 注意：这段脚本会原样进 HTML，所以里面不写反引号、不写 ${}。
const SCRIPT = `
(function () {
  var vscode = acquireVsCodeApi();
  var root = document.getElementById('root');

  function element(tag, className, text) {
    var node = document.createElement(tag);
    if (className) { node.className = className; }
    if (text !== undefined && text !== null) { node.textContent = String(text); }
    return node;
  }

  function find(list, predicate) {
    for (var i = 0; i < list.length; i += 1) {
      if (predicate(list[i])) { return list[i]; }
    }
    return null;
  }

  function colorFor(ratio) {
    if (ratio <= 0) { return 'transparent'; }
    var alpha = 0.15 + ratio * 0.55;
    return 'rgba(80, 150, 255, ' + alpha.toFixed(2) + ')';
  }

  function renderStats(data) {
    var box = element('div', 'stats');
    var items = [
      ['均分', data.stats.average],
      ['最高', data.stats.highest],
      ['最低', data.stats.lowest],
      ['提交', data.submissions.length],
      ['重测上限', data.maxRejudge]
    ];
    items.forEach(function (pair) {
      var cell = element('div');
      cell.appendChild(element('div', null, pair[0]));
      cell.appendChild(element('strong', null, pair[1]));
      box.appendChild(cell);
    });
    return box;
  }

  /** 分数分布直方图：原生 SVG 手写，不引图表库（SPEC §4.7）。 */
  function renderHistogram(data) {
    var totals = data.stats.scores.map(function (item) { return item.score; });
    if (totals.length === 0) { return element('p', 'loading', '还没有成绩。'); }
    var max = Math.max.apply(null, totals);
    var buckets = 5;
    var width = 40;
    var height = 90;
    var counts = [];
    for (var b = 0; b < buckets; b += 1) { counts.push(0); }
    totals.forEach(function (score) {
      var index = max <= 0 ? 0 : Math.min(buckets - 1, Math.floor((score / (max + 1)) * buckets));
      counts[index] += 1;
    });
    var peak = Math.max.apply(null, counts.concat([1]));

    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('width', String(buckets * width + 8));
    svg.setAttribute('height', String(height + 20));
    counts.forEach(function (count, index) {
      var barHeight = Math.round((count / peak) * height);
      var bar = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      bar.setAttribute('x', String(index * width + 4));
      bar.setAttribute('y', String(height - barHeight));
      bar.setAttribute('width', String(width - 8));
      bar.setAttribute('height', String(barHeight));
      bar.setAttribute('fill', 'var(--vscode-charts-blue)');
      svg.appendChild(bar);
      var label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      label.setAttribute('x', String(index * width + 4 + (width - 8) / 2));
      label.setAttribute('y', String(height + 14));
      label.setAttribute('text-anchor', 'middle');
      label.setAttribute('font-size', '10');
      label.setAttribute('fill', 'var(--vscode-descriptionForeground)');
      label.textContent = String(count);
      svg.appendChild(label);
    });
    return svg;
  }

  function renderProblems(data) {
    var table = element('table');
    var head = element('tr');
    ['题目', '满分人数', '提交人数', '平均分'].forEach(function (text) {
      head.appendChild(element('th', 'name', text));
    });
    table.appendChild(head);
    data.stats.problems.forEach(function (item) {
      var row = element('tr');
      row.appendChild(element('td', 'name', item.problem));
      row.appendChild(element('td', null, item.accepted + ' / ' + item.attempted));
      row.appendChild(element('td', null, item.attempted));
      row.appendChild(element('td', null, item.averageScore));
      table.appendChild(row);
    });
    return table;
  }

  function renderMatrix(data, detail) {
    var table = element('table');
    var head = element('tr');
    head.appendChild(element('th', null, '#'));
    head.appendChild(element('th', 'name', '选手'));
    data.problems.forEach(function (problem) {
      head.appendChild(element('th', null, problem.id));
    });
    head.appendChild(element('th', null, '总分'));
    table.appendChild(head);

    data.ranks.forEach(function (rank) {
      var row = element('tr');
      row.appendChild(element('td', null, rank.rank));
      var name = find(data.contestants, function (item) { return item.id === rank.contestant; });
      row.appendChild(element('td', 'name', name ? name.name : rank.contestant));

      data.problems.forEach(function (problem) {
        var cell = find(data.cells, function (item) {
          return item.contestant === rank.contestant && item.problem === problem.id;
        });
        var submission = find(data.submissions, function (item) {
          return item.contestant === rank.contestant && item.problem === problem.id;
        });
        var score = cell ? cell.score : 0;
        var maxScore = submission ? submission.maxScore : 0;
        var ratio = maxScore > 0 ? score / maxScore : 0;

        var td = element('td', 'cell');
        td.style.background = colorFor(ratio);
        td.appendChild(element('span', 'score', maxScore > 0 ? score + '/' + maxScore : score));
        td.appendChild(element('span', 'verdict', cell && cell.verdict ? cell.verdict : '—'));
        if (submission) {
          td.addEventListener('click', function () { showDetail(detail, submission); });
        }
        row.appendChild(td);
      });

      row.appendChild(element('td', null, rank.score));
      table.appendChild(row);
    });
    return table;
  }

  function showDetail(box, submission) {
    box.textContent = '';
    var name = submission.contestant;
    box.appendChild(element(
      'p',
      null,
      name + ' · ' + submission.problem + '：' + submission.score + '/' + submission.maxScore +
        ' 分 ' + submission.verdict + '（重测 ' + submission.rejudgeCount + ' 次）' +
        (submission.message ? ' — ' + submission.message : '')
    ));
    if (submission.cases.length === 0) {
      box.appendChild(element('p', 'loading', '这次提交没有逐测试点结果（例如编译失败）。'));
      return;
    }
    var table = element('table');
    var head = element('tr');
    ['测试点', '判定', '用时', '内存', '说明'].forEach(function (text) {
      head.appendChild(element('th', text === '说明' ? 'name' : null, text));
    });
    table.appendChild(head);
    submission.cases.forEach(function (item) {
      var row = element('tr');
      row.appendChild(element('td', null, item.test));
      row.appendChild(element('td', null, item.verdict));
      row.appendChild(element('td', null, item.timeMs + 'ms'));
      row.appendChild(element('td', null, item.memoryKb > 0 ? (item.memoryKb / 1024).toFixed(1) + 'MB' : 'n/a'));
      row.appendChild(element('td', 'name', item.message));
      table.appendChild(row);
    });
    box.appendChild(table);
  }

  function render(data) {
    root.textContent = '';
    root.appendChild(element('h1', null, data.title));
    root.appendChild(element(
      'p',
      'meta',
      '比赛 ' + data.contestId + ' · ' + data.contestants.length + ' 名选手 · ' +
        data.problems.length + ' 道题'
    ));
    root.appendChild(renderStats(data));

    root.appendChild(element('h2', null, '各题情况'));
    root.appendChild(renderProblems(data));

    root.appendChild(element('h2', null, '分数分布（每个柱子是该分段的选手数）'));
    root.appendChild(renderHistogram(data));

    root.appendChild(element('h2', null, '榜单（点分数看详情）'));
    var detail = element('div', null, null);
    detail.id = 'detail';
    root.appendChild(renderMatrix(data, detail));
    root.appendChild(detail);
  }

  window.addEventListener('message', function (event) {
    var message = event.data;
    if (message && message.type === 'data') { render(message.payload); }
  });
  vscode.postMessage({ type: 'ready' });
})();
`;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
