import type { Subtask } from '../model';

/**
 * 按依赖顺序排列子任务（Kahn），同层保持声明顺序。
 *
 * 加载期用它做环检测，计分时用它决定先算谁——依赖还没算完，就无从判断该不该 skip。
 * 依赖不存在、id 重复、成环这三种情况都会算出错误的分数，所以一律抛错，不静默放过。
 */
export function topoOrderSubtasks(subtasks: Subtask[]): Subtask[] {
  const byId = new Map<string, Subtask>();
  for (const subtask of subtasks) {
    if (byId.has(subtask.id)) {
      throw new Error(`子任务 id "${subtask.id}" 重复了`);
    }
    byId.set(subtask.id, subtask);
  }

  const remaining = new Map<string, number>();
  for (const subtask of subtasks) {
    for (const dependency of subtask.dependsOn) {
      if (!byId.has(dependency)) {
        throw new Error(`子任务 "${subtask.id}" 依赖了不存在的子任务 "${dependency}"`);
      }
    }
    remaining.set(subtask.id, subtask.dependsOn.length);
  }

  const ordered: Subtask[] = [];
  const emitted = new Set<string>();
  let progressed = true;
  while (ordered.length < subtasks.length && progressed) {
    progressed = false;
    for (const subtask of subtasks) {
      if (emitted.has(subtask.id) || remaining.get(subtask.id) !== 0) {
        continue;
      }
      emitted.add(subtask.id);
      ordered.push(subtask);
      progressed = true;
      for (const other of subtasks) {
        if (other.dependsOn.includes(subtask.id)) {
          remaining.set(other.id, (remaining.get(other.id) ?? 0) - 1);
        }
      }
    }
  }

  if (ordered.length < subtasks.length) {
    const stuck = subtasks.filter((subtask) => !emitted.has(subtask.id)).map((subtask) => subtask.id);
    throw new Error(`子任务依赖成环：${stuck.join(' → ')}`);
  }
  return ordered;
}
