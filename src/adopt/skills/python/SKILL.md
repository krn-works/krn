---
name: python
description: Write, review or change Python code: typing, packaging, pytest tests, virtual environments, parsing input at the edge. Use whenever the task touches .py files, pyproject.toml or requirements; skip for repositories with no Python.
compatibility: Works in any Python repository; reads the test command from `krn repo contract` and uses the repository's own virtual environment, never a global install.
---

# Python

Use the repository's own interpreter and runner; do not install packages globally.

## Rules

1. **Run the contract.** `krn repo contract` gives the `test` command (for example `.venv/bin/python -m pytest`); run it before and after each change.
2. **Test pure functions.** A pytest test calls one function with a hand-written input and asserts a computed value; deleting the production line must turn it red.
3. **Parse at the edge.** Input from files, environment or argv enters as plain data and is validated once; inside, trust the validated type.
4. **Type the public surface.** Annotate public function signatures; keep `Any` out of them.
5. **Small modules.** One concern per module; import the owner, do not re-export.
6. **Allowed commands.** `python -m pytest`, `python -m pip install -e .` inside the repository's venv, `python -m ruff check` when configured.
