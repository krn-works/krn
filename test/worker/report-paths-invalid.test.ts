import { test } from 'node:test';
import { checkReportPaths } from './report-consistency-fixture.ts';

test('report refuses paths outside the repository and control characters', async (t) => {
  await checkReportPaths(t, ['outside', 'control']);
});
