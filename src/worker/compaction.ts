import { z } from 'zod';
import { codexTurnFailure } from './failure.ts';
import { WorkerError } from './state.ts';

type Frame = {
  method?: string | undefined;
  params?: Record<string, unknown> | undefined;
};

/** The notification source a compaction waits on: CodexAppServer.wait. */
export type Frames = {
  wait(
    predicate: (frame: Frame) => boolean,
    timeoutMs: number,
    stopped?: () => boolean,
  ): Promise<Frame>;
};

const compactionItem = z.object({ type: z.literal('contextCompaction') });
const turnSchema = z.object({
  id: z.string(),
  status: z.string().max(64),
  error: z
    .object({ codexErrorInfo: z.unknown().optional() })
    .nullable()
    .optional(),
});

function settle(frame: Frame): void {
  const turn = turnSchema.safeParse(frame.params?.turn);
  if (!turn.success) throw new WorkerError(65, 'invalid app-server response');
  if (turn.data.status === 'completed') return;
  if (turn.data.status === 'failed') {
    const failed = codexTurnFailure(turn.data.error?.codexErrorInfo);
    throw new WorkerError(
      75,
      `worker compaction failed: ${failed.class}`,
      failed,
    );
  }
  throw new WorkerError(75, 'worker compaction interrupted or failed');
}

/**
 * Waits after thread/compact/start until the compaction is over. Codex 0.167.0
 * runs it as a turn of its own (test/fixtures/codex-app-server/compact.rpc):
 * its contextCompaction item completes first and its turn/completed after, so
 * a turn started in between overlaps it. A failed compaction turn ends the
 * wait at once with its failure class; the deprecated thread/compacted, which
 * names no compaction turn, ends it alone.
 */
export async function awaitCompaction(
  frames: Frames,
  threadId: string,
  remaining: () => number,
  stopped: () => boolean,
): Promise<void> {
  const own = (frame: Frame) => frame.params?.threadId === threadId;
  const first = await frames.wait(
    (frame) =>
      own(frame) &&
      (frame.method === 'thread/compacted' ||
        frame.method === 'turn/completed' ||
        (frame.method === 'item/completed' &&
          compactionItem.safeParse(frame.params?.item).success)),
    remaining(),
    stopped,
  );
  if (first.method === 'thread/compacted') return;
  if (first.method === 'turn/completed') return settle(first);
  const turnId = first.params?.turnId;
  if (typeof turnId !== 'string') return;
  settle(
    await frames.wait(
      (frame) =>
        own(frame) &&
        frame.method === 'turn/completed' &&
        z.object({ id: z.literal(turnId) }).safeParse(frame.params?.turn)
          .success,
      remaining(),
      stopped,
    ),
  );
}
