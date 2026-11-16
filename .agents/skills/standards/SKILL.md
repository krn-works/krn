---
name: standards
description: Look up the repository's engineering standards before you write, change or review code: run `krn standards query` with what you are doing and the files you touch, and follow the ranked records it prints. Use at the start of an edit, before a new pattern or dependency, and when unsure what the repository requires; skip for pure reading.
compatibility: Requires the krn CLI on PATH and git; works in any repository stack, reading the records of the repository's own standards store.
---

# Standards

The repository's rules live as records in its standards store, not as prose. Ask the store for the ones that apply to what you are doing now: `krn standards query "<what you are doing>" --file <path>`.

- Describe the action in a few words (`add a zod schema for the config file`) and pass every file you will edit with `--file`; add `--stack <stack>` to name the stack, `--budget <tokens>` to cap the answer and `--json` when a tool reads the result.
- Follow each record printed: its text is a requirement, its `why` is the reason, and a record with an enforcement command names the check that runs at Stop.
- Query again when the task moves to other files or a new kind of change; the answer is scoped to the files and words you give.
- `krn standards --help` lists the other verbs (`check`, `review`, `propose`); `krn standards review` prints `file:line` for each violation in your diff before you stop.
- A rule that is missing, wrong or in the way is not edited around: propose it with `krn standards propose`, and say so in your report.
