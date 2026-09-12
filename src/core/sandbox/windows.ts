import type { ChildProcess } from 'node:child_process';
import { runProcess } from '../../util/process';
import type { PlatformHooks, PreparedCommand, RunCommand } from './sandbox';

/**
 * Windows 的实现要点（SPEC §8.1、§8.3、§8.4）：
 * - 没有 sh / ulimit，栈限制改在编译期用 -Wl,--stack, 或 /STACK:；
 * - 没有进程组信号，杀进程树只能用 taskkill /T /F；
 * - 内存用 tasklist 的工作集字段采样。
 */
export function createWindowsHooks(): PlatformHooks {
  return {
    prepare(command: RunCommand): PreparedCommand {
      return { cmd: command.cmd, args: command.args, detached: false };
    },

    async killTree(child: ChildProcess): Promise<void> {
      const pid = child.pid;
      if (pid === undefined) {
        return;
      }
      await runProcess('taskkill', ['/PID', String(pid), '/T', '/F'], 5000);
      try {
        child.kill('SIGKILL');
      } catch {
        // 进程已经退出，无需处理
      }
    },

    async memoryKb(pid: number): Promise<number | null> {
      const result = await runProcess(
        'tasklist',
        ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'],
        5000,
      );
      // 输出形如： "solve.exe","12345","Console","1","12,345 K"
      const match = /"([\d.,]+)\s*K"\s*$/i.exec(result.stdout.trim());
      if (!match) {
        return null;
      }
      const kb = Number.parseInt(match[1].replace(/[.,]/g, ''), 10);
      return Number.isFinite(kb) ? kb : null;
    },
  };
}
