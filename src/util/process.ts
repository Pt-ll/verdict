import { spawn } from 'node:child_process';

export interface ProcessResult {
  /** 进程退出码；被信号杀死或启动失败时为 null。 */
  code: number | null;
  stdout: string;
  stderr: string;
  /** 是否因超时被强制终止。 */
  timedOut: boolean;
  /** 启动失败（如 ENOENT）时的人类可读原因。 */
  error?: string;
}

/** 短命命令（探测编译器、读进程内存）的默认超时。 */
export const DEFAULT_PROCESS_TIMEOUT_MS = 5000;

/**
 * 运行一个外部程序并收集输出。
 *
 * 这里刻意不抛异常：程序不存在、超时、被杀，都通过返回值表达，
 * 由上层转换成 CompileResult / RunResult 的判定与诊断。
 * 注意它只用于「短命工具命令」；被测程序的执行限额走 sandbox。
 */
export function runProcess(
  command: string,
  args: string[],
  timeoutMs: number = DEFAULT_PROCESS_TIMEOUT_MS,
): Promise<ProcessResult> {
  return new Promise<ProcessResult>((resolve) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;

    const finish = (result: ProcessResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer) {
        clearTimeout(timer);
      }
      resolve(result);
    };

    let child;
    try {
      child = spawn(command, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (err) {
      finish({ code: null, stdout: '', stderr: '', timedOut: false, error: describeError(err) });
      return;
    }

    let stdout = '';
    let stderr = '';

    timer = setTimeout(() => {
      child.kill();
      finish({
        code: null,
        stdout,
        stderr,
        timedOut: true,
        error: `执行超时（${timeoutMs}ms）`,
      });
    }, timeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (err) => {
      finish({ code: null, stdout, stderr, timedOut: false, error: describeError(err) });
    });
    child.on('close', (code) => {
      finish({ code, stdout, stderr, timedOut: false });
    });
  });
}

export function describeError(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}
