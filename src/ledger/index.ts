// Local delivery contracts are independent of task status and review publication.
export type Contract = Readonly<{
  issueId: string;
  identifier: string;
  title: string;
  description: string;
  revision: string;
  targetRepo: string;
  checks: readonly string[];
}>;
