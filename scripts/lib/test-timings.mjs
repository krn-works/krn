import { isAbsolute, relative, sep } from 'node:path';

const compare = (left, right) => (left < right ? -1 : left > right ? 1 : 0);

// Count a parent once, rather than charging its nested tests a second time.
// Terminal failures belong in the ranking just like passes. Missing timings
// are omitted, not invented as zero-duration measurements.
export function slowestTests(events, root = process.cwd()) {
  // The preload wraps registrations, so `file` may name the wrapper.
  // Native entryFile identifies the actual test file in both runner modes.
  return events
    .filter(
      ({ type, data }) =>
        (type === 'test:pass' || type === 'test:fail') &&
        data?.nesting === 0 &&
        typeof data.name === 'string' &&
        typeof (data.entryFile ?? data.file) === 'string' &&
        Number.isFinite(data.details?.duration_ms) &&
        data.details.duration_ms >= 0,
    )
    .map(({ data }) => {
      const file = data.entryFile ?? data.file;
      return {
        name: data.name,
        file: (isAbsolute(file) ? relative(root, file) : file)
          .split(sep)
          .join('/'),
        duration_ms: data.details.duration_ms,
      };
    })
    .sort(
      (left, right) =>
        right.duration_ms - left.duration_ms ||
        compare(left.file, right.file) ||
        compare(left.name, right.name),
    )
    .slice(0, 10);
}

export function formatSlowestTests(tests) {
  const cell = (value) => value.replaceAll('|', '\\|').replace(/[\r\n]/gu, ' ');
  return [
    '## Slowest tests (top-level)',
    '',
    ...(tests.length === 0
      ? ['No test durations recorded.']
      : [
          '| Test | File | Seconds |',
          '| --- | --- | ---: |',
          ...tests.map(
            ({ name, file, duration_ms }) =>
              `| ${cell(name)} | ${cell(file)} | ${(duration_ms / 1000).toFixed(3)} |`,
          ),
        ]),
    '',
  ].join('\n');
}
