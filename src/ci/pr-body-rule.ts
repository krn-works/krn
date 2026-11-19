/**
 * The parts a pull request body must carry: a `## Why` and a `## Verified` section, each with
 * text under it, and, in a repository that tracks work in tasks/, a `Ticket:` or `Refs:` line.
 * Returns one sentence per missing part; an empty list means the body is accepted. `krn pr ship`
 * and the CI step that reads PR_BODY both call it, so a body edited after the ship is caught.
 */
export function bodyProblems(
  body: string,
  options: { tracked?: boolean } = {},
): string[] {
  const problems: string[] = [];
  for (const heading of ['Why', 'Verified']) {
    const section = new RegExp(
      `^## ${heading}[ \\t]*\\r?\\n([\\s\\S]*?)(?=^## |(?![\\s\\S]))`,
      'mu',
    ).exec(body);
    if (section === null) problems.push(`missing a "## ${heading}" section`);
    else if ((section[1] ?? '').trim() === '')
      problems.push(`"## ${heading}" section is empty`);
  }
  if (
    options.tracked !== false &&
    !/^(?:Ticket|Refs):[ \t]*t-[a-z0-9]+[ \t]*\r?$/mu.test(body)
  )
    problems.push('missing a "Ticket: <task id>" or "Refs: <task id>" line');
  return problems;
}
