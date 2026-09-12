import { spawn, type ChildProcess } from 'node:child_process';
import { describeError } from '../../util/process';
import { which } from '../../util/which';
import type { CancellationTokenLike, Limits, RunVerdict } from '../model';
import { createPosixHooks } from './posix';
import { createWindowsHooks } from './windows';

export interface RunCommand {
  cmd: string;
  args: string[];
}

export interface RunResult {
  status: RunVerdict;
  exitCode: number | null;
  signal: string | null;
  stdout: Buffer;
  stderr: Buffer;
  wallMs: number;
  /** 平台支持时提供；当前实现恒为 null，原因见 runWithLimits 末尾说明。 */
  cpuMs: number | null;
  peakMemKb: number;
  truncated: boolean;
}

export interface Sandbox {
  run(
    command: RunCommand,
    stdin: Buffer,
    limits: Limits,
    token?: CancellationTokenLike,
  ): Promise<RunResult>;
}

export interface PreparedCommand {
  cmd: string;
  args: string[];
  detached: boolean;
}

/**
 * 平台相关的三件事：怎么包装命令、怎么杀进程树、怎么读内存。
 * 其余（累积输出、计时、判定优先级）在所有平台之间完全共享。
 */
export interface PlatformHooks {
  prepare(command: RunCommand, limits: Limits): PreparedCommand;
  killTree(child: ChildProcess): Promise<void>;
  /** 读取该进程当前常驻内存（KB）；读不到返回 null。 */
  memoryKb(pid: number): Promise<number | null>;
}

/** 内存采样间隔，SPEC §8.3 规定 25ms。 */
const MEMORY_POLL_INTERVAL_MS = 25;

type KillReason = 'timeout' | 'memory' | 'output' | 'cancel';

export function createSandbox(platform: NodeJS.Platform = process.platform): Sandbox {
  const hooks = platform === 'win32' ? createWindowsHooks() : createPosixHooks(platform);
  return {
    run: (command, stdin, limits, token) =>
      runWithLimits(hooks, command, stdin, limits, token),
  };
}

/**
 * 按限额执行被测程序。
 *
 * 判定优先级严格按 SPEC §8.5：TLE > MLE > OLE > RE > OK。
 * 实现上靠「谁先触发就把 killReason 定下来」，所以一次运行不会同时命中多个原因。
 */
export async function runWithLimits(
  hooks: PlatformHooks,
  command: RunCommand,
  stdin: Buffer,
  limits: Limits,
  token?: CancellationTokenLike,
): Promise<RunResult> {
  // 先确认可执行文件真的存在。POSIX 下我们是用 sh 包一层再 exec，
  // 程序不存在时 sh 只会以 127 退出，从退出码看不出「根本没启动起来」。
  if (which(command.cmd) === null) {
    return internalResult(`找不到可执行文件：${command.cmd}`);
  }

  const prepared = hooks.prepare(command, limits);
  const outputLimitBytes = Math.max(0, Math.floor(limits.outputKb * 1024));
  const memoryLimitKb = Math.max(0, Math.floor(limits.memoryMb * 1024));
  const startedAt = Date.now();

  const state = {
    stdoutChunks: [] as Buffer[],
    stderrChunks: [] as Buffer[],
    stdoutBytes: 0,
    stderrBytes: 0,
    truncated: false,
    peakMemKb: 0,
    killReason: null as KillReason | null,
    spawnError: null as string | null,
  };

  let child: ChildProcess;
  try {
    child = spawn(prepared.cmd, prepared.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: prepared.detached,
      windowsHide: true,
    });
  } catch (err) {
    return internalResult(describeError(err));
  }

  return new Promise<RunResult>((resolve) => {
    let settled = false;
    let killing = false;
    let sampling = false;
    let cancelSubscription: { dispose(): void } | undefined;

    const decideStatus = (exitCode: number | null, signal: string | null): RunVerdict => {
      // SPEC §8.5 把「取消」与「超时」都归为 TLE：两者在评测语义上都是「没跑完」。
      if (state.killReason === 'timeout' || state.killReason === 'cancel') {
        return 'TLE';
      }
      if (state.killReason === 'memory') {
        return 'MLE';
      }
      if (state.killReason === 'output') {
        return 'OLE';
      }
      if (state.spawnError) {
        return 'INTERNAL';
      }
      // SIGXCPU 是内核因 CPU 时间限额发出的信号，来源唯一，可以直接判 TLE。
      // 没有这条的话，被 CPU 限额杀死的程序会落到 RE，属于误判。
      if (signal === 'SIGXCPU') {
        return 'TLE';
      }
      return exitCode === 0 ? 'OK' : 'RE';
    };

    const finish = (exitCode: number | null, signal: string | null): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeoutTimer);
      clearInterval(memoryTimer);
      cancelSubscription?.dispose();

      resolve({
        status: decideStatus(exitCode, signal),
        exitCode,
        signal,
        stdout: Buffer.concat(state.stdoutChunks),
        stderr: Buffer.concat(state.stderrChunks),
        wallMs: Date.now() - startedAt,
        cpuMs: null,
        peakMemKb: state.peakMemKb,
        truncated: state.truncated,
      });
    };

    const killTree = (reason: KillReason): void => {
      if (state.killReason === null) {
        state.killReason = reason;
      }
      if (killing) {
        return;
      }
      killing = true;
      void hooks.killTree(child);
    };

    const timeoutTimer = setTimeout(
      () => killTree('timeout'),
      Math.max(1, Math.floor(limits.timeMs)),
    );

    const memoryTimer = setInterval(() => {
      const pid = child.pid;
      // 上一次采样还没回来就跳过：ps / tasklist 本身要几毫秒，堆叠只会拖慢整体。
      if (settled || killing || sampling || pid === undefined) {
        return;
      }
      sampling = true;
      void hooks
        .memoryKb(pid)
        .then((kb) => {
          if (kb === null) {
            return;
          }
          if (kb > state.peakMemKb) {
            state.peakMemKb = kb;
          }
          if (memoryLimitKb > 0 && kb > memoryLimitKb) {
            killTree('memory');
          }
        })
        .catch(() => undefined)
        .finally(() => {
          sampling = false;
        });
    }, MEMORY_POLL_INTERVAL_MS);

    child.stdout?.on('data', (chunk: Buffer) => {
      const room = outputLimitBytes - state.stdoutBytes;
      if (room > 0) {
        state.stdoutChunks.push(chunk.length <= room ? chunk : chunk.subarray(0, room));
      }
      state.stdoutBytes += chunk.length;
      if (state.stdoutBytes > outputLimitBytes) {
        state.truncated = true;
        killTree('output');
      }
    });

    // stderr 不参与 OLE 判定（SPEC §8.5 只看 stdout），但仍要限制累积量，
    // 否则一个往 stderr 刷日志的程序会把扩展宿主的内存吃光。
    child.stderr?.on('data', (chunk: Buffer) => {
      const room = outputLimitBytes - state.stderrBytes;
      if (room > 0) {
        state.stderrChunks.push(chunk.length <= room ? chunk : chunk.subarray(0, room));
      }
      state.stderrBytes += chunk.length;
    });

    if (child.stdin) {
      // 被测程序可能不读 stdin 就退出，此时写入会触发 EPIPE，属于正常情况。
      child.stdin.on('error', () => undefined);
      child.stdin.end(stdin);
    }

    child.on('error', (err) => {
      state.spawnError = describeError(err);
      // 启动失败（如 ENOENT）时 close 不保证触发，这里补一次收尾。
      if (child.pid === undefined) {
        setImmediate(() => finish(null, null));
      }
    });

    child.on('close', (code, signal) => {
      finish(code, signal);
    });

    if (token) {
      if (token.isCancellationRequested) {
        killTree('cancel');
      } else {
        cancelSubscription = token.onCancellationRequested(() => killTree('cancel'));
      }
    }
  });
}

/**
 * 关于 cpuMs：SPEC §8.2 允许「平台支持时提供」。
 * 用 /usr/bin/time 包装会把真正被测程序的 pid 藏到孙子进程里，破坏 RSS 采样目标；
 * 因此这里如实返回 null——wallMs 才是跨平台可靠的计时口径（SPEC §8.2 亦如此规定）。
 */
function internalResult(message: string): RunResult {
  return {
    status: 'INTERNAL',
    exitCode: null,
    signal: null,
    stdout: Buffer.alloc(0),
    // 启动失败的原因放进 stderr，UI 层不必为它单开一个字段。
    stderr: Buffer.from(message, 'utf8'),
    wallMs: 0,
    cpuMs: null,
    peakMemKb: 0,
    truncated: false,
  };
}
