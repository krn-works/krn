# CI on owned infrastructure

Status: the baseline has historical native Product pilot evidence on VM108/109;
that does not qualify subsequent source changes or describe fresh host state.
The diagnostics/queue changes require the qualification in
[`jenkins/diagnostics-and-queue.md`](jenkins/diagnostics-and-queue.md).
The baseline is one persistent Jenkins controller, one static PVE
runner VM and one serial job slot. The VM is powered off and restored to its
enrolled disk snapshot between attempts. Incus supplies an unprivileged system
container inside that VM. No new paid services are part of this baseline.

The trusted executor profile may explicitly set `nesting:true` when the gate
needs nested user/PID/mount namespaces (including bubblewrap mounting procfs).
It defaults to false and is not a JobSpec/PR parameter. This relaxes the inner
LXC restrictions; it never enables privileged LXC, host mounts, NICs or guest
API. Use it only inside the dedicated VM with complete cold snapshot reset
between attempts. Actual P0, full gate and reset qualification remain required;
a standalone bwrap prototype is not admission for untrusted PRs. The tools
probe waits at most 30 seconds for real systemd-logind readiness before PAM.

## Implementation

`ci-platform` is a Linux Go binary using only the standard library. Go is
pinned by `mise.toml`. No Python runtime, third-party Go modules, installer,
credential discovery, GitHub write or firewall apply is included.

```sh
cd infra/ci
make check
make build
./bin/ci-platform reset validate --manifest examples/runner.unenrolled.json
```

The last command **must fail**: the example has no allocated VM, UUID, storage,
network or policy hash. Enrollment must bind these to observed infrastructure.
`make build` produces the binary for the build machine's architecture; deployment
must explicitly build and verify the correct Linux architecture and checksum.

`network.documentation.json` uses RFC 5737 documentation addresses solely to
exercise rendering; they are not allocations. `network render --config FILE
--format nft` and `--format interfaces` print inert text. The binary has no
`network apply` command. `network digest --prefix NAME` reads captured
`nft --json list ruleset` from stdin; `verify` additionally needs `--sha256`.

| Component | Implemented boundary | Still requires host qualification |
| --- | --- | --- |
| `internal/reset` | Fixed enrolled VM, snapshot and all disk identities; host/owner/HA/policy checks; persistent generation and flock; cold rollback, stopped readback, start and new boot ID | Exact installed PVE/QGA output, snapshot support for every disk, timeout/recovery behavior |
| `internal/network` | Validated configuration, scoped nft/bridge and interfaces rendering, owned-table digest | IPAM, integration with existing firewall, real packet tests and boot ordering |
| `internal/executor` | Immutable job identity, approved command tiers, Incus execution and cleanup accounting | Image, actual logind session, cgroups, DNS, process exit/signal/timeout cases on the allocated runner |
| `jenkins/` | Controller and trusted pipeline seed | Credential enrollment, exact plugin lock, lifecycle adapter and check publisher |

## Reset authority and protocol

The controller alone holds the SSH reset key. The runner has no PVE reset key,
GitHub write token or controller credentials. `authorized_keys.example` is a
forced-command template, not an installation command. Keep the wrapper, binary,
manifest and their parent directories root-owned and unwritable by other users;
the ledger directory must additionally be private. `reset serve` requires root
and `--execute`; it rejects any SSH original command and accepts a bounded JSON
request on stdin, never shell fragments or job parameters.

```json
{"request_id":"22222222-2222-4222-8222-222222222222","expected_generation":0,"manifest_sha256":"<enrolled canonical manifest digest>"}
```

A generation is reserved and fsynced before any effects. Same-request retries
return a committed receipt; uncertain attempts never become ready by replay.
Recovery requires a new request acknowledging the current generation and a full
reset. Requests for later jobs must use a new ID. The controller must bind each
receipt to one authorized job attempt and persist that consumption. Concurrent,
stale or rate-limited requests cannot start a reset. Failure blocks admission;
after verified identity the helper also attempts to stop only the enrolled VM.
A stop failure is reported, not treated as successful containment. A killed
helper can leave an uncertain operation: the controller must keep the slot
closed until reconciliation. There is no guarantee that a timed-out PVE task
has stopped merely because its CLI process ended.

The snapshot manifest covers the root disk, the separate disk carrying Incus
LVM thin storage, EFI and TPM volumes when present, and explicitly enrolled
read-only media. Memory snapshots, disk exclusions, passthrough, extra NICs,
external writable mounts and automatic HA/onboot start are refused. The hash
of configuration binds topology, not the contents or immutability of a storage
snapshot; qualify storage and root-owned snapshot management separately.

The nft hash covers both owned tables; counters and handles are volatile. It
does not certify rules outside these tables. A periodic guard has a detection
window, so it cannot be described as instantaneous fail-closed isolation.

## Admission is deliberately incomplete

Do not connect untrusted PRs to this seed. Before enabling Jenkins execution,
implement and qualify the controller-owned single-slot lifecycle adapter:
reserve an authorized attempt; reset and verify its receipt; bring up exactly
one trusted agent; deliver a credential-free exact-SHA bundle; collect the
result; terminate the agent; reset again on success, failure, timeout, cancel
and controller recovery. The next attempt must stay blocked on cleanup failure.
The runner must never call the reset helper itself. A reset receipt alone is
not evidence that a gate passed.

The publisher must use a separate controller-only GitHub App and bind repo,
source/config/image identity, attempt and check ID before publishing an actual
outcome. It must handle duplicate/out-of-order events and stale PR heads. Gates
remain blocking until that boundary, exact-head testing and post-merge main
build are implemented. No arbitrary PR Jenkinsfile is evaluated.

Existing KRN delivery code still assumes GitHub Actions as a producer; generic
ship also considers latest checks from every producer. This package changes
none of those gates. A separate reviewed ADR and code change must address
admission and rollback without fake checks or disabling protection. No billing
unblock or paid bootstrap is assumed.

## Deployment boundary

Only local code/configuration/tests are authorized here. Allocating CI VMIDs,
bridges/subnets/storage, applying host rules, installing binaries, taking the
clean snapshot, provisioning keys/App, triggering GitHub runs and cutting over
repository rules require their recorded, specific grants. None are performed
by these commands. Start qualification with a separate test VM on CI bridges,
never on a client bridge, and never reboot production PVE as a test.

Budget proposal: controller 2 vCPU/4 GiB; runner 4 vCPU/8 GiB; one job at a time.
This is a proposal, not a reserved capacity or measured gate P95. Product,
GLOBAL and the other fleet repositories require separate workload manifests;
macOS/Windows are not covered by a Linux runner. Cache/artifact quota and
retention must fit existing storage; no paid artifact service is assumed.
