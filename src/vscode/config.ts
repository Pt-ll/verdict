import * as path from 'node:path';
import * as vscode from 'vscode';
import { DEFAULT_LIMITS, type ComparatorConfig, type Limits } from '../core/model';
import type { EngineOptions } from '../engineFacade';
import { workspaceRoot } from './workspace';

const SETTINGS_SECTION = 'verdict';

/** 用户在设置里指定的编译器路径；空字符串表示自动探测。 */
export function readCompilerSetting(): string {
  return (vscode.workspace.getConfiguration(SETTINGS_SECTION).get<string>('compiler') ?? '').trim();
}

/**
 * 把编辑器设置读成内核参数。
 *
 * core 层不能 import vscode（AGENTS 分层），所以设置由这一层读好、当作普通参数传进去；
 * 评测与调试都从这里取参数，免得两边读到的限制不一致。
 */
export function readEngineOptions(context: vscode.ExtensionContext): EngineOptions {
  const config = vscode.workspace.getConfiguration(SETTINGS_SECTION);
  const memoryMb = config.get<number>('defaultMemoryMb') ?? DEFAULT_LIMITS.memoryMb;
  const limits: Limits = {
    timeMs: config.get<number>('defaultTimeMs') ?? DEFAULT_LIMITS.timeMs,
    memoryMb,
    // 栈上限默认与内存上限同值，与 SPEC §6.3 的 problem.json 示例一致。
    stackMb: memoryMb,
    outputKb: config.get<number>('outputLimitKb') ?? DEFAULT_LIMITS.outputKb,
  };

  const comparator: ComparatorConfig = {
    mode: config.get<'default' | 'line' | 'real'>('comparator') ?? 'default',
    absEps: config.get<number>('realAbsEps'),
    relEps: config.get<number>('realRelEps'),
  };

  const testlibPath = (config.get<string>('testlibPath') ?? '').trim();

  return {
    compilerPath: readCompilerSetting(),
    flags: config.get<string[]>('flags') ?? [],
    limits,
    comparator,
    cacheDir: path.join(context.globalStorageUri.fsPath, 'cache'),
    // 题目包的向上查找以工作区为界，别让工作区外的文件一路找到用户主目录去。
    workspaceRoot: workspaceRoot(),
    ...(testlibPath.length === 0 ? {} : { testlibPath }),
  };
}
