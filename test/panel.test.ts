import { describe, expect, it } from 'vitest';
import { createNonce, panelHtml } from '../src/vscode/panel/html';

/**
 * 面板的 HTML 是拼字符串拼出来的，所以这里盯住三件事：
 *   1. 完全自包含、不发任何网络请求（与榜单 WebView 同一条铁律）；
 *   2. CSP 只放行当次的 nonce，脚本与样式都不许内联执行；
 *   3. DOM 只用 createElement / textContent 建，绝不把数据当 HTML 拼进去。
 */
describe('侧边栏面板的 HTML', () => {
  const html = panelHtml('TESTNONCE');

  it('CSP 是 default-src none，并且只认当次 nonce', () => {
    expect(html).toContain(`default-src 'none'`);
    expect(html).toContain(`style-src 'nonce-TESTNONCE'`);
    expect(html).toContain(`script-src 'nonce-TESTNONCE'`);
    expect(html).toContain('<style nonce="TESTNONCE">');
    expect(html).toContain('<script nonce="TESTNONCE">');
    expect(html).not.toContain("'unsafe-inline'");
  });

  it('没有任何外部资源与网络调用（SPEC §18 的无网络断言）', () => {
    expect(html).not.toContain('http://');
    expect(html).not.toContain('https://');
    expect(html).not.toContain('<link');
    expect(html).not.toContain('<script src');
    expect(html).not.toContain('@import');
    expect(html).not.toContain('url(');
    expect(html).not.toContain('fetch(');
    expect(html).not.toContain('XMLHttpRequest');
    expect(html).not.toContain('WebSocket');
  });

  it('不把数据当 HTML 拼：只用 createElement / textContent', () => {
    expect(html).not.toContain('innerHTML');
    expect(html).not.toContain('insertAdjacentHTML');
    expect(html).not.toContain('document.write');
    expect(html).toContain('createElement');
    expect(html).toContain('textContent');
  });

  it('一次解析一个 nonce', () => {
    const first = createNonce();
    const second = createNonce();
    expect(first).toHaveLength(32);
    expect(first).not.toBe(second);
  });

  it('面板要能自己说明怎么开始（空工作区也得有出路）', () => {
    // 空状态文案是「不写 JSON」这条主线的门面：没有题目时要直接给按钮。
    expect(html).toContain('还没有题目');
    expect(html).toContain('verdict.newProblem');
    expect(html).toContain('verdict.importProblem');
    expect(html).toContain('verdict.judgeAll');
  });
});
