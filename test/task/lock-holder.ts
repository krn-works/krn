import { writeSync } from 'node:fs';
import { claimTask, onTaskLockAcquired } from '../../src/task/claims.ts';
import type { TaskId } from '../../src/task/record.ts';

// Test child: claim a task through the lock seam and hold the lock forever,
// telling the parent over fd 3 once the lock is held.
const [root, id] = process.argv.slice(2) as [string, TaskId];
onTaskLockAcquired(async () => {
  writeSync(3, 'locked\n');
  await new Promise<void>(() => {});
});
await claimTask(root, id, { actor: 'holder', worktree: root });
