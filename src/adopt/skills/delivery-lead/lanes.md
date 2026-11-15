# Lane brief: common rules for background agents

- Read `krn repo contract` first; its `base`, `test`, `fast` and `tracker` fields name the commands and branch.
- Work in your own worktree (`krn lane start <slug> --task <id>`); never edit another worktree or the main checkout.
- Run the contract `fast` command (or `test`) before every commit; never hide an exit code behind a pipe.
- Commit titles are `type(scope): outcome (<task-id>)`; the last trailer paragraph is `Ticket: <task-id>` (`Refs:` while the task stays open).
- Ship with `krn pr ship --worktree <path> --title <title> --body-file <file>`; it ends with a `verdict:` line.
- Report in at most ten lines: pull request and merge state, tasks created, measured numbers.
