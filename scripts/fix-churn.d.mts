export type Commit = { subject: string; files: string[] };
export const WINDOW_DAYS: number;
export const FILE_LIMIT: number;
export const TASK_LIMIT: number;
export function isSource(path: string): boolean;
export function distinct(subjects: readonly string[]): number;
export function churn(commits: readonly Commit[]): {
  files: Map<string, string[]>;
  tasks: Map<string, string[]>;
};
export function checkFixChurn(input: {
  title: string;
  body?: string;
  changed: string[];
  commits: readonly Commit[];
  taskExists?: (id: string) => boolean;
}): {
  ok: boolean;
  overridden: boolean;
  findings: string[];
  problems: string[];
};
export function readHistory(
  git: (...args: string[]) => string,
  base: string,
): Commit[];
