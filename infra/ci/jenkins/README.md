# Jenkins controller and protected job

The supplied enrollment examples remain **unenrolled, disabled seeds**.
Historical pilot evidence records Jenkins **2.580.2**, Temurin **21.0.13+9**
and the complete 78-plugin closure now preserved in `plugins.txt` and
`plugins.lock.json` (artifact digests and source provenance). This is not a fresh
host inventory or acceptance of subsequent changes. Qualify
[`diagnostics and queue changes`](diagnostics-and-queue.md) on the real receiver.
No installer, credentials, cloud provisioner or automatic job is supplied.

`controller.yaml` preserves zero built-in executors, disabled inbound agent TCP,
admin-only permissions and disabled signup. Provide nonempty admin credentials
through the installation's external secret source. Keep Configure, Replay,
Script Console, credential administration and central configuration writes
admin-only. A Build identity must have explicit build authorization; do not
leave all builds running as SYSTEM or grant general Build access to agents.

## Protected definition and enrollment

The Multibranch source is the product's GitHub Branch Source, with origin PR
HEAD discovery (`OriginPullRequestDiscoveryTrait(strategyId: 2)`) and the
explicitly enrolled main branch. Forks and other branches fail admission.
Use the source's enrolled GitHub App for native **HTTPS** checkout, exclusively
on the trusted `control` agent on the controller VM. Both attempts to add
read-only source deploy keys were rejected with HTTP 422, `Deploy keys are
disabled for this repository`; the repository/organization policy stays intact.
There is no source SSHCheckoutTrait or separate source key requirement.
The approved App installation covers only the two enrolled repositories, with
Contents read, Pull requests read, Metadata read and Checks write. No new scopes
or repository access are required. Source admission verifies the credential's
native GitHubAppCredentials type and App ID against the protected enrollment;
the source and credential API endpoint must be GitHub.com. The native GitSCM
remote must be HTTPS, credential-free in its URL and use that same source App.

The App token is materialized by the native plugin only for trusted control
checkout; the private key is never exported by this library. No token binding,
custom auth broker or checkout exists on `runner`: it receives only the verified
bundle/config/spec. The App's Checks write authority remains in the controller
trust domain. Native `publishChecks` has no SHA/credential selector: it uses
this source's App and SCMRevisionAction. Automatic Status API notifications stay
disabled, so this change does not request Commit statuses write permission.

For a central library stored in the other enrolled repository, do not select
`Infer accessible repository` for its App credential: native library inference
would restrict it to the product SCM repository. Use the credential's existing
owner strategy with an installation restricted to the approved two repositories,
or `Specify accessible repositories` limited to those same two. This changes no
App scopes or organization policy. See the plugin's native App documentation.

Use Remote Jenkinsfile Provider as the branch factory, central Git SCM at an
exact protected commit, script `infra/ci/jenkins/Pipeline.groovy`,
`matchBranches=false`, `lookupInParameters=false`. The early `def sourceScm=scm`
creates the product revision action before explicit publication. Set source
Status Checks Properties to `skip=true`, `skipNotifications=true`; these turn
off automatic Checks and legacy Status API respectively. There is no default
green or automatic JUnit publisher.

Configure one **Global Trusted Pipeline Library** named `owned-ci`, implicitly
loaded, default version the same full central commit SHA, version override
disabled, Modern SCM retrieval and
`libraryPath=infra/ci/jenkins/library/`. This is an explicit trust grant: the
library may call controller Java APIs. Remote Provider's Jenkinsfile is still
sandboxed; a folder library would also be untrusted. Never load a library or
Pipeline definition from product SCM or allow a PR to select its revision.

Install a root-owned, non-symlink, nonsecret enrollment file at exactly
`/etc/ci-platform/jenkins-enrollment.json`; parents must also be root-owned and
not group/world writable. The supplied `jenkins-enrollment.unenrolled.json`
refuses execution. Enabled enrollment has `schema_version:1`, `enabled:true`,
`library_sha` (40 lowercase hex), and `repositories` keyed by canonical
`owner/repo`. Each entry needs:

- `job`: exact parent Multibranch full name; `repo_id`: numeric repository ID
  as a string; `app_id`: numeric publishing App ID as a string.
- `config_sha`: same SHA as `library_sha`; `image_fingerprint`: 64 lowercase
  hex; `main_branch`: explicit protected branch; `check_name`: enrolled check.
- `tier`: product for the existing single-job Product entry; integer `timeout_seconds` (30–7200),
  `memory_mib` (256–6144), `process_limit` (64–4096).

GLOBAL uses the same repository fields but replaces top-level `job`, `tier`
and `check_name` with `jobs`, keyed by exact parent Multibranch full name.
There must be exactly two entries: `global-fast` / `gate (fast)` and
`global-deep` / `gate (deep)`. The selected job's trusted fields overlay the
common repository fields. `jenkins-enrollment.global.unenrolled.json` is a
disabled example with empty identities and credential identifiers. Configure
two native Multibranch jobs, both using the same protected Pipeline and source;
their parent names select the tier. There are no PR parameters or scheduler
loops. Both remain serialized by the existing global lock. The legacy Product
single-job entry is unchanged; a single GLOBAL entry fails admission.

Top-level `runner` supplies fixed `host`, integer `port`, SSH `credentials_id`,
`host_key` for ManuallyProvidedKeyVerificationStrategy and absolute `remote_fs`.
Only credential identifiers and public host keys belong here, never secrets.
The separate `/etc/ci-platform/control.json` owns PVE reset/transport/profile
configuration. Before any publication/checkout/reset/transfer, the library reads
that root-owned, non-symlink configuration and its root-owned
`/etc/ci-platform/runner_known_hosts`; all parents must also be root-owned and
not writable by others. The runner host must equal enrollment exactly, the Go
transport's fixed port must be 22, and both its user and the native SSH
credential username must be `jenkins`. The deployment contract fixes the
credential ID to `ci-runner-ssh`. No private key contents are read or compared.

The known_hosts file must contain one non-comment, explicit literal runner
host entry (no hashes, aliases, wildcards, certificate markers or extra keys).
Its algorithm/base64 public key must equal enrollment's `host_key`. The library
keeps hashes of both files and rechecks them immediately before prepare,
agent registration and finish. Missing/mismatched pins fail before transport;
changes during an attempt quarantine it. Do not edit these root-owned inputs
while an attempt is active. Go independently owns its full configuration and
SSH-file trust checks. No build parameters select configurations, identities,
resource limits, labels, URLs, commands or credentials.

## One slot, two agent roles

Enroll only the persistent `control` node: one executor, EXCLUSIVE, native
CommandLauncher starting a trusted agent locally on the controller VM. Its
filesystem and tools are protected. It runs Git checkout/bundle, root-owned Go
control CLI and receipt validation; it executes no product scripts. Source Git
checkout is constructed anew for both Product and GLOBAL. Only exact native
GitSCMSourceDefaults, BuildChooserSetting with the native specific-revision
chooser, and CloneOption are accepted as input extensions; all others,
including SubmoduleOption and GitLFSPull, fail before authenticated checkout.
The accepted objects are not inherited: the library creates its own exact-SHA
chooser, full native CLI clone without a reference path, empty legacy
submodule configuration and explicit SubmoduleOption with disable=true and
parentCredentials=false. PR `.gitmodules` therefore never triggers a submodule
update. A fixed checkout environment disables system/global Git configuration,
hooks, recursion, local-file transport and LFS smudge. Product has no bypass.

The runner VM and its identity are fixed, but its Jenkins registration is
**ephemeral**: `OwnedRunner extends Slave implements EphemeralNode`, native
SSHLauncher, one exclusive executor, literal name `runner`. Do not persist a
runner node in JCasC, UI or an init script. Core NOOP retention calls connect at
startup; an ephemeral registration prevents that restart reconnect. NOOP
launches once when this wrapper registers it after prepare, and does not
periodically reconnect. No cloud or dynamic VM allocation is involved.

Every job publishes QUEUED before checkout and the age-prioritized
`lock(resource: 'ci-runner', priority: ...)`. The lock covers preparation,
execution, evidence archival, cleanup and success publication. The wrapper
refuses any existing runner
registration instead of adopting/replacing it. Full checkout and bundle happen
only on `control`, under a UUID directory
`/var/lib/ci-control/workspaces/<attempt>/`. Hash-bound JobSpec is created from
SCM revision plus enrollment. All PRs pin their admission base directly from
`PullRequestSCMRevision.getBaseHash()`; missing/invalid PR base fails without
falling back to main. In native HEAD mode this is the revision's tracked base,
which the plugin documents as the PR base/common ancestor, not a newly fetched
main tip. GLOBAL main resolves full `HEAD^1` after complete checkout, falling
back to `HEAD` for a root commit, matching the workflow's parent/root policy.

The GLOBAL GitSCM retains pinned branches and recreates an exact-SHA chooser, retaining
the enrolled App HTTPS credential, adds `+refs/heads/*:refs/remotes/origin/*`, and
forces a full clone. Checkout SHA is asserted again. The selected base must
exist as a commit; `refs/ci/base` explicitly includes it in the complete bundle,
and bundle list-heads must advertise that exact SHA. Only then is JobSpec
written and prepare called. Product checks its exact base policy before the
lock, without adding a required base field to its executor JobSpec.
Success/failure check summaries record the full base when resolved.

The fixed interfaces are:

```text
ci-platform control prepare --config /etc/ci-platform/control.json --spec ABS/job.json --bundle ABS/source.bundle --state-dir /var/lib/ci-control --execute
ci-platform control finish --config /etc/ci-platform/control.json --attempt-id UUID --state-dir /var/lib/ci-control --execute
ci-platform control verify --config /etc/ci-platform/control.json --spec ABS/job.json --receipt ABS/ci-evidence/receipt.json
ci-platform evidence export --root /var/lib/ci-evidence --attempt-id UUID --output ABS/ci-evidence
ci-platform admission product-base < ABS/base-policy.json
```

Prepare must return `{ok:true,phase:"prepared",attempt_id:UUID,...}` only after
reset/readback and delivery of `/var/lib/ci-input/{source.bundle,job.json,profile.json}`.
The runner executes only the fixed `/usr/local/libexec/ci-platform executor`
argv in `library/vars/ownedCi.groovy`. Selected bounded diagnostics and its JSON
receipt cross back through stash/unstash and archive before reset, including
after failed execution where the channel permits. Verify exit zero must mean
the complete exact-attempt gate passed; unavailable evidence prevents SUCCESS.
Finish exit zero must mean a committed second reset, never transport-only success.

Finally blocks stop scheduling, disconnect, wait for channel closure and zero
current executables, remove only this owned registration, and finish only a
successfully prepared attempt. A failed prepare, disconnect timeout, killed
controller or missing finish remains DIRTY in the Go ledger. The next prepare
must refuse it; lock release is not fencing or recovery. Restart removes the
ephemeral node; a resumed attempt may finish/reset, but cannot turn missing gate
evidence into a pass. Independent operator reconciliation owns dirty attempts.

Success requires gate verify + finish, fresh source head, explicit native
COMPLETED/SUCCESS, and receiver readback of this run's check ID, repo ID, SHA,
App ID, external ID and conclusion. The native plugin catches publication IO
errors, so a returned step is insufficient. Failure/cancel/timeout publish an
explicit non-success conclusion when possible; failure publication itself can
remain unverified. There is no false claim of success after an API failure.

## Qualification still required

Source tests are separate from native runtime qualification. Static
checks do not certify the eventual plugin lock, CPS serialization, node class
loading, SSH connect/disconnect, cancellation/restart, source checkout or native
Check API receiver. Run the protected job on the allocated test VM and exercise
PASS, nonzero gate, timeout, cancel, controller loss, failed cleanup, dirty
admission and failed publication before enabling PR traffic. Confirm no runner
node config survives restart and no App/reset credential reaches its VM.

This does not change Actions-specific KRN admission or branch protection.
Cutover requires its separately reviewed producer integration and real exact-head
check evidence. Build the enrolled main commit after merge. No gate weakening,
synthetic success or billing/bootstrap purchase is included.

Focused verification (no install, credentials or Jenkins registration):

```sh
python3 infra/ci/jenkins/tests/checkout_receiver_test.py
java -cp "$CI_JENKINS_TEST_CLASSPATH" groovy.ui.GroovyMain infra/ci/jenkins/tests/policy_test.groovy
```

The Python receiver reproduces a malicious `.gitmodules` network request and
a hostile global smudge filter, then checks actual Git with the production
checkout environment. The Groovy suite uses compiled library classes and the
installed Jenkins/plugin jars supplied by the operator in the named classpath;
it tests actual extension rejection/sanitization, pinned revision and runner
host/port/user/credential/public-key mismatches. It needs no live Jenkins
instance, private key or source App. A successful compiler alone is not this
test or end-to-end pipeline acceptance.

Native interface references:
[Remote Provider](https://plugins.jenkins.io/remote-file/),
[native App authentication and checkout](https://github.com/jenkinsci/github-branch-source-plugin/blob/master/docs/github-app.adoc),
[HTTPS SCM builder](https://github.com/jenkinsci/github-branch-source-plugin/blob/master/src/main/java/org/jenkinsci/plugins/github_branch_source/GitHubSCMBuilder.java),
[SCMVar revision binding](https://github.com/jenkinsci/workflow-multibranch-plugin/blob/master/src/main/java/org/jenkinsci/plugins/workflow/multibranch/SCMVar.java),
[PR baseHash API](https://github.com/jenkinsci/github-branch-source-plugin/blob/master/src/main/java/org/jenkinsci/plugins/github_branch_source/PullRequestSCMRevision.java),
[trusted libraries](https://www.jenkins.io/doc/book/pipeline/shared-libraries/),
[Checks step](https://www.jenkins.io/doc/pipeline/steps/checks-api/),
[EphemeralNode save boundary](https://github.com/jenkinsci/jenkins/blob/master/core/src/main/java/hudson/model/Node.java),
[NOOP startup behavior](https://github.com/jenkinsci/jenkins/blob/master/core/src/main/java/hudson/slaves/RetentionStrategy.java).

## Go executor API and CLI

The root CLI delegates `executor` verbatim to
`executor.Main(args, in, out, err) int`. The same statically built Linux binary
is copied into the container as `/opt/ci/executor`; private `executor __guest`
operations require that path, an Incus systemd guest and the appropriate UID.
There is no Python runtime dependency. API callers use
`Plan(Profile, JobSpec, Options)` then `Execute(ctx, plan, transport)`; plan
inputs and command arrays are copied. `ProcessTransport` clears inherited
environment and invokes argument arrays directly. Unit tests use a fake
transport and never invoke host Incus/systemd.

```text
ci-platform executor --profile /trusted/profile.json --spec /admitted/job.json \
  --bundle /admitted/source.bundle --evidence-root /evidence --mode preflight
ci-platform executor --profile /trusted/profile.json --spec /admitted/job.json \
  --bundle /admitted/source.bundle --evidence-root /evidence --mode gate --execute
```

Without `--execute`, commands only print a plan. `--spec -` reads the spec
from stdin; profile must be an explicit regular file. Paths must be canonical,
absolute and free of symlinks. Execution creates a new UUID-named evidence
directory and refuses replay. `--mode gate` always does the cheap preflight
first; no eight-variant matrix runs automatically.

`Profile` JSON has `repo_id` (numeric string), `config_sha` (40 lowercase hex),
`image_fingerprint` and `image_manifest_sha256` (64 lowercase hex),
`incus_package_revision`, `project`, `storage_pool`, `cpu_count`, `root_gib`,
`vm_memory_mib`, `vm_headroom_mib`, `max_job_memory_mib`, `max_job_processes`,
`git_name`, `git_email`, and `gates`. Each gate has `tier`, `argv` and
`summary_prefix`. Product must be `["npm","run","gate"]` with
`KRN_TEST_SUMMARY_JSON=`. GLOBAL fast/deep require exact reviewed argv/prefix;
no GLOBAL command is guessed or defaulted. No environment or secret fields are
accepted. Profiles are trusted configuration; syntax validation does not
authenticate their provenance. The supervisor must deliver protected copies.

`JobSpec` fields are `repo_id`, `source_sha`, `config_sha`, `image_fingerprint`,
`attempt_id` (canonical UUIDv4), `tier`, `timeout_seconds` (30–7200),
`memory_mib` (256–6144), `process_limit` (64–4096). Profile caps apply too.
CPU is 1–4, root disk 8–64 GiB, VM headroom at least 1536 MiB, and job cap +
headroom must fit the declared VM. Runtime probes check available memory.

Image prerequisites: systemd/PAM/logind, `ci` UID/GID 1000 and `/home/ci`, Git,
bwrap and reviewed gate toolchains. `/opt/ci/image-manifest.json` is a bounded
JSON object matching the profile's hash. The executor records the full actual
Incus package revision; Debian **6.0.4-2+deb13u11 already includes the known
2624 fix**. Its default does no apt install/upgrade or fallback image build.
The profile must pin the actual installed revision, not merely `6.0.4`.

The disposable container has no inherited profiles or network device, an
isolated unprivileged idmap, guest API/nesting disabled, CPU/memory/pids/disk
caps and swap disabled. Readback rejects extra devices, raw configuration and
injected environment. Bundles are verified in a new repository, fetched with
full history, checked out detached at the requested commit, then asserted again
before and after gate. Dependency/tool preparation must already be in the
qualified image; this harness performs no network checkout or installation.

The production path is `incus exec ... systemd-run --wait --pipe --collect
--service-type=exec --expand-environment=no -p PAMName=login -p User=ci ...`.
Preflight captures UID/HOME/cwd/PATH/XDG/bus/cgroup, verifies loginctl, a user
scope and the exact bwrap argv. Small user units enforce 64 MiB/no-swap and
16 tasks: a touched-memory child must be OOM-killed and at most 24 blocked cat
children must hit the pids limit. It also requires deliberate exit23 to cross
the same production transport unchanged. These destructive small probes run
only in the explicitly executed disposable guest. They have **not run on a
target VM**, so session/cgroup/Incus qualification is still pending.

The gate wrapper emits a typed command receipt and parses exactly one prefixed
JSON summary from gate output, even after the bounded log fills. Summary schema
is `{version:1, success:true, counts:{tests,passed,failed,skipped,todo,cancelled},
files:[{file,tests,passed,failed,skipped,todo,cancelled}]}`. Counts must agree;
tests must be positive and all nonpass counts zero. Missing receipt/probe/
summary, signal, timeout, failed setup or cleanup cannot yield PASS. Exit23,
128+signal and timeout124 are retained; infrastructure failures return nonzero.
Per-stream logs are drained but stored only up to 256 KiB, hashed with SHA256,
and captured before ownership-checked deletion under an independent deadline.

PR code shares the job's UID and can falsify job-authored summaries/receipts.
These are execution observations, **not independent acceptance or a cryptographic
attestation**. The external supervisor/publisher must authenticate provenance,
check complete gate coverage and obtain independent review. Local fake transport
fixtures prove argument/result contracts, not vendor/runtime behavior. Exact
Incus API/CLI and logind compatibility still require target qualification.

Pinned syntax references: [Incus 6.0.4 source](https://github.com/lxc/incus/tree/v6.0.4/cmd/incus),
[systemd-run](https://www.freedesktop.org/software/systemd/man/systemd-run.html).
The supplied controller research owns the candidate versions; no fresh version
selection or compatibility certification was performed here.
