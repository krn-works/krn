import test from "node:test";
import assert from "node:assert/strict";
import { gitDiffDigest } from "../src/adapters/git-diff.ts";

test("gitDiffDigest summarizes a modified file from raw + numstat output", () => {
  const stdout = Buffer.from(":100644 100644 aaaa bbbb M\0a.txt\0" + "2\t1\ta.txt\0");
  const digest = gitDiffDigest({
    request: { argv: ["git", "diff", "main", "HEAD"] },
    exitCode: 0,
    signal: null,
    durationMs: 1,
    stdout,
    stderr: new Uint8Array(),
    rawEventId: "evt-1",
    stdoutReceipt: { hash: "h", bytes: stdout.length },
    stderrReceipt: { hash: "e", bytes: 0 },
  });
  assert.equal(digest.kind, "git-diff");
  assert.equal(digest.base, "main");
  assert.equal(digest.head, "HEAD");
  assert.equal(digest.file_summaries.length, 1);
  assert.equal(digest.file_summaries[0].path, "a.txt");
  assert.equal(digest.file_summaries[0].status, "M");
  assert.equal(digest.file_summaries[0].additions, 2);
  assert.equal(digest.file_summaries[0].deletions, 1);
});
