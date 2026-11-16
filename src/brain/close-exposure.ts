// The brain's sink for a closed task: one exposure row, channel `close`, naming the clauses served at
// claim and the PR, Check conclusion and hidden-test result the task ended with.
import { appendExposure, exposureOf } from './exposures.ts';

export function closeExposure(
  main: string,
  evidence: {
    task: string;
    clauses: string[];
    pr: number | null;
    ci: string | null;
    hidden: string | null;
  },
): void {
  appendExposure(
    main,
    exposureOf({
      run: `close-${evidence.task}`,
      task: evidence.task,
      channel: 'close',
      served: evidence.clauses,
      withheld: [],
      laneOk: true,
      evidence: {
        pr: evidence.pr,
        ci: evidence.ci,
        hidden: evidence.hidden,
      },
    }),
  );
}
