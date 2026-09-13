'use strict';

const assert = require('node:assert/strict');
const vscode = require('vscode');

/** 扩展 ID = package.json 的 `${publisher}.${name}`。 */
const EXTENSION_ID = 'verdict-dev.verdict';

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
  const problem = problems.find((item) => item.id.includes('problemA'));
  assert.ok(
    problem,
    `Testing 树里应当出现 testdata/problemA，实际是：${problems.map((item) => item.label).join(' / ') || '（空）'}`,
  );
  assert.equal(problem.label, 'A. 求和');

  const subtasks = childrenOf(problem);
  assert.deepEqual(
    subtasks.map((item) => item.label),
    ['子任务 1', '子任务 2'],
    '题目下应当按子任务分组',
  );
  assert.deepEqual(childrenOf(subtasks[0]).map((item) => item.label), ['#1']);
  assert.deepEqual(childrenOf(subtasks[1]).map((item) => item.label), ['#2']);
  console.log('[verdict] Testing 树：A. 求和 > 子任务 1(#1) / 子任务 2(#2)');

  await openSource(root, 'problemA/solve.cpp');
  const full = await api.runTestingItems(subtasks);
  assert.ok(full !== null, '跑测试应当拿到评测结果');
  assert.equal(full.kind, 'judged', `期望 judged，实际 ${full.kind}${detailOf(full)}`);
  assert.equal(full.score, 100, `正确程序应当满分，实际 ${full.score}/${full.maxScore}`);
  assert.deepEqual(full.subtasks.map((item) => item.status), ['full', 'full']);

  // 只写对一半的程序：小数据过、大数据溢出，应当拿到第 1 个子任务的 30 分。
  await openSource(root, 'problemA/solve-wrong.cpp');
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
  await openSource(root, 'problemA/solve.cpp');
  const problemRoot = vscode.Uri.joinPath(root, 'problemA').fsPath;
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
