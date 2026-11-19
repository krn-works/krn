---
name: workstation
description: Keep the workstation toolchain at one mise version per tool, the newest stable, pinned the same in every project, and audit it with one command. Use when installing, updating or pinning a developer tool (node, pnpm, go, python, uv, codex, claude, gh, playwright), editing ~/.config/mise, a mise.toml, .tool-versions, .node-version or packageManager, writing a hook or script that runs a tool, or when versions diverge.
compatibility: Requires mise and node on PATH; the audit only reads.
---

# Workstation

One tool, one version, everywhere: the newest stable release, installed once by mise.

## Rules

1. **mise owns developer tools.** Global exact pins live in `~/.config/mise/config.toml`; a project pins in its `mise.toml` (or `.tool-versions`). Never install a developer tool with pacman, yay, `npm -g`, `pipx`, `go install` or a copied binary in `~/.local/bin` beside mise; remove such a duplicate once mise provides the tool. pacman and yay stay for system packages only, and the distribution's own python stays. Scripts never run `mise use -g`.
2. **The newest stable release.** Pin exact versions, never `latest`, a range or a prerelease (keep a prerelease only when no stable exists or the stable is older, and say why in the config comment).
3. **Projects pin the global version.** A project pin differs from the global pin only with a written reason in the same file. `package.json` `packageManager`, `.node-version`, `.nvmrc`, `engines` and the CI tool version move with the mise pin in the same commit.
4. **A bump is one sweep, in this order:** global pin → every project (pin, `packageManager`, lockfile, CI version) on its own branch through that repository's delivery workflow → install → that repository's gate. A red gate reverts that repository only and is reported with the failing output; never skip a repository because the jump is large. Only after every repository is green: `mise prune` (never a version a running process uses, e.g. the claude or codex binary of a live session: check `pgrep -a`).
5. **Hooks and scripts resolve tools through mise.** Agent sessions can put mise tool paths after `/usr/bin`, so a system copy wins. A hook puts the pinned tool's directory first: `PATH="$(mise where pnpm@<pinned>):$PATH"`, failing with the install command when it is missing.
6. **Do not edit the distribution's mise file** (`/etc/mise/conf.d/*`) by hand; use the omarchy skill. Its `latest` entries float: a project pin follows the version they currently resolve to.
7. **Temporary configs are not projects.** Run experiments under the scratchpad or `.krn/tmp`, and when done delete them; mise keeps tracking their `mise.toml` and `mise prune` then keeps their versions.
8. Secrets stay out of configs, repositories and logs; use environment variables or Bitwarden (`bw`).

## Audit

Run the read-only audit after any toolchain change and on every session that touches tooling:

```sh
node <krn checkout>/scripts/toolchain-audit.ts --root <dir holding the repositories> [--root <dir>...]
```

It prints one line per finding, then `toolchain PASS` (exit 0) or `toolchain FAIL (<counts>)` (exit 1):

- `outdated <file> <tool> <pinned> -> <newest>`: a global or project pin, `packageManager` or `.node-version` behind the newest stable (mise decides stable; a newer prerelease pin is not flagged).
- `multi <tool> <versions>`: several versions installed; after the sweep, `mise prune` removes the unused ones.
- `backend <name>`: one tool installed through two backends (e.g. `playwright` and `npm:playwright`); keep one.
- `path <name>`: a copy outside mise on PATH; remove it with its own package manager.
- `tracking <n>`: temporary configs that keep versions alive; delete the temporary directories.
- `error <dir>`: mise could not read a project (usually an untrusted config); trust it or report it.

Report the verdict line and what you changed to the operator; a FAIL you leave is listed with its reason.
