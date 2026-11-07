export function percentile(values: number[], q: number): number | undefined;
export function analyze(capture: unknown[]): {
  stages: Map<string, number[]>;
  counts: Record<string, number> & { reruns: number };
};
export function renderReport(analysis: ReturnType<typeof analyze>): string;
export function collect(first: number, last: number): unknown[];
