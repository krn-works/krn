import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const read = (path: string): string => readFileSync(join(root, path), 'utf8');

interface TaskRecord {
  id: string;
  status: string;
  body: string[];
}

function openTrapIds(): string[] {
  const ids: string[] = [];
  for (const name of readdirSync(join(root, 'tasks')).filter((file) =>
    file.endsWith('.json'),
  )) {
    const task = JSON.parse(read(join('tasks', name))) as TaskRecord;
    if (
      task.status === 'open' &&
      task.body.some((entry) => /^Lead trap: /mu.test(entry))
    )
      ids.push(task.id);
  }
  return ids.sort();
}

function section(
  text: string,
  heading: string,
): { body: string; rest: string } {
  const start = text.indexOf(`\n## ${heading}\n`);
  assert.notEqual(start, -1, `the lead skill needs a "## ${heading}" section`);
  const after = text.indexOf('\n## ', start + 1);
  const end = after === -1 ? text.length : after;
  return {
    body: text.slice(start, end),
    rest: text.slice(0, start) + text.slice(end),
  };
}

test('the lead skill lists exactly the open tasks tagged as lead traps', () => {
  const lead = read('.agents/skills/krn-lead/SKILL.md');
  const { body, rest } = section(lead, 'Open traps');
  const listed = [...body.matchAll(/\bt-[0-9a-z]{7}\b/gu)]
    .map((match) => match[0])
    .sort();
  const tagged = openTrapIds();
  assert.deepEqual(listed, tagged);
  // Every listed trap is steered around where the lead acts, not only listed.
  for (const id of tagged)
    assert.ok(rest.includes(id), `${id} needs a workaround in the lead loop`);
});

test('a trap lesson patches the steering instruction in the same slice', () => {
  const retro = read('.agents/skills/krn-retro/SKILL.md');
  assert.ok(retro.includes('Lead trap:'));
  assert.ok(retro.includes('in the same slice'));
  assert.ok(retro.includes('"Open traps"'));
});

// A Markdown prose block (paragraph or list item) outside "Open traps" that names an
// open trap id carries that trap's workaround. It disappears when the fix
// ships, so no other rule test may pin text from it.
function workaroundBlocks(lead: string, ids: string[]): string[] {
  const { rest } = section(lead, 'Open traps');
  const blocks: string[] = [];
  let current: string[] = [];
  // Fenced code is not prose; it belongs to no block. A fence closes only on
  // the opener's character, at least as long, with nothing after it.
  let fence: string | undefined;
  for (const line of rest.split('\n')) {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(line);
    if (fence === undefined && marker?.[1] !== undefined) fence = marker[1];
    else if (
      fence !== undefined &&
      marker?.[1] !== undefined &&
      marker[1][0] === fence[0] &&
      marker[1].length >= fence.length &&
      (marker[2] ?? '').trim() === ''
    )
      fence = undefined;
    else if (fence === undefined) {
      if (/^\s*$|^\s*(?:[-*+]|\d+\.)\s|^\s*[#|]/u.test(line)) {
        blocks.push(current.join(' '));
        current = [];
      }
      if (line.trim() !== '') current.push(line.trim());
      continue;
    }
    blocks.push(current.join(' '));
    current = [];
  }
  blocks.push(current.join(' '));
  return blocks
    .map((block) => block.replace(/\s+/gu, ' '))
    .filter((block) => ids.some((id) => block.includes(id)));
}

const escapes: Record<string, string> = {
  b: '\b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
  v: '\v',
  '0': '\0',
};

// Cooks a JavaScript string or template chunk the way the runtime does.
function cook(raw: string): string {
  return raw.replace(
    /\\(u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|\r\n|[\s\S])/gu,
    (_, sequence: string) => {
      if (sequence.startsWith('u{'))
        return String.fromCodePoint(parseInt(sequence.slice(2, -1), 16));
      if (sequence.length > 1 && /^[ux]/u.test(sequence))
        return String.fromCharCode(parseInt(sequence.slice(1), 16));
      if (['\n', '\r', '\r\n', '\u2028', '\u2029'].includes(sequence))
        return '';
      return escapes[sequence] ?? sequence;
    },
  );
}

const regexKeywords = new Set([
  'case',
  'delete',
  'do',
  'else',
  'in',
  'instanceof',
  'new',
  'of',
  'return',
  'throw',
  'typeof',
  'void',
  'yield',
]);

// Cooked string and template literals of a test source, including every
// static chunk of a template; comments and regular expressions are skipped.
function stringLiterals(source: string): string[] {
  const literals: string[] = [];
  let index = 0;
  const regexAllowed = (): boolean => {
    const before = source.slice(0, index).trimEnd();
    const word = /[\w$]+$/u.exec(before)?.[0];
    if (word !== undefined) return regexKeywords.has(word);
    if (before.endsWith(')')) {
      // `if (x) /re/` starts a regex; `(x) / y` divides.
      let depth = 0;
      for (let at = before.length - 1; at >= 0; at -= 1) {
        if (before[at] === ')') depth += 1;
        else if (before[at] === '(' && --depth === 0) {
          const head = /[\w$]+$/u.exec(before.slice(0, at).trimEnd())?.[0];
          return head !== undefined && /^(?:if|while|for|with)$/u.test(head);
        }
      }
      return false;
    }
    return !before.endsWith(']');
  };
  const quoted = (quote: string): void => {
    const begin = ++index;
    while (index < source.length && source[index] !== quote)
      index += source[index] === '\\' ? 2 : 1;
    literals.push(cook(source.slice(begin, index++)));
  };
  const template = (): void => {
    let begin = ++index;
    while (index < source.length && source[index] !== '`') {
      if (source[index] === '\\') index += 2;
      else if (source.startsWith('${', index)) {
        literals.push(cook(source.slice(begin, index)));
        index += 2;
        code(true);
        begin = index;
      } else index += 1;
    }
    literals.push(cook(source.slice(begin, index++)));
  };
  const regex = (): void => {
    let inClass = false;
    index += 1;
    while (index < source.length && source[index] !== '\n') {
      const char = source[index];
      if (char === '\\') index += 1;
      else if (char === '[') inClass = true;
      else if (char === ']') inClass = false;
      else if (char === '/' && !inClass) break;
      index += 1;
    }
    index += 1;
  };
  function code(untilBrace: boolean): void {
    let depth = 0;
    while (index < source.length) {
      const char = source[index] ?? '';
      if (source.startsWith('//', index)) {
        const end = source.indexOf('\n', index);
        index = end === -1 ? source.length : end;
      } else if (source.startsWith('/*', index)) {
        const end = source.indexOf('*/', index + 2);
        index = end === -1 ? source.length : end + 2;
      } else if (char === "'" || char === '"') quoted(char);
      else if (char === '`') template();
      else if (char === '/' && regexAllowed()) regex();
      else {
        if (char === '{') depth += 1;
        if (char === '}' && depth-- === 0 && untilBrace) {
          index += 1;
          return;
        }
        index += 1;
      }
    }
  }
  code(false);
  return literals
    .map((literal) => literal.replace(/\s+/gu, ' ').trim())
    .filter(
      (literal) => literal.length >= 16 && /\S\s+\S+\s+\S/u.test(literal),
    );
}

test('only this test asserts the text of an open trap workaround', () => {
  const lead = read('.agents/skills/krn-lead/SKILL.md');
  assert.ok(
    section(lead, 'Open traps').body.includes(
      'only `test/rules/lead-traps.test.ts` reads workaround text',
    ),
    'the Open traps section states that only this test reads workaround text',
  );
  const blocks = workaroundBlocks(lead, openTrapIds());
  const pinned: string[] = [];
  const names = readdirSync(join(root, 'test/rules'), { recursive: true })
    .map(String)
    .sort();
  for (const name of names) {
    if (name === 'lead-traps.test.ts' || !/\.test\.[cm]?[jt]s$/u.test(name))
      continue;
    for (const literal of stringLiterals(read(join('test/rules', name))))
      if (blocks.some((block) => block.includes(literal)))
        pinned.push(`${name}: ${JSON.stringify(literal)}`);
  }
  assert.deepEqual(pinned, [], 'rule tests pin open-trap workaround text');
});
