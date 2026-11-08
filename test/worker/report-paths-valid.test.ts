import { test } from 'node:test';
import { checkReportPaths } from './report-consistency-fixture.ts';

test('report normalizes dot and absolute paths', async (t) => {
  await checkReportPaths(t, ['dot', 'absolute']);
});
