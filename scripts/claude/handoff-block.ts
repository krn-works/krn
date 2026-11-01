import { statSync } from 'node:fs';
import { join } from 'node:path';

export type RestartBlockResult = {
  lines: string[];
  problems: string[];
};

const headingPattern = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/u;
const fencePattern = /^ {0,3}(`{3,}(?=[^`]*$)|~{3,})/u;
const fields = ['Verify first', 'Task', 'SHAs', 'Done when'] as const;

function heading(line: string) {
  const match = headingPattern.exec(line);
  if (!match) return undefined;
  const title = (match[2] ?? '').replace(/[ \t]+#+[ \t]*$/u, '').trim();
  return { level: match[1]?.length ?? 0, title };
}

function documentLines(text: string) {
  return text.replace(/^\uFEFF/u, '').split(/\r\n|\r|\n/u);
}

function taskFileExists(root: string, id: string): boolean {
  try {
    return statSync(join(root, 'tasks', `${id}.json`)).isFile();
  } catch {
    return false;
  }
}

function findSections(
  lines: string[],
  title: string,
  caseSensitive = false,
): number[] {
  const sections: number[] = [];
  let fence: string | undefined;
  for (const [index, line] of lines.entries()) {
    if (fence) {
      const close = fencePattern.exec(line)?.[1];
      if (
        close !== undefined &&
        close[0] === fence[0] &&
        close.length >= fence.length &&
        line.trim() === close
      )
        fence = undefined;
      continue;
    }
    const open = fencePattern.exec(line)?.[1];
    if (open) {
      fence = open;
      continue;
    }
    const parsed = heading(line);
    if (
      parsed?.level === 2 &&
      (caseSensitive
        ? parsed.title === title
        : parsed.title.toLowerCase() === title.toLowerCase())
    )
      sections.push(index);
  }
  return sections;
}

function sectionEnd(lines: string[], start: number): number {
  for (let index = start + 1; index < lines.length; index++) {
    const parsed = heading(lines[index] ?? '');
    if (parsed && parsed.level <= 2 && parsed.title) return index;
  }
  return lines.length;
}

/** Return the exact operator-request section for inclusion in restart context. */
export function operatorRequestsSection(text: string): string[] | undefined {
  const lines = documentLines(text);
  const sections = findSections(lines, 'Operator requests');
  if (sections.length !== 1) return undefined;
  const start = sections[0];
  if (start === undefined) return undefined;
  let end = sectionEnd(lines, start);
  while (end > start + 1 && !(lines[end - 1] ?? '').trim()) end--;
  return lines.slice(start, end);
}

function originalRangeLength(
  text: string,
  lines: string[],
  start: number,
  end: number,
): number {
  const source = text.replace(/^\uFEFF/u, '');
  let offset = 0;
  let rangeStart = 0;
  for (let index = 0; index < end; index++) {
    if (index === start) rangeStart = offset;
    offset += (lines[index] ?? '').length;
    if (index + 1 >= end) continue;
    if (source.startsWith('\r\n', offset)) offset += 2;
    else if (source[offset] === '\r' || source[offset] === '\n') offset++;
  }
  return offset - rangeStart;
}

function requestQuoteProblems(text: string): string[] {
  const section = operatorRequestsSection(text);
  if (!section) return [];
  const problems: string[] = [];
  for (const [index, line] of section.slice(1).entries()) {
    const bullet = /^[-*+][ \t]+(.*)$/u.exec(line);
    if (!bullet) continue;
    const request = bullet[1] ?? '';
    if (/^none\.?$/iu.test(request) || /^closed:[ \t]+\S/iu.test(request))
      continue;
    if (!/(?:"[^"\r\n]+"|„[^”\r\n]+”)/u.test(request))
      problems.push(
        `Operator requests line ${index + 2} must quote the operator's words in double quotes`,
      );
  }
  return problems;
}

/** Parse and validate the handoff's first level-two restart section. */
export function restartBlock(text: string, root: string): RestartBlockResult {
  const lines = documentLines(text);
  const problems: string[] = [];
  let firstLevelTwo: number | undefined;
  let fence: string | undefined;
  for (const [index, line] of lines.entries()) {
    if (fence) {
      const close = fencePattern.exec(line)?.[1];
      if (
        close !== undefined &&
        close[0] === fence[0] &&
        close.length >= fence.length &&
        line.trim() === close
      )
        fence = undefined;
      continue;
    }
    const open = fencePattern.exec(line)?.[1];
    if (open) {
      fence = open;
      continue;
    }
    if (heading(line)?.level === 2) {
      firstLevelTwo = index;
      break;
    }
  }

  const start = findSections(lines, 'Restart block', true)[0];
  if (start === undefined) problems.push('Restart block section is missing');
  if (firstLevelTwo === undefined || start !== firstLevelTwo)
    problems.push('Restart block must be the first level-two heading');

  let blockLines: string[] = [];
  if (start !== undefined) {
    let end = sectionEnd(lines, start);
    while (end > start + 1 && !(lines[end - 1] ?? '').trim()) end--;
    blockLines = lines.slice(start, end);
    if (originalRangeLength(text, lines, start, end) > 2000)
      problems.push('Restart block section must be at most 2000 characters');
    const content = blockLines.slice(1);
    if (content.length !== 4)
      problems.push(
        'Restart block must contain exactly four lines and no extra content',
      );

    for (const [index, field] of fields.entries()) {
      const prefix = `- ${field}:`;
      const matches = content.filter((line) => line.startsWith(prefix));
      if (matches.length === 0) {
        problems.push(`Restart block is missing the ${field} field`);
        continue;
      }
      if (matches.length > 1) {
        problems.push(`Restart block has a duplicate ${field} field`);
        continue;
      }
      const value = matches[0] ?? '';
      let valid = false;
      if (field === 'Verify first' || field === 'Done when') {
        const command = /^- (?:Verify first|Done when): `([^`\r\n]+)`$/u.exec(
          value,
        )?.[1];
        valid = command !== undefined && command.trim().length > 0;
      } else if (field === 'Task') {
        const id = /^- Task: (t-[a-z0-9]{7})$/u.exec(value)?.[1];
        valid = id !== undefined && taskFileExists(root, id);
        if (id !== undefined && !valid)
          problems.push(
            `Restart block Task field refers to missing tasks/${id}.json`,
          );
      } else {
        valid =
          /^- SHAs: main=[0-9a-fA-F]{40}(?:, [^,\s=]+=[0-9a-fA-F]{40})*$/u.test(
            value,
          );
      }
      if (!valid && !(field === 'Task' && value.startsWith('- Task: t-')))
        problems.push(`Restart block ${field} field is invalid`);
      if (content[index] !== value)
        problems.push(`Restart block ${field} field is out of order`);
    }

    for (const line of content) {
      if (!fields.some((field) => line.startsWith(`- ${field}:`))) {
        problems.push('Restart block contains a line outside its four fields');
        break;
      }
    }
  } else {
    for (const field of fields)
      problems.push(`Restart block is missing the ${field} field`);
  }

  const requestSections = findSections(lines, 'Operator requests');
  if (requestSections.length === 0)
    problems.push('Operator requests section is missing');
  else if (requestSections.length > 1)
    problems.push(
      `Operator requests section must appear exactly once (found ${requestSections.length})`,
    );
  problems.push(...requestQuoteProblems(text));
  return {
    lines: problems.length === 0 ? blockLines : [],
    problems,
  };
}
