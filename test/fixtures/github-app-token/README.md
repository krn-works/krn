Verbatim captures (KRN-12) of the GitHub App `krn-works-delivery` installation token on krn-works/krn,
2026-11-10, taken in the launcher's environment (`scripts/app-bin` on PATH, git credential helper
`scripts/github-app-token.ts git-credential`). Tokens are redacted.

- `mint-expiry.txt`: a mint, cache reuse, a new token after the cached one expired, token scope krn only.
- `workflow-push.txt`: a push that edits a workflow file is refused (no `workflows` permission).
- `ruleset-put.txt`: `gh api -X PUT` on the repository ruleset is refused (HTTP 403).
- The pull request that added this directory was shipped by `krn pr ship` under the App credential; its
  author on GitHub is `krn-works-delivery[bot]`.
- `repo-installation.txt`: `GET /repos/{owner}/{repo}/installation` with the App JWT, 2026-11-11: 200 with the installation `id` on krn-works/krn, 404 on a repository the App is not installed on (success bodies trimmed to id, account, selection and slug).
