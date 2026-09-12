import type { ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { runProcess } from '../../util/process';
import type { Limits } from '../model';
import type { PlatformHooks, PreparedCommand, RunCommand } from './sandbox';

export function createPosixHooks(
  platform: NodeJS.Platform = process.platform,
): PlatformHooks {
  return {
    prepare(command: RunCommand, limits: Limits): PreparedCommand {
      // 用 sh 包一层只为施加 ulimit。命令序列以 exec 结尾，
      // 让被测程序替换掉 sh，这样 child.pid 就是被测程序本身，内存采样才不会采到 shell。
      return {
        cmd: 'sh',
        args: ['-c', buildUlimitScript(platform, limits), command.cmd, ...command.args],
        detached: true,
      };
    },

    async killTree(child: ChildProcess): Promise<void> {
      const pid = child.pid;
      if (pid === undefined) {
        return;
      }
      try {
        // detached 之后子进程自成进程组，负号 pid 表示「杀整组」，
        // 能连带清掉被测程序自己 fork 出来的后代进程。
        process.kill(-pid, 'SIGKILL');
      } catch {
        try {
          child.kill('SIGKILL');
        } catch {
          // 进程已经退出，无需处理
        }
      }
    },

    async memoryKb(pid: number): Promise<number | null> {
      if (platform === 'linux') {
        const kb = await readProcVmRssKb(pid);
        if (kb !== null) {
          return kb;
        }
      }
      // macOS / BSD 没有可用的 /proc，退回 ps；Linux 上 /proc 不可读时也走这里。
      const result = await runProcess('ps', ['-o', 'rss=', '-p', String(pid)], 2000);
      const kb = Number.parseInt(result.stdout.trim(), 10);
      return Number.isFinite(kb) ? kb : null;
    },
  };
}

/**
 * 生成施加限额的 sh 片段。
 *
 * 每条 ulimit 都重定向掉 stderr：部分系统不允许放宽某些限制（macOS 上栈的硬上限
 * 常挡住较大的取值），而失败并不致命——真正的兜底是墙钟超时与内存采样。
 */
function buildUlimitScript(platform: NodeJS.Platform, limits: Limits): string {
  const lines: string[] = [];

  if (limits.stackMb > 0) {
    lines.push(`ulimit -s ${Math.floor(limits.stackMb * 1024)} 2>/dev/null`);
  }

  // CPU 时间兜底：墙钟超时之外再上一层，防止杀树失败时死循环进程继续吃满 CPU。
  const cpuSeconds = Math.max(1, Math.ceil(limits.timeMs / 1000) + 1);
  lines.push(`ulimit -t ${cpuSeconds} 2>/dev/null`);

  // 虚拟内存上限只在 Linux 上可靠；macOS 上该限制常被内核拒绝，交给 RSS 采样兜底。
  //
  // 这里刻意取 2 倍而不是等于限额：虚拟内存 ≥ 常驻内存，若把 ulimit -v 卡在限额上，
  // 程序会在 RSS 采样发现超限之前就先 malloc 失败并崩溃，结果被判成 RE 而不是 MLE。
  // 于是它只当「失控分配」的兜底，真正的限额判定交给上面的 RSS 采样。
  if (platform === 'linux' && limits.memoryMb > 0) {
    lines.push(`ulimit -v ${Math.floor(limits.memoryMb * 2 * 1024)} 2>/dev/null`);
  }

  lines.push('exec "$0" "$@"');
  return lines.join('\n');
}

async function readProcVmRssKb(pid: number): Promise<number | null> {
  try {
    const statusPath = path.join('/proc', String(pid), 'status');
    const text = await fs.promises.readFile(statusPath, 'utf8');
    const match = /VmRSS:\s+(\d+)\s+kB/.exec(text);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}
