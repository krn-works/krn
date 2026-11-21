krn-review: b5e48ef555b6c650eaa7a1d02f334464e9bfc35c b2a5b40def17bae6304622a2bcb5142f359c7868 tier 2 block

review: block after 190s, 3 finding(s), 1 reproduced, 1 blocking

- **not reproduced** Dropping a lane created before the manifest directory moved leaves its manifest in the started phase. (src/lane/manifest.ts:23, src/lane/manifest.ts:156, src/lane/manifest.ts:290, src/cli/lane.ts:505)
  reproduce: `node --test --test-isolation=none --test-name-pattern='legacy' .krn/tmp/review/lane-retirement.test.ts` exited 1 on the head, 1 on the base
- **not reproduced** Dropping a lane whose worktree Git already removed deletes its remaining branch but leaves its manifest in the started phase. (src/cli/lane.ts:505)
  reproduce: `node --test --test-isolation=none --test-name-pattern='already removed' .krn/tmp/review/lane-retirement.test.ts` exited 1 on the head, 1 on the base
- **reproduced** Dropping a lane with a blocked manifest write fails after deleting the worktree and leaves the branch behind. (src/cli/lane.ts:505, src/lane/manifest.ts:290)
  reproduce: `node --test --test-isolation=none --test-name-pattern='blocked manifest' .krn/tmp/review/lane-retirement.test.ts` exited 1 on the head, 0 on the base

