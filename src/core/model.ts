/**
 * 数据模型。
 *
 * M1 只落地当前用得到的部分；Problem / Contest / Submission 等在对应里程碑落地时再补，
 * 避免先写一堆没人用的空结构。
 */

export type Verdict =
  | 'AC'
  | 'WA'
  | 'TLE'
  | 'MLE'
  | 'OLE'
  | 'RE'
  | 'CE'
  | 'PC'
  | 'UKE';

export interface Limits {
  timeMs: number;
  memoryMb: number;
  stackMb: number;
  outputKb: number;
}

/** 与 SPEC §7.2 的默认值保持一致。 */
export const DEFAULT_LIMITS: Limits = {
  timeMs: 1000,
  memoryMb: 256,
  stackMb: 256,
  outputKb: 4096,
};

/** 单次进程执行的结果分类，见 SPEC §5.3 / §8.5。 */
export type RunVerdict = 'OK' | 'TLE' | 'MLE' | 'OLE' | 'RE' | 'INTERNAL';

export type ComparatorMode = 'default' | 'line' | 'real' | 'spj' | 'interactive';

export interface TestCase {
  id: string;
  /** 相对数据目录的输入文件名，例如 "1.in"。 */
  input: string;
  /** 相对数据目录的答案文件名，例如 "1.out"。 */
  answer: string;
  points?: number;
  subtask?: string;
}

/** 比较方式配置，见 SPEC §6.4 的几种写法。 */
export interface ComparatorConfig {
  mode: ComparatorMode;
  /** real 模式的绝对误差。 */
  absEps?: number;
  /** real 模式的相对误差。 */
  relEps?: number;
  /** spj 源码或可执行文件路径。 */
  spj?: string;
  /** 交互题交互器。 */
  interactor?: string;
}

/**
 * 与 vscode.CancellationToken 结构兼容的最小接口。
 *
 * core 层禁止 import vscode，所以这里声明一个结构等价的类型：
 * UI 层可以直接把 vscode 的 token 传进来，core 不需要知道它的来源。
 */
export interface CancellationTokenLike {
  readonly isCancellationRequested: boolean;
  onCancellationRequested(listener: () => void): { dispose(): void };
}
