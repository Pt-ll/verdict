'use strict';

const assert = require('node:assert/strict');
const vscode = require('vscode');

/** 扩展 ID = package.json 的 `${publisher}.${name}`。 */
const EXTENSION_ID = 'verdict-dev.verdict';

const COMMANDS = ['verdict.checkEnv', 'verdict.judgeCurrent', 'verdict.cancel'];

/**
 * 每个样例的期望判定。
 *
 * AC/WA 验证「编译 + 运行 + 比较器」，TLE/RE/OLE 验证「限额与信号判定」，
 * 合起来就是 M1 的验收清单。时限来自 testdata/itest/.vscode/settings.json。
 */
const JUDGE_CASES = [
  { file: 'ac.cpp', verdict: 'AC', maxTimeMs: 1000 },
  { file: 'wa.cpp', verdict: 'WA', maxTimeMs: 1000 },
  // TLE 的 timeMs 是「启动到被杀」的墙钟时间，含进程启动与杀树开销，会比时限略大，
  // 所以 maxTimeMs 放宽；真正有意义的是 minTimeMs——太小说明根本没跑起来。
  { file: 'tle.cpp', verdict: 'TLE', minTimeMs: 300, maxTimeMs: 2000 },
  { file: 're.cpp', verdict: 'RE' },
  { file: 'ole.cpp', verdict: 'OLE' },
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

  console.log('[verdict] 集成测试全部通过');
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
  const outcome = await judge(api, root, 'ce.cpp');

  assert.equal(
    outcome.kind,
    'compile-failed',
    `ce.cpp：期望 kind=compile-failed，实际 ${outcome.kind}${detailOf(outcome)}`,
  );

  const uri = vscode.Uri.joinPath(root, 'ce.cpp');
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
