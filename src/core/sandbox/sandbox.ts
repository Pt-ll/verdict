import { spawn, type ChildProcess } from 'node:child_process';
import type { Writable } from 'node:stream';
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

  /**
   * 交互题：把两个进程对接起来跑（SPEC §5.6）。
   *
   * primary 的 stdout 直接接 secondary 的 stdin，反之亦然——这就是「选手程序与交互器对话」。
   * 判定以 secondary（interactor）的退出码为准，详见 core/compare/interactive.ts。
   */
  runConnected(
    primary: RunCommand,
    secondary: RunCommand,
    primaryLimits: Limits,
    secondaryLimits: Limits,
    token?: CancellationTokenLike,
  ): Promise<ConnectedRunResult>;
}

export interface ConnectedRunResult {
  /** 选手程序的运行结果。 */
  primary: RunResult;
  /** 交互器的运行结果；killed 表示它是被我们按限额杀掉的。 */
  secondary: RunResult & { killed: boolean };
  /** 是选手程序先结束，还是交互器先结束（判定时要区分「谁把谁等死了」）。 */
  endedFirst: 'primary' | 'secondary' | 'same';
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
    runConnected: (primary, secondary, primaryLimits, secondaryLimits, token) =>
      runConnected(hooks, primary, secondary, primaryLimits, secondaryLimits, token),
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

/** 给对端喂字节；对端已经退出时 EPIPE 属于正常情况，不能当异常抛出来。 */
function writeTo(target: Writable | null | undefined, chunk: Buffer): void {
  if (target === null || target === undefined || target.destroyed) {
    return;
  }
  try {
    target.write(chunk);
  } catch {
    // 对端已经关闭：交互被中断，判定由退出码与限额决定。
  }
}

/**
 * 两个进程对接运行（交互题，SPEC §5.6）。
 *
 * 与单进程版共享同样的三件事——限额、杀进程树、内存采样——但多了一条「互相喂字节」的管道。
 * 几个必须踩准的点：
 *   - 一边结束时要把另一边的 stdin 关掉，否则对端会一直等输入，整场评测就卡在这儿；
 *   - 总时限用**选手**的时限：交互的墙钟时间由选手的表现决定，交互器不该另算一份；
 *   - 结束前两边都要杀掉（外层也兜着），不留孤儿进程。
 *
 * 判定规则（含「谁先结束」的取舍）见 core/compare/interactive.ts。
 */
export async function runConnected(
  hooks: PlatformHooks,
  primary: RunCommand,
  secondary: RunCommand,
  primaryLimits: Limits,
  secondaryLimits: Limits,
  token?: CancellationTokenLike,
): Promise<ConnectedRunResult> {
  const missing = [primary, secondary].find((command) => which(command.cmd) === null);
  if (missing !== undefined) {
    const message = `找不到可执行文件：${missing.cmd}`;
    return {
      primary: internalResult(message),
      secondary: { ...internalResult(message), killed: false },
      endedFirst: 'same',
    };
  }

  const preparedPrimary = hooks.prepare(primary, primaryLimits);
  const preparedSecondary = hooks.prepare(secondary, secondaryLimits);
  const startedAt = Date.now();
  const outputLimitBytes = Math.max(0, Math.floor(primaryLimits.outputKb * 1024));
  const memoryLimitKb = Math.max(0, Math.floor(primaryLimits.memoryMb * 1024));
  const secondaryMemoryLimitKb = Math.max(0, Math.floor(secondaryLimits.memoryMb * 1024));

  let childPrimary: ChildProcess;
  let childSecondary: ChildProcess;
  try {
    childPrimary = spawn(preparedPrimary.cmd, preparedPrimary.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: preparedPrimary.detached,
      windowsHide: true,
    });
    childSecondary = spawn(preparedSecondary.cmd, preparedSecondary.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: preparedSecondary.detached,
      windowsHide: true,
    });
  } catch (err) {
    const message = describeError(err);
    return {
      primary: internalResult(message),
      secondary: { ...internalResult(message), killed: false },
      endedFirst: 'same',
    };
  }

  return new Promise<ConnectedRunResult>((resolve) => {
    let settled = false;
    let primaryDone = false;
    let secondaryDone = false;
    let endedFirst: ConnectedRunResult['endedFirst'] = 'same';
    let primaryKillReason: KillReason | null = null;
    let secondaryKilled = false;
    let primaryOutputBytes = 0;
    let primaryTruncated = false;
    let primaryExit: { code: number | null; signal: NodeJS.Signals | null } | null = null;
    let secondaryExit: { code: number | null; signal: NodeJS.Signals | null } | null = null;
    let primaryPeakMemKb = 0;
    let sampling = false;
    let cancelSubscription: { dispose(): void } | undefined;

    const finishIfBothDone = (): void => {
      if (settled || !primaryDone || !secondaryDone) {
        return;
      }
      settled = true;
      clearTimeout(timeoutTimer);
      clearInterval(memoryTimer);
      cancelSubscription?.dispose();

      resolve({
        primary: {
          status: decidePrimaryStatus(),
          exitCode: primaryExit?.code ?? null,
          signal: primaryExit?.signal ?? null,
          // 选手的 stdout 已经喂给交互器了，没有可以回放的内容。
          stdout: Buffer.alloc(0),
          stderr: Buffer.concat(primaryStderr),
          wallMs: Date.now() - startedAt,
          cpuMs: null,
          peakMemKb: primaryPeakMemKb,
          truncated: primaryTruncated,
        },
        secondary: {
          status: secondaryKilled
            ? 'INTERNAL'
            : secondaryExit?.code === 0
              ? 'OK'
              : 'RE',
          exitCode: secondaryExit?.code ?? null,
          signal: secondaryExit?.signal ?? null,
          stdout: Buffer.alloc(0),
          stderr: Buffer.concat(secondaryStderr),
          wallMs: Date.now() - startedAt,
          cpuMs: null,
          peakMemKb: 0,
          truncated: false,
          killed: secondaryKilled,
        },
        endedFirst,
      });
    };

    const primaryStderr: Buffer[] = [];
    const secondaryStderr: Buffer[] = [];

    const decidePrimaryStatus = (): RunVerdict => {
      if (primaryKillReason === 'timeout' || primaryKillReason === 'cancel') {
        return 'TLE';
      }
      if (primaryKillReason === 'memory') {
        return 'MLE';
      }
      if (primaryKillReason === 'output') {
        return 'OLE';
      }
      if (primaryExit?.signal === 'SIGXCPU') {
        return 'TLE';
      }
      if (primaryExit === null) {
        return 'INTERNAL';
      }
      return primaryExit.code === 0 ? 'OK' : 'RE';
    };

    const killPrimary = (reason: KillReason): void => {
      if (primaryKillReason === null) {
        primaryKillReason = reason;
      }
      void hooks.killTree(childPrimary);
    };

    const killSecondary = (): void => {
      secondaryKilled = true;
      void hooks.killTree(childSecondary);
    };

    const timeoutTimer = setTimeout(() => {
      killPrimary('timeout');
      // 选手超时了，交互器也没必要继续等下去。
      killSecondary();
    }, Math.max(1, Math.floor(primaryLimits.timeMs)));

    const memoryTimer = setInterval(() => {
      if (settled || sampling) {
        return;
      }
      sampling = true;
      const tasks: Promise<void>[] = [];

      if (!primaryDone && childPrimary.pid !== undefined) {
        tasks.push(
          hooks
            .memoryKb(childPrimary.pid)
            .then((kb) => {
              if (kb === null) {
                return;
              }
              primaryPeakMemKb = Math.max(primaryPeakMemKb, kb);
              if (memoryLimitKb > 0 && kb > memoryLimitKb) {
                killPrimary('memory');
              }
            })
            .catch(() => undefined),
        );
      }
      if (!secondaryDone && childSecondary.pid !== undefined && secondaryMemoryLimitKb > 0) {
        tasks.push(
          hooks
            .memoryKb(childSecondary.pid)
            .then((kb) => {
              if (kb !== null && kb > secondaryMemoryLimitKb) {
                killSecondary();
              }
            })
            .catch(() => undefined),
        );
      }

      void Promise.all(tasks).finally(() => {
        sampling = false;
      });
    }, MEMORY_POLL_INTERVAL_MS);

    childPrimary.stdout?.on('data', (chunk: Buffer) => {
      primaryOutputBytes += chunk.length;
      if (primaryOutputBytes > outputLimitBytes) {
        primaryTruncated = true;
        killPrimary('output');
        return;
      }
      writeTo(childSecondary.stdin, chunk);
    });
    childSecondary.stdout?.on('data', (chunk: Buffer) => {
      writeTo(childPrimary.stdin, chunk);
    });

    childPrimary.stderr?.on('data', (chunk: Buffer) => {
      primaryStderr.push(chunk);
    });
    childSecondary.stderr?.on('data', (chunk: Buffer) => {
      secondaryStderr.push(chunk);
    });

    for (const stream of [childPrimary.stdin, childSecondary.stdin]) {
      stream?.on('error', () => undefined);
    }

    childPrimary.on('error', (err) => {
      primaryKillReason = primaryKillReason ?? 'cancel';
      primaryStderr.push(Buffer.from(describeError(err), 'utf8'));
      if (childPrimary.pid === undefined) {
        primaryDone = true;
        setImmediate(finishIfBothDone);
      }
    });
    childSecondary.on('error', (err) => {
      secondaryKilled = true;
      secondaryStderr.push(Buffer.from(describeError(err), 'utf8'));
      if (childSecondary.pid === undefined) {
        secondaryDone = true;
        setImmediate(finishIfBothDone);
      }
    });

    childPrimary.on('close', (code, signal) => {
      primaryExit = { code, signal };
      primaryDone = true;
      if (!secondaryDone) {
        if (endedFirst === 'same') {
          endedFirst = 'primary';
        }
        // 关掉交互器的输入，让它看到 EOF 后自行收尾。
        childSecondary.stdin?.end();
      }
      finishIfBothDone();
    });
    childSecondary.on('close', (code, signal) => {
      secondaryExit = { code, signal };
      secondaryDone = true;
      if (!primaryDone) {
        if (endedFirst === 'same') {
          endedFirst = 'secondary';
        }
        // 交互器先退出了（常见于协议错误）：选手那边也该结束，别让它一直等输入。
        childPrimary.stdin?.end();
      }
      finishIfBothDone();
    });

    if (token) {
      if (token.isCancellationRequested) {
        killPrimary('cancel');
        killSecondary();
      } else {
        cancelSubscription = token.onCancellationRequested(() => {
          killPrimary('cancel');
          killSecondary();
        });
      }
    }
  });
}
