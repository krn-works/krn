import ci.Controller
import ci.CheckoutPolicy
import ci.QueuePolicy
import groovy.json.JsonOutput
import groovy.json.JsonSlurperClassic
import org.jenkinsci.plugins.workflow.steps.FlowInterruptedException

def call(def sourceScm) {
    Map enrollment = Controller.enrollment(currentBuild.rawBuild)
    Map identity = Controller.sourceIdentity(currentBuild.rawBuild, enrollment)
    String attempt = UUID.randomUUID().toString()
    Map spec = [repo_id: identity.entry.repo_id, source_sha: identity.source_sha,
        config_sha: identity.entry.config_sha, image_fingerprint: identity.entry.image_fingerprint,
        attempt_id: attempt, tier: identity.entry.tier,
        timeout_seconds: identity.entry.timeout_seconds, memory_mib: identity.entry.memory_mib,
        process_limit: identity.entry.process_limit]
    String work = '/var/lib/ci-control/workspaces/' + attempt
    boolean prepared = false
    boolean gatePassed = false
    boolean cleaned = false
    boolean accepted = false
    boolean evidenceStashed = false
    boolean evidenceComplete = false
    boolean evidenceArchived = false
    List problems = []
    def failure = null
    String conclusion = 'FAILURE'
    String stage = 'admission'
    String diagnostic = 'Runner evidence unavailable: execution has not started.'
    try {
        // A waiting build is visible before checkout or the single global slot.
        publishChecks(name: identity.entry.check_name, status: 'QUEUED', conclusion: 'NONE',
            summary: "Attempt ${attempt}; queued; source ${identity.source_sha}; base ${identity.base_sha ?: 'not-required'}")
        Controller.readback(currentBuild.rawBuild, identity, 'QUEUED', null)
        if (failure == null && problems.isEmpty()) { stage = 'checkout' }
        node('control') {
            if (env.NODE_NAME != 'control') { error('Control label resolved to a different node') }
            ws(work) {
                dir('source') {
                    withEnv(CheckoutPolicy.environment()) {
                        checkout(Controller.checkoutScm(sourceScm, currentBuild.rawBuild, identity))
                    }
                    String actual = sh(returnStdout: true, script: 'git rev-parse HEAD').trim()
                    if (actual != identity.source_sha) { error('Checkout differs from exact admitted head') }
                    sh 'test "$(git rev-parse --is-shallow-repository)" = false'
                    if (spec.tier == 'product' && identity.pull_request) {
                        // Inspect the native SCMRevisionAction's exact base, never HEAD
                        // policy or a moving main ref. Git objects are data, not code.
                        int admission = sh(returnStatus: true, script: """#!/bin/sh
set -eu
mode=\$(git ls-tree '${identity.base_sha}' -- spec/ci-admission.json | cut -d ' ' -f 1)
case \"\$mode\" in 100644) ;; *) exit 1 ;; esac
size=\$(git cat-file -s '${identity.base_sha}:spec/ci-admission.json')
test \"\$size\" -le 4096
git show '${identity.base_sha}:spec/ci-admission.json' > ../base-policy.json
exec /usr/local/libexec/ci-platform admission product-base < ../base-policy.json
""")
                        if (admission != 0) {
                            error('Exact Product base CI policy is missing or incompatible; update branch from main or reconcile base CI policy')
                        }
                    }
                    if (spec.tier != 'product') {
                        if (identity.pull_request) {
                            spec.base_sha = identity.base_sha
                        } else {
                            spec.base_sha = sh(returnStdout: true, script: '''#!/bin/sh
set -eu
git rev-parse --verify 'HEAD^1^{commit}' 2>/dev/null || git rev-parse --verify 'HEAD^{commit}'
''').trim()
                        }
                        if (!(spec.base_sha ==~ /[0-9a-f]{40}/)) { error('GLOBAL requires a resolved full base SHA') }
                        sh """#!/bin/sh
set -eu
git cat-file -e '${spec.base_sha}^{commit}'
git update-ref refs/ci/base '${spec.base_sha}'
"""
                    }
                    sh '''#!/bin/sh
set -eu
git -c core.hooksPath=/dev/null bundle create ../source.bundle --all HEAD
git -c core.hooksPath=/dev/null bundle verify ../source.bundle
'''
                    if (spec.tier != 'product') {
                        String bundledBase = sh(returnStdout: true, script: 'git bundle list-heads ../source.bundle refs/ci/base').trim()
                        if (bundledBase != spec.base_sha + ' refs/ci/base') { error('Bundle does not contain the pinned GLOBAL base commit') }
                    }
                }
                writeFile(file: 'job.json', text: JsonOutput.toJson(spec) + '\n')
            }
        }
        int priority = QueuePolicy.priority(currentBuild.startTimeInMillis as long, identity.pull_request as boolean)
        if (failure == null && problems.isEmpty()) { stage = 'allocation' }
        lock(resource: 'ci-runner', priority: priority) {
            try {
                if (failure == null && problems.isEmpty()) { stage = 'execution' }
                publishChecks(name: identity.entry.check_name, status: 'IN_PROGRESS', conclusion: 'NONE',
                    summary: "Attempt ${attempt}; source ${identity.source_sha}; base ${identity.base_sha ?: 'not-required'}")
                Controller.readback(currentBuild.rawBuild, identity, 'IN_PROGRESS', null)
                Controller.requireCurrentHead(currentBuild.rawBuild, identity)
                Controller.requireNoRunner()
                node('control') {
                    ws(work) {
                        Controller.requireRunnerBinding(currentBuild.rawBuild, enrollment)
                        String output = sh(returnStdout: true, script: """#!/bin/sh
set -eu
exec /usr/local/libexec/ci-platform control prepare --config /etc/ci-platform/control.json --spec '${work}/job.json' --bundle '${work}/source.bundle' --state-dir /var/lib/ci-control --execute
""")
                        Map receipt = new JsonSlurperClassic().parseText(output) as Map
                        if (receipt.ok != true || receipt.phase != 'prepared' || receipt.attempt_id != attempt) {
                            error('Prepare receipt does not match this attempt; quarantine remains')
                        }
                        prepared = true
                    }
                }
                Controller.requireRunnerBinding(currentBuild.rawBuild, enrollment)
                Controller.registerRunner(enrollment.runner as Map, attempt)
                timeout(time: 2, unit: 'MINUTES') { waitUntil { Controller.runnerOnline(attempt) } }
                // Bound allocation as well as execution/export if the channel
                // disappears between runnerOnline and entering node('runner').
                timeout(time: spec.timeout_seconds + 300, unit: 'SECONDS') {
                    node('runner') {
                        if (env.NODE_NAME != 'runner') { error('Runner label resolved to a different node') }
                        ws(enrollment.runner.remote_fs + '/evidence-export/' + attempt) {
                            try {
                                timeout(time: spec.timeout_seconds + 120, unit: 'SECONDS') {
                                    int status = sh(returnStatus: true, script: '''#!/bin/sh
set -eu
test ! -e receipt.json
exec /usr/local/libexec/ci-platform executor --profile /var/lib/ci-input/profile.json --spec /var/lib/ci-input/job.json --bundle /var/lib/ci-input/source.bundle --evidence-root /var/lib/ci-evidence --mode gate --execute > receipt.json
''')
                                    if (status == 124) { conclusion = 'TIME_OUT' }
                                    if (status != 0) { error("Executor returned ${status}") }
                                    if (failure == null && problems.isEmpty()) { stage = 'export' }
                                }
                            } finally {
                                // Outside the gate timeout. A dead channel is explicit and
                                // does not prevent subsequent controller cleanup/quarantine.
                                try {
                                    timeout(time: 1, unit: 'MINUTES') {
                                        int status = sh(returnStatus: true, script: """#!/bin/sh
set -eu
exec /usr/local/libexec/ci-platform evidence export --root /var/lib/ci-evidence --attempt-id '${attempt}' --output "\$PWD/ci-evidence"
""")
                                        evidenceComplete = status == 0
                                        stash(name: 'executor-evidence', includes: 'ci-evidence/*', useDefaultExcludes: false)
                                        evidenceStashed = true
                                        if (!evidenceComplete) { problems.add('Evidence export incomplete; export.json records unavailable files') }
                                    }
                                } catch (Exception problem) {
                                    problems.add('Runner evidence unavailable: ' + problem.toString().take(1000))
                                }
                            }
                        }
                    }
                }
            } catch (Exception problem) {
                failure = problem
            } finally {
                if (failure == null && problems.isEmpty()) { stage = 'export' }
                // Native stash crosses to the controller BEFORE disconnect/cold reset,
                // also after nonzero executor, cancellation and timeout.
                try {
                    node('control') {
                        ws(work) {
                            if (evidenceStashed) {
                                unstash('executor-evidence')
                                diagnostic = readFile(file: 'ci-evidence/summary.txt').take(12000)
                                if (failure == null && problems.isEmpty()) { stage = 'evidence-archive' }
                                archiveArtifacts(artifacts: 'ci-evidence/*', fingerprint: false, allowEmptyArchive: false)
                                evidenceArchived = true
                                if (failure == null && evidenceComplete) {
                                    if (failure == null && problems.isEmpty()) { stage = 'verify' }
                                    sh """#!/bin/sh
set -eu
exec /usr/local/libexec/ci-platform control verify --config /etc/ci-platform/control.json --spec '${work}/job.json' --receipt '${work}/ci-evidence/receipt.json'
"""
                                    gatePassed = true
                                }
                            } else {
                                diagnostic = 'Runner evidence unavailable: no stash reached the controller.'
                                problems.add(diagnostic)
                            }
                        }
                    }
                } catch (Exception problem) {
                    problems.add('Controller evidence/verification failed: ' + problem.toString().take(1000))
                    if (failure == null) { failure = problem }
                }
                boolean stopped = false
                try {
                    if (failure == null && problems.isEmpty()) { stage = 'runner-stop' }
                    Controller.disconnectRunner(attempt)
                    timeout(time: 2, unit: 'MINUTES') { waitUntil { Controller.runnerStopped(attempt) } }
                    Controller.removeRunner(attempt)
                    stopped = true
                } catch (Exception problem) {
                    problems.add('Runner stop failed; quarantine remains: ' + problem.toString().take(1000))
                    if (failure == null) { failure = problem }
                }
                if (prepared && stopped) {
                    try {
                        if (failure == null && problems.isEmpty()) { stage = 'finish' }
                        node('control') {
                            Controller.requireRunnerBinding(currentBuild.rawBuild, enrollment)
                            sh """#!/bin/sh
set -eu
exec /usr/local/libexec/ci-platform control finish --config /etc/ci-platform/control.json --attempt-id '${attempt}' --state-dir /var/lib/ci-control --execute
"""
                            cleaned = true
                        }
                    } catch (Exception problem) {
                        problems.add('Final reset failed; quarantine remains: ' + problem.toString().take(1000))
                        if (failure == null) { failure = problem }
                    }
                }
                // Preserve the primary error AND evidence/cleanup errors, even when
                // a later reset error would otherwise replace the gate exception.
                try {
                    if (failure == null && problems.isEmpty()) { stage = 'archive' }
                    node('control') {
                        ws(work) {
                            writeFile(file: 'attempt.json', text: JsonOutput.toJson([
                                attempt_id: attempt, source_sha: identity.source_sha, base_sha: identity.base_sha,
                                gate_verified: gatePassed, cleanup_verified: cleaned,
                                evidence_stashed: evidenceStashed, evidence_complete: evidenceComplete,
                                evidence_archived: evidenceArchived, primary_error: failure?.toString()?.take(1000),
                                secondary_errors: problems]) + '\n')
                            archiveArtifacts(artifacts: 'attempt.json', fingerprint: false, allowEmptyArchive: false)
                        }
                    }
                } catch (Exception problem) {
                    problems.add('Attempt report archive failed: ' + problem.toString().take(1000))
                    if (failure == null) { failure = problem }
                }
            }
            if (failure != null) { throw failure }
            if (!gatePassed || !cleaned || !evidenceComplete || !evidenceArchived || !problems.isEmpty()) {
                error('Gate, evidence export/archive or final reset is incomplete' + (problems.isEmpty() ? '' : ': ' + problems[0]))
            }
            if (failure == null && problems.isEmpty()) { stage = 'head-check' }
            Controller.requireCurrentHead(currentBuild.rawBuild, identity)
            if (failure == null && problems.isEmpty()) { stage = 'publish' }
            publishChecks(name: identity.entry.check_name, status: 'COMPLETED', conclusion: 'SUCCESS',
                summary: "Gate, archived evidence and final reset verified; source ${identity.source_sha}; base ${identity.base_sha ?: spec.base_sha ?: 'not-required'}; attempt ${attempt}", text: diagnostic)
            Controller.readback(currentBuild.rawBuild, identity, 'COMPLETED', 'SUCCESS')
            accepted = true
        }
    } catch (FlowInterruptedException interrupted) {
        conclusion = interrupted.causes.any { it.class.simpleName == 'ExceededTimeout' } ? 'TIME_OUT' : 'CANCELED'
        currentBuild.result = 'ABORTED'
        failure = interrupted
    } catch (Exception problem) {
        currentBuild.result = 'FAILURE'
        failure = problem
    } finally {
        if (!accepted) {
            try {
                String cause = failure == null ? 'unverified' : failure.class.simpleName + ': ' + (failure.message ?: '')
                cause = cause.split(/[\r\n]/, 2)[0].replaceAll(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/, ' ').take(300)
                publishChecks(name: identity.entry.check_name, status: 'COMPLETED', conclusion: conclusion,
                    summary: "Attempt ${attempt} failed at stage ${stage}: ${cause}; base=${identity.base_sha ?: spec.base_sha ?: 'not-required'}; gate=${gatePassed}; cleanup=${cleaned}; evidence=${evidenceArchived && evidenceComplete}",
                    text: ("Attempt ${attempt} failed at stage ${stage}: ${cause}\nPrimary: ${failure?.toString()?.take(1000) ?: 'unverified'}\n" + problems.join('\n') + '\n\n' + diagnostic).take(16000))
                Controller.readback(currentBuild.rawBuild, identity, 'COMPLETED', conclusion)
            } catch (Exception ignored) { echo('Failure check publication is unverified') }
        }
    }
    if (failure != null) { throw failure }
    if (!accepted) { error('No accepted gate result') }
}
