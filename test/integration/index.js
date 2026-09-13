'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vscode = require('vscode');

/** 扩展 ID = package.json 的 `${publisher}.${name}`。 */
const EXTENSION_ID = 'yuchenzhong.verdict';

const COMMANDS = [
  'verdict.checkEnv',
  'verdict.judgeCurrent',
  'verdict.cancel',
  // M2 的编辑类命令：只验证注册（它们要弹对话框，不适合在无头宿主里跑完整流程）。
  'verdict.addTests',
  'verdict.configureSubtasks',
  'verdict.setLimits',
  'verdict.showDiff',
  'verdict.debugCase',
  // M3 的比赛类命令（同样只验注册：它们大多要弹对话框或起 WebView）。
  'verdict.newContest',
  'verdict.newProblem',
  'verdict.judgeAll',
  'verdict.rejudge',
  'verdict.showStandings',
  'verdict.exportHtml',
  'verdict.exportProblem',
  'verdict.importProblem',
];

/**
 * 每个样例的期望判定。
 *
 * AC/WA 验证「编译 + 运行 + 比较器」，TLE/RE/OLE 验证「限额与信号判定」，
 * 合起来就是 M1 的验收清单。时限来自 testdata/itest/.vscode/settings.json。
 */
// 路径相对工作区根目录（testdata/），所以走约定式查找的样例都带 itest/ 前缀。
const JUDGE_CASES = [
  { file: 'itest/ac.cpp', verdict: 'AC', maxTimeMs: 1000 },
  { file: 'itest/wa.cpp', verdict: 'WA', maxTimeMs: 1000 },
  // 第 3 行才不同：用来验证 diff 定位的是「首个不同行」而不是第 1 行。
  { file: 'itest/wa-line.cpp', verdict: 'WA' },
  // TLE 的 timeMs 是「启动到被杀」的墙钟时间，含进程启动与杀树开销，会比时限略大，
  // 所以 maxTimeMs 放宽；真正有意义的是 minTimeMs——太小说明根本没跑起来。
  { file: 'itest/tle.cpp', verdict: 'TLE', minTimeMs: 300, maxTimeMs: 2000 },
  { file: 'itest/re.cpp', verdict: 'RE' },
  { file: 'itest/ole.cpp', verdict: 'OLE' },
];

async function run() {
  const extension = vscode.extensions.getExtension(EXTENSION_ID);
  assert.ok(
    extension,
    `找不到扩展 ${EXTENSION_ID}：检查 package.json 的 publisher + name，以及 test/runTest.js 的 extensionDevelopmentPath`,
  );

  const api = await extension.activate();
  assert.equal(
    typeof (api && api.judgeDocument),
    'function',
    'activate() 应当返回 { judgeDocument }（见 src/extension.ts 的 VerdictApi）',
  );
  console.log('[verdict] 扩展已激活');

  const registered = await vscode.commands.getCommands(true);
  for (const id of COMMANDS) {
    assert.ok(registered.includes(id), `命令 ${id} 未注册`);
  }
  console.log(`[verdict] ${COMMANDS.length} 个命令均已注册`);

  const folder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
  assert.ok(folder, '集成测试必须以 testdata/itest 作为工作区打开（见 test/runTest.js）');

  for (const item of JUDGE_CASES) {
    await checkJudgement(api, folder.uri, item);
  }
  await checkCompileError(api, folder.uri);
  await checkDiff();
  await checkProblemPackage(api, folder.uri);
  await checkDebug(api, folder.uri);
  await checkContest(api);

  console.log('[verdict] 集成测试全部通过');
}

/**
 * WA 之后应当自动打开 diff，并把光标放在首个不同行（SPEC §4.5 / §12 M2 验收）。
 *
 * 用例顺序保证 wa-line.cpp 是最后一个 WA，所以此刻打开的 diff 就是它。
 */
async function checkDiff() {
  const tabs = vscode.window.tabGroups.all.flatMap((group) => group.tabs);
  const diffTab = tabs.find((tab) => tab.label.includes('测试点 wa-line'));
  assert.ok(diffTab, `WA 之后应当自动打开 diff 标签页，实际标签：${tabs.map((t) => t.label).join(' / ')}`);

  // 只看 wa-line 这一对虚拟文档：后面还有其他 diff 会打开，别让它们替这条断言作证。
  const editors = vscode.window.visibleTextEditors.filter(
    (item) =>
      item.document.uri.scheme === 'verdict' &&
      decodeURIComponent(item.document.uri.path).includes('wa-line'),
  );
  assert.ok(
    editors.length > 0,
    'diff 两侧应当是我们提供的 verdict:// 虚拟文档（SPEC §4.6），实际却是普通文件',
  );

  // 首个不同行是第 3 行；API 收的是 0 起的行号，所以期望 2。
  const lines = editors.map((item) => item.selection.start.line);
  assert.ok(
    lines.some((line) => line === 2),
    `diff 应当定位到第 3 行（0 起为 2），实际停在第 ${lines.map((line) => line + 1).join('、')} 行`,
  );

  console.log('[verdict] WA 自动打开了 diff，并定位到首个不同的第 3 行');
}

/**
 * 题目包与 Testing 面板（SPEC §4.4 / §12 M2）。
 *
 * 树结构和判定都走面板真正的入口（runTestingItems 就是运行按钮调的那段代码），
 * 不另开一条测试专用的捷径，否则测过的和用户用的就是两回事了。
 */
async function checkProblemPackage(api, root) {
  await api.refreshTesting();
  const problems = api.testingItems();
  const problem = problems.find((item) => item.label === 'A. 求和');
  assert.ok(
    problem,
    `Testing 树里应当出现题目 A，实际是：${problems.map((item) => item.label).join(' / ') || '（空）'}`,
  );

  const subtasks = childrenOf(problem);
  assert.deepEqual(
    subtasks.map((item) => item.label),
    ['子任务 1', '子任务 2'],
    '题目下应当按子任务分组',
  );
  assert.deepEqual(childrenOf(subtasks[0]).map((item) => item.label), ['#1']);
  assert.deepEqual(childrenOf(subtasks[1]).map((item) => item.label), ['#2']);
  console.log('[verdict] Testing 树：A. 求和 > 子任务 1(#1) / 子任务 2(#2)');

  await openSource(root, 'players/alice/A.cpp');
  const full = await api.runTestingItems(subtasks);
  assert.ok(full !== null, '跑测试应当拿到评测结果');
  assert.equal(full.kind, 'judged', `期望 judged，实际 ${full.kind}${detailOf(full)}`);
  assert.equal(full.score, 100, `正确程序应当满分，实际 ${full.score}/${full.maxScore}`);
  assert.deepEqual(full.subtasks.map((item) => item.status), ['full', 'full']);

  // 只写对一半的程序：小数据过、大数据溢出，应当拿到第 1 个子任务的 30 分。
  await openSource(root, 'players/bob/A.cpp');
  const partial = await api.runTestingItems(subtasks);
  assert.ok(partial !== null, '跑测试应当拿到评测结果');
  assert.equal(partial.kind, 'judged', `期望 judged，实际 ${partial.kind}${detailOf(partial)}`);
  assert.equal(
    partial.score,
    30,
    `溢出程序应当拿 30 分，实际 ${partial.score}/${partial.maxScore}`,
  );
  assert.deepEqual(partial.subtasks.map((item) => item.status), ['full', 'none']);
  console.log('[verdict] 题目包评测：正确程序 100/100，溢出程序 30/100（子任务 1 满分、子任务 2 未得分）');
}

function childrenOf(item) {
  const items = [];
  item.children.forEach((child) => items.push(child));
  return items;
}

async function openSource(root, relative) {
  const document = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(root, relative));
  // 面板跑测试时用的是「当前打开的源文件」，所以这里必须真的把它显示出来。
  await vscode.window.showTextDocument(document);
  return document;
}

/**
 * 调试首测点（SPEC §4.4 / §4.8）。
 *
 * 测试宿主默认禁用了所有扩展，于是这里只能走「没装调试扩展」那条路径——它恰恰是最需要
 * 给出可操作提示的地方。本机想验证真的会话：VERDICT_ITEST_KEEP_EXTENSIONS=1。
 */
async function checkDebug(api, root) {
  await openSource(root, 'players/alice/A.cpp');
  const problemRoot = vscode.Uri.joinPath(root, '.verdict', 'problems', 'A').fsPath;
  const result = await api.debugFirstCase(problemRoot, '1');

  if (process.env.VERDICT_ITEST_KEEP_EXTENSIONS !== '1') {
    assert.equal(
      result.kind,
      'no-debugger',
      `测试宿主里没有调试扩展，期望 no-debugger，实际 ${result.kind}：${result.message || ''}`,
    );
    assert.ok(
      result.message.includes('ms-vscode.cpptools'),
      '提示里应当写清楚要装哪个扩展，否则用户无从下手',
    );
    console.log('[verdict] 调试：没有调试扩展时给出可操作提示');
    return;
  }

  assert.equal(result.kind, 'started', `期望 started，实际 ${result.kind}：${result.message || ''}`);
  assert.ok(result.program.length > 0, '应当先编译出调试版可执行文件');
  assert.ok(
    result.inputPath !== undefined && result.inputPath.endsWith('1.in'),
    `首个测试点的输入应当被接上，实际 ${result.inputPath}`,
  );
  assert.ok(vscode.debug.activeDebugSession !== undefined, '调试会话应当是激活状态');

  // 收拾干净：留着会话会让扩展宿主退出变慢。
  await vscode.debug.stopDebugging();
  console.log(`[verdict] 调试：会话已启动（stdio 注入 ${result.injected ? '已尝试' : '未尝试'}），随后停止`);

  await checkDebugInjection(api);
  await checkInteractiveDebug(api, root);
}

/**
 * 交互题的调试（录制-重放）。
 *
 * 调试器里跑不了真实的两进程对话，所以做法是：先录一局真实对局，再用「交互器发给选手」
 * 的那串输入当调试会话的 stdin。这里验的是录制与接线——注入机制本身在上一条里已经验过
 * （同一个 lldb 命令，同一个配置文件）。
 */
async function checkInteractiveDebug(api, root) {
  await openSource(root, 'players/alice/C.cpp');

  const result = await api.debugFirstCase(
    vscode.Uri.joinPath(root, '.verdict', 'problems', 'C').fsPath,
    '1',
  );
  assert.equal(result.kind, 'started', `交互题的调试会话没起来：${result.message || ''}`);
  assert.ok(result.note !== undefined && result.note.includes('重放'), '应当说明这是在重放');
  assert.ok(
    result.inputPath !== undefined && result.inputPath.endsWith('replay-stdin.txt'),
    `调试时的 stdin 应当是录下来的提示串，实际 ${result.inputPath}`,
  );
  assert.ok(result.transcriptPath !== undefined, '应当留下对局记录');

  // 提示串里必须有交互器说过的话：空文件说明录制没成功。
  const tape = fs.readFileSync(result.inputPath, 'utf8');
  assert.ok(tape.includes('ok') || tape.includes('bigger') || tape.includes('smaller'), `提示串内容不对：${JSON.stringify(tape)}`);
  const transcript = fs.readFileSync(result.transcriptPath, 'utf8');
  assert.ok(transcript.includes('选手发给交互器'), '对局记录应当两个方向都有');

  await vscode.debug.stopDebugging();
  console.log(`[verdict] 交互题调试：已录下对局（提示串 ${tape.trim().split(/\s+/).length} 段），并用它作为调试输入`);
}

/**
 * 关键验证：调试会话里，程序**真的读到了**测试点的输入。
 *
 * 光看「已尝试注入」说明不了问题——那条 lldb 命令可能被静默忽略（我们标了 ignoreFailures）。
 * 所以用探针程序把读到的 stdin 写到文件里，再对内容。这是唯一能证明注入生效的办法。
 */
async function checkDebugInjection(api) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verdict-debug-'));
  const dirUri = vscode.Uri.file(dir);
  try {
    fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'problem.json'),
      JSON.stringify({
        id: 'DBG',
        name: 'DBG. 探针',
        limits: { timeMs: 5000, memoryMb: 256, stackMb: 256, outputKb: 4096 },
        tests: [{ id: '1', input: 'data/1.in', answer: 'data/1.out', points: 100 }],
      }),
    );
    fs.writeFileSync(path.join(dir, 'data', '1.in'), '1 2\n');
    fs.writeFileSync(path.join(dir, 'data', '1.out'), '3\n');

    // 探针：把 stdin 原样写到工作目录下的一个文件。调试配置里的 cwd 就是题目包根目录，
    // 所以这个文件会落在 dir/ 下面。
    fs.writeFileSync(
      path.join(dir, 'probe.cpp'),
      [
        '#include <cstdio>',
        'int main() {',
        '  FILE* out = std::fopen("verdict-debug-stdin.txt", "wb");',
        '  if (out == nullptr) return 1;',
        '  char buffer[256];',
        '  while (std::fgets(buffer, sizeof buffer, stdin) != nullptr) {',
        '    std::fputs(buffer, out);',
        '  }',
        '  std::fclose(out);',
        '  return 0;',
        '}',
        '',
      ].join('\n'),
    );

    const document = await vscode.workspace.openTextDocument(
      vscode.Uri.joinPath(dirUri, 'probe.cpp'),
    );
    await vscode.window.showTextDocument(document);

    const result = await api.debugFirstCase(dir, '1');
    assert.equal(result.kind, 'started', `探针的调试会话没起来：${result.message || ''}`);

    const evidence = path.join(dir, 'verdict-debug-stdin.txt');
    const deadline = Date.now() + 20_000;
    while (!fs.existsSync(evidence) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    assert.ok(fs.existsSync(evidence), '调试会话里程序没有读到任何输入（注入没生效）');
    const read = fs.readFileSync(evidence, 'utf8');
    assert.equal(read, '1 2\n', `程序读到的应当是测试点输入，实际读到 ${JSON.stringify(read)}`);

    await vscode.debug.stopDebugging();
    console.log('[verdict] 调试注入验证：程序读到的 stdin 与测试点输入一致');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * M3 验收（SPEC §12）：多选手多题评测后榜单正确、重测上限生效、导出的 HTML 自包含且可点开详情。
 *
 * 走的是命令按钮背后同一套代码（ContestSession），只是绕开了对话框——
 * 「评测全部」点一下是没法断言分数的。
 */
async function checkContest(api) {
  const summary = await api.judgeContestAll();
  assert.ok(summary !== null, '工作区里应当有 .verdict/contest.json（见 testdata）');
  assert.deepEqual(
    summary.missing,
    [],
    `所有选手都应当有源码，缺的是：${JSON.stringify(summary.missing)}`,
  );

  // Alice：A 题两个子任务都对（100）+ B 题满分（100）+ C 题交互（100）= 300
  // Bob：A 题大数据溢出（30）+ B 题满分（100）+ C 题交互（100）= 230
  const totals = new Map(summary.standings.totals.map((item) => [item.contestant, item.score]));
  assert.equal(totals.get('alice'), 300, `Alice 应当 300 分，实际 ${totals.get('alice')}`);
  assert.equal(totals.get('bob'), 230, `Bob 应当 230 分，实际 ${totals.get('bob')}`);
  assert.deepEqual(
    summary.standings.ranks.map((item) => [item.contestant, item.rank]),
    [
      ['alice', 1],
      ['bob', 2],
    ],
    '名次应当按总分降序',
  );
  console.log('[verdict] 整场评测：alice 300 分、bob 230 分，名次正确（含一道交互题）');

  // 导出的 HTML 必须自包含：断网双击就能看，不依赖字体 / CDN / 图片。
  const html = api.standingsHtml();
  assert.ok(html !== null, '应当能生成榜单 HTML');
  assert.ok(html.includes('演示赛'), '榜单应当包含比赛标题');
  for (const forbidden of ['http://', 'https://', '<link', '<script src', '@import']) {
    assert.ok(!html.includes(forbidden), `榜单 HTML 不该引用外部资源：${forbidden}`);
  }
  assert.ok(html.includes('data-cell'), '单元格应当可点开详情');

  const target = path.join(os.tmpdir(), `verdict-standings-${String(Date.now())}.html`);
  const written = await api.writeStandingsHtml(target);
  assert.equal(written, target, '导出的路径应当就是指定的那个');
  assert.ok(fs.readFileSync(target, 'utf8').includes('Alice'), '导出的文件里应当有选手');
  fs.rmSync(target, { force: true });
  console.log('[verdict] 榜单 HTML 已导出到磁盘，自包含且可点开详情');

  // 重测上限：testdata 里 maxRejudge = 1，所以第二次必须被拒绝。
  const first = await api.rejudgeOne('bob', 'A');
  assert.equal(first.ok, true, `第一次重测应当允许：${first.message}`);
  assert.equal(first.submission.rejudgeCount, 1, '重测次数应当加一');
  const second = await api.rejudgeOne('bob', 'A');
  assert.equal(second.ok, false, '到达上限后不该再允许重测');
  assert.ok(second.message.includes('上限'), `拒绝理由要写清楚，实际：${second.message}`);
  console.log('[verdict] 重测上限生效：第一次允许，第二次被拒绝');

  // 榜单 WebView：至少确认它能被打开（生成 HTML 的过程要跑通，模板出错会当场抛）。
  // WebView 内部的 DOM 没法从这里读到，所以只做冒烟检查。
  await vscode.commands.executeCommand('verdict.showStandings');
  const tabs = await waitForTabs((tab) => tab.label.includes('榜单'));
  assert.ok(
    tabs.some((tab) => tab.label.includes('榜单')),
    `应当打开榜单面板，实际标签：${tabs.map((tab) => tab.label).join(' / ')}`,
  );
  console.log('[verdict] 榜单 WebView 已打开');
}

/** 面板/标签的出现是异步的，等一小会儿再断言，避免把「还没渲染完」当成「没打开」。 */
async function waitForTabs(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const tabs = vscode.window.tabGroups.all.flatMap((group) => group.tabs);
    if (tabs.some(predicate) || Date.now() > deadline) {
      return tabs;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function checkJudgement(api, root, item) {
  const outcome = await judge(api, root, item.file);

  assert.equal(
    outcome.kind,
    'judged',
    `${item.file}：期望 kind=judged，实际 ${outcome.kind}${detailOf(outcome)}`,
  );
  assert.equal(
    outcome.cases.length,
    1,
    `${item.file}：每个样例只配一组同名 .in/.out，却找到 ${outcome.cases.length} 组`,
  );

  const result = outcome.cases[0];
  assert.equal(
    result.verdict,
    item.verdict,
    `${item.file}：期望 ${item.verdict}，实际 ${result.verdict}（${result.message || '无消息'}）`,
  );
  assert.equal(result.score, item.verdict === 'AC' ? 1 : 0, `${item.file}：得分不符`);

  if (item.maxTimeMs !== undefined) {
    assert.ok(
      result.timeMs <= item.maxTimeMs,
      `${item.file}：用时 ${result.timeMs}ms 超过了 ${item.maxTimeMs}ms 的时限，判定与计时对不上`,
    );
  }
  if (item.minTimeMs !== undefined) {
    assert.ok(
      result.timeMs >= item.minTimeMs,
      `${item.file}：判成 ${item.verdict} 却只用了 ${result.timeMs}ms，计时不合理`,
    );
  }

  console.log(`[verdict] ${item.file} -> ${result.verdict}（${result.timeMs}ms）`);
}

async function checkCompileError(api, root) {
  const relative = 'itest/ce.cpp';
  const outcome = await judge(api, root, relative);

  assert.equal(
    outcome.kind,
    'compile-failed',
    `ce.cpp：期望 kind=compile-failed，实际 ${outcome.kind}${detailOf(outcome)}`,
  );

  const uri = vscode.Uri.joinPath(root, relative);
  const errors = vscode.languages
    .getDiagnostics(uri)
    .filter((item) => item.severity === vscode.DiagnosticSeverity.Error);
  assert.ok(errors.length > 0, 'ce.cpp：编译失败后，问题面板里应当有 error 级诊断');

  // 语法错误写在 `int answer = ;` 那一行；允许 ±1 行的偏差，因为不同编译器报的位置略有出入。
  // 跳过注释行：注释里也写着这段代码，不排除掉会先匹配到注释。
  const document = await vscode.workspace.openTextDocument(uri);
  const expectedLine = document
    .getText()
    .split(/\r?\n/)
    .findIndex((line) => !line.trimStart().startsWith('//') && line.includes('int answer = ;'));
  assert.ok(expectedLine >= 0, 'ce.cpp：找不到预留的语法错误，样例被改坏了？');

  const actualLines = errors.map((item) => item.range.start.line + 1);
  assert.ok(
    errors.some((item) => Math.abs(item.range.start.line - expectedLine) <= 1),
    `ce.cpp：诊断没有定位到第 ${expectedLine + 1} 行附近，实际落在第 ${actualLines.join('、')} 行`,
  );

  console.log(`[verdict] ce.cpp -> CE（${errors.length} 条诊断，定位到第 ${actualLines[0]} 行）`);
}

/** 打开文件并评测一次。没编译器的机器会得到 kind=no-compiler，由调用方的断言给出结论。 */
async function judge(api, root, file) {
  const uri = vscode.Uri.joinPath(root, file);
  const document = await vscode.workspace.openTextDocument(uri);
  const outcome = await api.judgeDocument(document);
  assert.ok(outcome !== null, `${file}：期望得到评测结果，实际是 null`);
  return outcome;
}

/** 把评测结果压成一句话，方便断言失败时看懂发生了什么。 */
function detailOf(outcome) {
  if (outcome.message) {
    return `：${outcome.message}`;
  }
  if (outcome.compile && outcome.compile.diagnostics.length > 0) {
    return `：${outcome.compile.diagnostics[0].message}`;
  }
  return '';
}

module.exports = { run };
