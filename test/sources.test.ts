import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { findContestantSource } from '../src/core/contest/sources';
import { DEFAULT_LIMITS, type Contestant, type Problem } from '../src/core/model';

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verdict-sources-'));

afterAll(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});

let counter = 0;

function makeWorkspace(files: Record<string, string>): string {
  const dir = path.join(workDir, `ws-${counter++}`);
  for (const [relative, text] of Object.entries(files)) {
    const target = path.join(dir, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, text);
  }
  return dir;
}

const ALICE: Contestant = { id: 'alice', name: 'Alice', folder: 'players/alice' };

function problemOf(id: string, sourceDir?: string): Problem {
  return {
    id,
    name: id,
    type: 'traditional',
    limits: { ...DEFAULT_LIMITS },
    comparator: { mode: 'default' },
    subtasks: [],
    tests: [],
    ...(sourceDir === undefined ? {} : { sourceDir }),
  };
}

describe('findContestantSource', () => {
  it('优先用约定文件名 solve.cpp', async () => {
    const root = makeWorkspace({
      'players/alice/A/main.cpp': 'int main() {}',
      'players/alice/A/solve.cpp': 'int main() {}',
    });

    const found = await findContestantSource(root, ALICE, problemOf('A'));

    expect(found).toBe(path.join(root, 'players/alice/A/solve.cpp'));
  });

  it('没有约定名时取排序后的第一个，保证结果稳定', async () => {
    const root = makeWorkspace({
      'players/alice/A/zeta.cpp': 'int main() {}',
      'players/alice/A/alpha.cpp': 'int main() {}',
    });

    const found = await findContestantSource(root, ALICE, problemOf('A'));

    expect(found).toBe(path.join(root, 'players/alice/A/alpha.cpp'));
  });

  it('支持「每题一个文件」的布局：<选手目录>/<题目 id>.cpp', async () => {
    const root = makeWorkspace({ 'players/alice/A.cpp': 'int main() {}' });

    const found = await findContestantSource(root, ALICE, problemOf('A'));

    expect(found).toBe(path.join(root, 'players/alice/A.cpp'));
  });

  it('支持 Python', async () => {
    const root = makeWorkspace({ 'players/alice/A/solve.py': 'print(1)' });

    const found = await findContestantSource(root, ALICE, problemOf('A'));

    expect(found).toBe(path.join(root, 'players/alice/A/solve.py'));
  });

  it('problem.sourceDir 里的通配符换成选手目录的最后一段', async () => {
    const root = makeWorkspace({ 'players/alice/A/solve.cpp': 'int main() {}' });

    const found = await findContestantSource(root, ALICE, problemOf('A', 'players/*/A'));

    expect(found).toBe(path.join(root, 'players/alice/A/solve.cpp'));
  });

  it('选手目录本身就是源码文件时也能找到', async () => {
    const root = makeWorkspace({ 'players/alice.cpp': 'int main() {}' });
    const contestant: Contestant = { id: 'alice', name: 'Alice', folder: 'players/alice.cpp' };

    const found = await findContestantSource(root, contestant, problemOf('A'));

    expect(found).toBe(path.join(root, 'players/alice.cpp'));
  });

  it('找不到时返回 null，而不是猜一个', async () => {
    const root = makeWorkspace({ 'players/alice/readme.md': 'hi' });

    expect(await findContestantSource(root, ALICE, problemOf('A'))).toBeNull();
  });
});
