/**
 * 数据模型。
 *
 * M1 只落地当前用得到的部分；Problem / Contest / Submission 等在对应里程碑落地时再补，
 * 避免先写一堆没人用的空结构。
 */

export type ProblemType = 'traditional' | 'interactive';

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
  /**
   * 输入文件路径。
   *
   * 题目包里相对**题目包根目录**（SPEC §6.3 写作 "data/1.in"）；
   * M1 的约定式查找（findTestsBesideSource）里则相对数据目录。
   */
  input: string;
  /** 答案文件路径，基准同 input。 */
  answer: string;
  /** 该测试点分值；未写时按 1 分计（见 judge/score.ts）。 */
  points?: number;
  /**
   * 该测试点属于哪个子任务。
   *
   * 成员关系的权威来源是 Subtask.tests；这个字段是给人看的提示，
   * 两者不一致时 problem/package.ts 会报错，而不是悄悄按其中一个算分。
   */
  subtask?: string;
  /** 可选的数据合法性校验器（M4 落地）。 */
  validator?: string;
}

/** 子任务：OI 赛制的分组计分，见 SPEC §5.5。 */
export interface Subtask {
  id: string;
  name?: string;
  points: number;
  /** 归属该子任务的测试点 id 列表。 */
  tests: string[];
  /** 依赖的子任务 id：依赖未满分时本子任务被 skip 且计 0 分。 */
  dependsOn: string[];
  /** 子任务内计分方式：min 取各测试点得分率的最小值，sum 按得分率求和。 */
  scoring: 'min' | 'sum';
}

export interface Problem {
  id: string;
  name: string;
  type: ProblemType;
  limits: Limits;
  comparator: ComparatorConfig;
  subtasks: Subtask[];
  tests: TestCase[];
  /**
   * 选手源码目录与标准程序目录（支持 glob，M3 的比赛模式才真正用到）。
   * 题目包里可以不写：缺省表示源码就在题目包附近。
   */
  sourceDir?: string;
  answerDir?: string;
  /** 原始 problem.json 里的未知字段，写回时原样保留（SPEC §6.5）。 */
  _raw?: Record<string, unknown>;
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

/** 单个测试点的判定结果，见 SPEC §5.5。 */
export interface CaseResult {
  test: string;
  verdict: Verdict;
  score: number;
  timeMs: number;
  memoryKb: number;
  exitCode: number | null;
  signal: string | null;
  message?: string;
  /** 实际输出与标准答案，供 diff 与报告使用。 */
  output: Buffer;
  answer: Buffer;
  firstDiffLine?: number;
}

export interface SubtaskResult {
  id: string;
  score: number;
  maxScore: number;
  status: 'full' | 'partial' | 'none' | 'skipped';
}

export interface ProblemResult {
  problem: string;
  score: number;
  maxScore: number;
  cases: CaseResult[];
  subtasks: SubtaskResult[];
  elapsedMs: number;
}
