# Bounded diagnostics and queue admission

## Lead rerun

Run `krn ci rerun --pr <n> --head <40-hex-sha> [--repo <owner/repo>]` to queue a fresh Jenkins attempt for the same indexed PR head. Set `KRN_JENKINS_URL` (default `http://127.0.0.1:18080`), `KRN_JENKINS_USER`, and `KRN_JENKINS_TOKEN`; credentials are in Bitwarden item **Jenkins krn-works CI - lead (read+build)**. The command checks the GitHub PR head, pending gate, and Jenkins indexed revision before queueing. The default URL is a loopback tunnel: when it refuses the connection, start `node .krn/runs/ci-platform/lead-access/tunnel.mjs` (forwards 127.0.0.1:18080 via PVE to ci-controller VM109 at 10.254.254.6:8080) and retry; the command names this tunnel in its refusal. Failure-summary changes take effect after the deployment owner repins `library_sha`. Until then `krn deliver` names the cause of a summary without a stage from the check run's `Primary:` line (`failed at stage unknown: <cause>`). The lead account builds PR jobs only, so a failed main gate is not re-run by the lead; the next merge to main runs it again (t-33mv33n).

The trusted library publishes QUEUED before checkout and the global runner lock.
Product PR admission reads `spec/ci-admission.json` from the exact native
`PullRequestSCMRevision.baseHash`, before reserving the runner. The git tree mode
must be `100644` and its size at most 4096 bytes, matching the owning delivery
consumer; strict bounded JSON must contain exactly schema 1,
`krn/gate`, and numeric App 5548482. Missing, old or malformed policy refuses
with an update/reconcile message. PR-head policy, Pipeline and parameters never
choose commands, resource bounds, secrets or this admission. Every PR base is
rechecked with the head before prepare and before SUCCESS. Product's full
`npm run gate` and all draft CI remain required; GLOBAL commands are unchanged.

The lock priority is a checked Java integer:
`-floor(build.startTimeInMillis / 60000) + (main ? 2 : 0)`.
Higher priorities run first; equal priorities retain the plugin's FIFO order.
Main receives two minutes of preference over newly admitted PR builds. A PR
admitted at minute M ties main admitted at M+2 and outranks new main from M+3.
This bounds preference under continuous main traffic. It does not preempt an
active job, guarantee main the next slot under old backlog, or promise a bound
on backlog drain. No scheduling timeout/requeue can fabricate cancellation.
Runtime plugin ordering must be qualified on the recorded lockable-resources
`1579.vf54f8418ffb_2`; local arithmetic tests are not that receiver proof.

## Evidence path

`ci-platform evidence export` uses the existing runner binary, without tokens,
new daemons, archive extraction or reset privileges. It copies a fixed allowlist
of 50 executor-owned diagnostic files from the current UUID directory. Every
directory is opened without following symlinks; every selected file is opened
with no-follow/nonblocking and checked through that descriptor for regular type,
single link, size at most 256 KiB, and unchanged size/mtime after reading. It
never follows receipt paths, walks the source checkout or decompresses input.
Only a fresh output directory is accepted. Maximum export is below 13 MiB,
including generated manifest and summary. The manifest records hashes, sizes
and explicit unavailable/rejected files. Required receipt/gate evidence missing,
or an unsafe optional selected file, makes export fail while retaining other
available diagnostics. Optional setup files may legitimately be absent.

The runner workspace is a unique attempt directory below the existing enrolled
`runner.remote_fs/evidence-export/`, owned by its Jenkins user. Its `finally`
exports and stashes outside the inner gate timeout, including after nonzero exit,
cancel and timeout while the channel permits. The controller unstashes and
archives **before** runner disconnect and cold reset. The executor's selected
stdout, stderr, process and final receipt survive a successful reset. A lost
channel or failed stash/archive is explicit and prevents SUCCESS; reset is
still attempted after ownership/stopped checks. Failed stop leaves quarantine.

`attempt.json` retains the primary error separately from export/verification,
stop and reset errors. Missing evidence or cleanup never becomes SUCCESS. The
GitHub check includes a bounded diagnostic tail (4096 bytes per gate stream,
check text at most 16000 characters) so loopback details URLs are not required
to read a failure. Log content is untrusted diagnostic data. Jenkins keeps
builds at most 14 days/30 builds and artifacts at most 7 days/20 builds per job;
the shorter applicable limit wins. Existing controller workspace retention
remains host-owned; build-discarder does not claim to clean those workspaces.
An outer `timeout_seconds + 300` second envelope bounds runner node allocation,
execution and export together, including channel loss between online readback
and allocation. Inner gate timeout is `timeout_seconds + 120`; export has its
own 60-second timeout outside it. Controller archive/disconnect/reset remain
outside the outer envelope, so an allocation timeout still reaches cleanup.

## Source verification

```sh
cd infra/ci
mise exec -- go test -race ./...
mise exec -- go vet ./...
```

The CLI regressions in `cmd/ci-platform/evidence_test.go` call the real public
dispatcher and filesystem. They cover failed gate diagnostics, limits, replay,
symlink parents and files, hardlinks, FIFO, directories, missing files,
unselected archives, traversal, and strict base admission. Against the previous
dispatcher they fail with `unknown component`, rather than failing compilation.

```sh
java -cp /path/to/jenkins/WEB-INF/lib/groovy-all-2.4.21.jar \
  groovy.ui.GroovyMain infra/ci/jenkins/tests/pipeline_test.groovy .
```

This harness executes the real library script with in-memory Pipeline-step and
Controller receivers. It verifies outcome ordering and primary/secondary errors
for PASS, FAIL, cancel, timeout, unavailable evidence, archive/verification/reset
failure, stale base and queued cancellation. It requires no Jenkins instance,
credentials, extra plugins or installation. It does not emulate CPS, native
stash, the actual lock queue, Check publisher or reset hardware.

## Deployment and native qualification

Only the deployment owner may perform these steps under the existing host
grant. No source-test PASS authorizes deployment or enabling `abortPrevious`.

1. Drain **all Workflow builds including CPS lock/node waiters**, disable new
   scheduling and confirm ledger idle. An empty executor or Jenkins `queue[]`
   alone is insufficient. Do not repin enrollment/control inputs under a build:
   `requireRunnerBinding` hashes them and control `Finish` binds the whole config.
2. Build the additive binary for Linux target architecture with pinned Go and
   preserve/read back its SHA256. Stage it on VM109 control and VM108; update
   VM108's clean cold snapshot through the existing seal process. Old library
   with new binary keeps its existing commands; new library with old binary
   refuses unknown commands. Do not activate the new library before both nodes
   have the new binary. No executor profile schema, Incus image rebuild, new
   credential, network rule or reset forced-command grant is needed.
3. Executor/helper hashes are dynamically measured in `inputs.json` and tools
   probe, not pinned profile fields. PVE `snapshot_sha256` binds VM configuration,
   not disk bytes, so recompute/read back it after sealing; it may remain equal
   after a binary-only disk update. Reconcile any changed manifest copies and
   currentRunnerBinding hashes using the existing procedure. Preserve the old
   known-good binary, snapshot and enrollment for rollback.
4. Compile actual library classes with the installed Jenkins/plugin closure;
   run policy and Pipeline harnesses. Repin the protected central Pipeline,
   trusted library and enrollment `config_sha/library_sha` consistently. Restore
   scheduling only after binding checks pass. These are deployment operations,
   not performed by a source worker.
5. On real VM108/109, run intentional FAIL and native timeout, then manual
   cancellation during gate. For each, capture exact check ID/head/App,
   conclusion, primary and cleanup errors, bounded archived stdout/stderr/process
   and explicit manifest, archive-before-reset ordering, ledger idle and next
   clean PASS. Repeat with runner channel unavailable: unavailable evidence must
   be explicit and never SUCCESS; quarantine/recovery must be observed.
6. Queue real main plus draft PR jobs and older PR waiters across Product/GLOBAL.
   Observe QUEUED on the receiver before lock; main outranks same-minute PR,
   old PR outranks newly arriving main, ties FIFO, active job unpreempted, and
   no draft/check disappears. Refuse an exact stale Product base before prepare
   and show current-base full gate PASS. Source arithmetic alone proves none
   of these native plugin/receiver facts.

`disableConcurrentBuilds()` deliberately leaves `abortPrevious` **OFF**. Only
after the preceding cancellation/reset/next-PASS proof, plus two pushes on the
same PR and concurrent different PR branches with every required exact-head
check present, may a separately reviewed protected Pipeline enable
`disableConcurrentBuilds(abortPrevious: true)`. Superseded cancellation is per
branch job, never cross-repository or cross-PR preemption. A failure to export,
finish/reset or publish the terminal exact-head check blocks enablement.

Rollback drains builds/waiters again, then repins the previous known-good
Pipeline/library/enrollment and matching binary/snapshot/manifest set. Never
mix a new library with an old binary or retarget a prepared ledger to a new
config. Preserve failure archives before restoring. No source-only rollback
claim proves host rollback completion.
