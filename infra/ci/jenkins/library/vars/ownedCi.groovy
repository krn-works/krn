import ci.Controller
import ci.CheckoutPolicy
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
    def failure = null
    String conclusion = 'FAILURE'
    lock(resource: 'ci-runner') {
        try {
            publishChecks(name: identity.entry.check_name, status: 'IN_PROGRESS', conclusion: 'NONE',
                          summary: "Attempt ${attempt}; source ${identity.source_sha}; base ${identity.base_sha ?: 'pending/not-required'}")
            Controller.readback(currentBuild.rawBuild, identity, 'IN_PROGRESS', null)
            try {
                Controller.requireNoRunner()
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
                            if (spec.tier != 'product') {
                                if (identity.pull_request) {
                                    spec.base_sha = identity.base_sha
                                } else {
                                    // Main has no webhook PUSH_BASE; root commit uses HEAD.
                                    spec.base_sha = sh(returnStdout: true, script: '''#!/bin/sh
set -eu
git rev-parse --verify 'HEAD^1^{commit}' 2>/dev/null || git rev-parse --verify 'HEAD^{commit}'
''').trim()
                                }
                                if (!(spec.base_sha ==~ /[0-9a-f]{40}/)) {
                                    error('GLOBAL requires a resolved full base SHA')
                                }
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
                                String bundledBase = sh(returnStdout: true,
                                    script: 'git bundle list-heads ../source.bundle refs/ci/base').trim()
                                if (bundledBase != spec.base_sha + ' refs/ci/base') {
                                    error('Bundle does not contain the pinned GLOBAL base commit')
                                }
                            }
                        }
                        // Base is resolved and in the bundle before JobSpec reaches prepare.
                        writeFile(file: 'job.json', text: JsonOutput.toJson(spec) + '\n')
                        Controller.requireRunnerBinding(currentBuild.rawBuild, enrollment)
                        // Interpolation is limited to controller-created absolute paths/UUID.
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
                timeout(time: 2, unit: 'MINUTES') {
                    waitUntil { Controller.runnerOnline(attempt) }
                }
                timeout(time: spec.timeout_seconds + 120, unit: 'SECONDS') {
                    node('runner') {
                        if (env.NODE_NAME != 'runner') { error('Runner label resolved to a different node') }
                        // No checkout, credentials, load, library or PR-selected argv.
                        int status = sh(returnStatus: true, script: '''#!/bin/sh
set -eu
test ! -e receipt.json
exec /usr/local/libexec/ci-platform executor --profile /var/lib/ci-input/profile.json --spec /var/lib/ci-input/job.json --bundle /var/lib/ci-input/source.bundle --evidence-root /var/lib/ci-evidence --mode gate --execute > receipt.json
''')
                        stash(name: 'executor-receipt', includes: 'receipt.json', useDefaultExcludes: false)
                        if (status != 0) { error("Executor returned ${status}") }
                    }
                }
                node('control') {
                    ws(work) {
                        unstash('executor-receipt')
                        sh """#!/bin/sh
set -eu
exec /usr/local/libexec/ci-platform control verify --config /etc/ci-platform/control.json --spec '${work}/job.json' --receipt '${work}/receipt.json'
"""
                        gatePassed = true
                    }
                }
            } finally {
                // Failed prepare stays quarantined; only this prepared attempt may finish.
                Controller.disconnectRunner(attempt)
                timeout(time: 2, unit: 'MINUTES') {
                    waitUntil { Controller.runnerStopped(attempt) }
                }
                Controller.removeRunner(attempt)
                if (prepared) {
                    node('control') {
                        Controller.requireRunnerBinding(currentBuild.rawBuild, enrollment)
                        sh """#!/bin/sh
set -eu
exec /usr/local/libexec/ci-platform control finish --config /etc/ci-platform/control.json --attempt-id '${attempt}' --state-dir /var/lib/ci-control --execute
"""
                        cleaned = true
                    }
                }
            }
            if (!gatePassed || !cleaned) { error('Gate or final reset is incomplete') }
            // Publish while holding the global slot; cleanup precedes SUCCESS.
            Controller.requireCurrentHead(currentBuild.rawBuild, identity)
            publishChecks(name: identity.entry.check_name, status: 'COMPLETED', conclusion: 'SUCCESS',
                summary: "Gate and final reset verified; source ${identity.source_sha}; base ${spec.base_sha ?: 'not-required'}; config ${spec.config_sha}; image ${spec.image_fingerprint}; attempt ${attempt}")
            Controller.readback(currentBuild.rawBuild, identity, 'COMPLETED', 'SUCCESS')
            accepted = true
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
                    publishChecks(name: identity.entry.check_name, status: 'COMPLETED', conclusion: conclusion,
                        summary: "Attempt ${attempt} failed or is unverified; base=${spec.base_sha ?: identity.base_sha ?: 'unresolved/not-required'}; gate=${gatePassed}; cleanup=${cleaned}")
                    Controller.readback(currentBuild.rawBuild, identity, 'COMPLETED', conclusion)
                } catch (Exception ignored) {
                    echo('Failure check publication is unverified')
                }
            }
        }
        if (failure != null) { throw failure }
        if (!accepted) { error('No accepted gate result') }
    }
}
