// One owner for the handoff's consolidated resume block: the fields krn-handoff requires and
// the section text SessionStart injects.
export const resumeFields = [
  {
    name: 'Task',
    pattern: /^\s*-\s+Task:\s*(?:`?)(t-[a-z0-9]{7})\b/imu,
  },
  {
    name: 'SHAs',
    pattern: /^\s*-\s+SHAs?:\s*.*\b[0-9a-f]{7,40}\b/imu,
  },
  { name: 'Verify', pattern: /^\s*-\s+Verify:\s*`[^`\n]+`/imu },
  // Every handoff reranks docs/program/roadmap.md or says why not.
  {
    name: 'Roadmap',
    pattern:
      /^\s*-\s+Roadmap:\s*(?:unchanged\s+\(\s*[^)\s][^)]*\)|.*\bR\d+\b)/imu,
  },
];

// Roadmap entry ids (R1, R2, ...) a handoff's "- Roadmap:" line names as changed.
export function roadmapIds(text: string): string[] {
  const line = /^\s*-\s+Roadmap:(.*)$/imu.exec(section(text, 'Resume') ?? '');
  if (!line || /^\s*unchanged\b/iu.test(line[1] ?? '')) return [];
  return [...(line[1] ?? '').matchAll(/\bR\d+\b/gu)].map((match) => match[0]);
}

function lines(text: string): string[] {
  return text.replace(/^﻿/u, '').split(/\r\n|\r|\n/u);
}

// Lines of a level-two section, without its heading, up to the next level-one or level-two heading.
export function section(text: string, title: string): string | undefined {
  const body: string[] = [];
  let inside = false;
  let fence = false;
  for (const line of lines(text)) {
    if (/^ {0,3}(`{3,}|~{3,})/u.test(line)) fence = !fence;
    const heading = fence
      ? null
      : /^ {0,3}(#{1,2})[ \t]+(.*?)[ \t#]*$/u.exec(line);
    if (heading) {
      if (inside) break;
      inside =
        heading[1] === '##' &&
        heading[2]?.toLowerCase() === title.toLowerCase();
      continue;
    }
    if (inside) body.push(line);
  }
  return inside ? body.join('\n').trim() : undefined;
}

// Names every required field the handoff's "## Resume" section lacks.
export function resumeProblems(text: string): string[] {
  const resume = section(text, 'Resume');
  if (resume === undefined)
    return [
      'no "## Resume" section with "- Task: <id>", "- SHAs: <sha...>", "- Verify: `<command>`" and "- Roadmap: <R ids changed> | unchanged (<reason>)"',
    ];
  return resumeFields
    .filter((field) => !field.pattern.test(resume))
    .map(
      (field) =>
        `"## Resume" lacks "- ${field.name}:" (Task: t-id; SHAs: hex 7-40; Verify: backticked command; Roadmap: R ids changed in docs/program/roadmap.md or "unchanged (<reason>)")`,
    );
}

// The block SessionStart injects: resume plus operator requests verbatim, bounded.
export function resumeBlock(text: string, limit: number): string | undefined {
  const parts = [
    ['Resume', section(text, 'Resume')],
    ['Operator requests', section(text, 'Operator requests')],
  ].flatMap(([title, body]) => (body ? [`${title}:\n${body}`] : []));
  if (parts.length === 0) return undefined;
  const block = `Handoff (run the Verify command before any other step):\n${parts.join('\n')}`;
  return block.length > limit ? `${block.slice(0, limit - 1)}…` : block;
}
