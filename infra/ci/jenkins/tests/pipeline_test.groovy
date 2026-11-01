import groovy.json.JsonOutput
import groovy.json.JsonSlurperClassic

// Executes the real Pipeline script with in-memory Pipeline-step/Controller
// receivers. This is behavioural proof, not a CPS/plugin/host qualification.
File root = new File(args ? args[0] : '.')
def loader = new GroovyClassLoader(this.class.classLoader)
loader.parseClass('''package org.jenkinsci.plugins.workflow.steps
class FlowInterruptedException extends Exception {
    List causes
    FlowInterruptedException(List value) { super('interrupted'); causes = value }
}
class ExceededTimeout {}
class UserInterruption {}
''')
loader.parseClass('''package ci
class Controller {
    static Map context
    static Map enrollment(run) { [runner: [remote_fs: '/var/lib/jenkins-agent']] }
    static Map sourceIdentity(run, enrollment) { context.identity }
    static void readback(run, identity, status, conclusion) { context.events.add('readback:' + status) }
    static checkoutScm(scm, run, identity) { scm }
    static void requireNoRunner() { context.events.add('requireNoRunner') }
    static void requireRunnerBinding(run, enrollment) {}
    static void registerRunner(config, attempt) { context.events.add('register'); context.attempt = attempt }
    static boolean runnerOnline(attempt) { true }
    static void disconnectRunner(attempt) { context.events.add('disconnect') }
    static boolean runnerStopped(attempt) { true }
    static void removeRunner(attempt) { context.events.add('remove') }
    static void requireCurrentHead(run, identity) { context.events.add('currentHead') }
}
class CheckoutPolicy { static environment() { [] } }
''')
loader.parseClass(new File(root, 'infra/ci/jenkins/library/src/ci/QueuePolicy.groovy'))
def controller = loader.loadClass('ci.Controller')
def interruption = loader.loadClass('org.jenkinsci.plugins.workflow.steps.FlowInterruptedException')
def timeoutCause = loader.loadClass('org.jenkinsci.plugins.workflow.steps.ExceededTimeout')
def userCause = loader.loadClass('org.jenkinsci.plugins.workflow.steps.UserInterruption')
def interrupt = { cause -> interruption.getConstructor(List).newInstance([[cause]] as Object[]) }
def scriptClass = loader.parseClass(new File(root, 'infra/ci/jenkins/library/vars/ownedCi.groovy'))
def queue = loader.loadClass('ci.QueuePolicy')
long admitted = 1800000000000L
assert queue.priority(admitted, false) > queue.priority(admitted, true)
assert queue.priority(admitted, true) > queue.priority(admitted + 180000L, false)
assert queue.priority(admitted, true) == queue.priority(admitted + 120000L, false)
assert queue.priority(admitted, true) instanceof Integer
for (long invalid : [-1L, Long.MAX_VALUE]) {
    boolean rejected = false
    try { queue.priority(invalid, false) } catch (IllegalStateException expected) { rejected = true }
    assert rejected
}

def run = { String scenario ->
    def events = []
    def files = [:]
    def checks = []
    Map identity = [entry: [repo_id: '1409811398', config_sha: '1' * 40,
        image_fingerprint: '2' * 64, tier: 'product', timeout_seconds: 1800,
        memory_mib: 5120, process_limit: 1024, check_name: 'krn/gate'],
        source_sha: '3' * 40, base_sha: '4' * 40, pull_request: true]
    def context = [identity: identity, events: events]
    controller.context = context
    def env = [NODE_NAME: null]
    List timeoutScopes = []
    def build = [rawBuild: new Object(), startTimeInMillis: admitted, result: null]
    def binding = new Binding([currentBuild: build, env: env])
    def script = scriptClass.newInstance()
    script.binding = binding
    binding.setVariable('publishChecks', { Map options -> checks.add(options); events.add('check:' + options.status) })
    binding.setVariable('node', { String name, Closure action ->
        if (name == 'runner') {
            assert timeoutScopes.any { it.unit == 'SECONDS' && it.time == 2100 }
            if (scenario == 'allocation-timeout') { throw interrupt(timeoutCause.newInstance()) }
        }
        String previous = env.NODE_NAME
        env.NODE_NAME = name
        try { action() } finally { env.NODE_NAME = previous }
    })
    binding.setVariable('ws', { String path, Closure action ->
        if (path.contains('/evidence-export/')) { context.attempt = path.tokenize('/').last() }
        action()
    })
    binding.setVariable('dir', { String path, Closure action -> action() })
    binding.setVariable('withEnv', { List values, Closure action -> action() })
    binding.setVariable('checkout', { scm -> events.add('checkout') })
    binding.setVariable('writeFile', { Map options -> files[options.file] = options.text })
    binding.setVariable('readFile', { Map options ->
        events.add('read:' + options.file)
        if (!files.containsKey(options.file)) { throw new IllegalStateException('missing file') }
        files[options.file]
    })
    binding.setVariable('error', { message -> throw new IllegalStateException(message.toString()) })
    binding.setVariable('echo', { message -> events.add('echo:' + message) })
    binding.setVariable('timeout', { Map options, Closure action ->
        timeoutScopes.add(options)
        try { action() } finally { timeoutScopes.remove(timeoutScopes.size() - 1) }
    })
    binding.setVariable('waitUntil', { Closure action -> assert action() })
    binding.setVariable('lock', { Map options, Closure action ->
        assert options.resource == 'ci-runner'
        assert options.priority instanceof Integer
        events.add('lock')
        if (scenario == 'queued-cancel') { throw interrupt(userCause.newInstance()) }
        action()
    })
    binding.setVariable('stash', { Map options ->
        assert env.NODE_NAME == 'runner'
        events.add('stash')
        if (scenario == 'dead-channel') { throw new IllegalStateException('agent channel unavailable') }
    })
    binding.setVariable('unstash', { String name ->
        assert env.NODE_NAME == 'control'
        events.add('unstash')
        if (scenario == 'unstash-failure') { throw new IllegalStateException('controller transfer failed') }
        files['ci-evidence/summary.txt'] = 'failed test: diagnostic receiver'
    })
    binding.setVariable('archiveArtifacts', { Map options ->
        assert env.NODE_NAME == 'control'
        events.add('archive:' + options.artifacts)
        if (scenario == 'archive-failure' && options.artifacts == 'ci-evidence/*') {
            throw new IllegalStateException('archive storage unavailable')
        }
    })
    binding.setVariable('sh', { Object options ->
        String command = (options instanceof Map ? options.script : options).toString()
        if (command == 'git rev-parse HEAD') { return identity.source_sha }
        if (command.contains(' admission product-base')) {
            events.add('admission')
            assert command.contains(identity.base_sha)
            assert !command.contains(identity.source_sha)
            return scenario == 'stale-base' ? 1 : 0
        }
        if (command.contains(' control prepare ')) {
            events.add('prepare')
            return JsonOutput.toJson([ok: true, phase: 'prepared', attempt_id: new JsonSlurperClassic().parseText(files['job.json']).attempt_id])
        }
        if (command.contains(' executor --profile')) {
            events.add('executor')
            if (scenario in ['cancel', 'timeout']) { throw interrupt(scenario == 'timeout' ? timeoutCause.newInstance() : userCause.newInstance()) }
            return scenario == 'executor-timeout' ? 124 : (scenario in ['failure', 'failure-reset'] ? 23 : 0)
        }
        if (command.contains(' evidence export ')) {
            events.add('export')
            assert command.contains(context.attempt)
            return scenario == 'incomplete-export' ? 1 : 0
        }
        if (command.contains(' control verify ')) {
            events.add('verify')
            if (scenario == 'verify-failure') { throw new IllegalStateException('receipt invalid') }
            return null
        }
        if (command.contains(' control finish ')) {
            events.add('reset')
            if (scenario in ['failure-reset', 'reset-failure']) { throw new IllegalStateException('reset receiver refused') }
            return null
        }
        events.add('shell')
        return options instanceof Map && options.returnStatus ? 0 : ''
    })
    Exception thrown = null
    try { script.call([:]) } catch (Exception problem) { thrown = problem }
    assert checks.first().status == 'QUEUED'
    assert events.indexOf('check:QUEUED') < events.indexOf('lock') || scenario == 'stale-base'
    assert events.indexOf('admission') < events.indexOf('lock') || scenario == 'stale-base'
    def finalCheck = checks.last()
    if (scenario == 'success') {
        assert thrown == null
        assert finalCheck.conclusion == 'SUCCESS'
        assert events.indexOf('archive:ci-evidence/*') < events.indexOf('verify')
        assert events.indexOf('reset') < events.lastIndexOf('check:COMPLETED')
    } else {
        assert thrown != null: scenario
        assert finalCheck.conclusion != 'SUCCESS': scenario
    }
    if (scenario in ['stale-base', 'queued-cancel']) {
        assert !events.contains('prepare')
        assert !events.contains('register')
        assert !events.contains('reset')
        assert finalCheck.conclusion == (scenario == 'queued-cancel' ? 'CANCELED' : 'FAILURE')
    } else {
        assert events.contains('reset'): scenario
        assert events.indexOf('export') < events.indexOf('disconnect') || scenario == 'allocation-timeout'
        assert events.indexOf('unstash') < events.indexOf('reset') || scenario in ['dead-channel', 'allocation-timeout']
        if (!(scenario in ['dead-channel', 'unstash-failure', 'allocation-timeout'])) {
            assert events.indexOf('archive:ci-evidence/*') < events.indexOf('reset'): scenario
        }
        if (scenario in ['cancel', 'timeout', 'allocation-timeout']) {
            assert finalCheck.conclusion == (scenario == 'cancel' ? 'CANCELED' : 'TIME_OUT')
        }
        if (scenario == 'executor-timeout') { assert finalCheck.conclusion == 'TIME_OUT' }
        if (scenario in ['failure', 'failure-reset']) {
            assert thrown.message == 'Executor returned 23'
            assert finalCheck.text.contains('failed test: diagnostic receiver')
        }
        def report = new JsonSlurperClassic().parseText(files['attempt.json'])
        if (scenario == 'failure-reset') {
            assert report.primary_error.contains('Executor returned 23')
            assert report.secondary_errors.any { it.contains('reset receiver refused') }
            assert !report.cleanup_verified
        }
        if (scenario in ['dead-channel', 'allocation-timeout']) {
            assert !report.evidence_stashed
            assert report.secondary_errors.any { it.contains('unavailable') }
        }
        if (scenario == 'incomplete-export') { assert !report.evidence_complete }
    }
    println('PASS Pipeline receiver scenario: ' + scenario)
}
['success', 'failure', 'cancel', 'timeout', 'executor-timeout', 'allocation-timeout', 'failure-reset', 'reset-failure', 'dead-channel',
 'incomplete-export', 'unstash-failure', 'archive-failure', 'verify-failure', 'stale-base', 'queued-cancel'].each(run)
println('PASS age-bounded main priority: same-time preference, old PR aging, FIFO tie, integer range')
