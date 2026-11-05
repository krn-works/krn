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

// Compile the complete production Controller against minimal Jenkins API receivers.
// Only its class name changes, so Pipeline's lifecycle fake can delegate retry,
// head lookup and readback to the actual implementation.
String controllerSource = new File(root, 'infra/ci/jenkins/library/src/ci/Controller.groovy').text
Map apiStubs = [
    'com.cloudbees.groovy.cps.NonCPS': '@interface NonCPS {}',
    'jenkins.scm.api.SCMSource': '''class SCMSource {
        static def source
        static class SourceByItem { static def findSource(item) { SCMSource.source } }
    }''',
    'jenkins.scm.api.SCMRevisionAction': '''class SCMRevisionAction {
        static def getRevision(source, run) { [head: 'head'] }
    }''',
    'org.jenkinsci.plugins.github_branch_source.GitHubSCMSource': '''class GitHubSCMSource {
        Closure receiver
        String credentialsId = 'app'
        String apiUri
        String repoOwner = 'owner'
        def fetch(head, listener) { receiver() }
    }''',
    'org.jenkinsci.plugins.github_branch_source.PullRequestSCMRevision':
        'class PullRequestSCMRevision { String pullHash; String baseHash }',
    'org.jenkinsci.plugins.github_branch_source.GitHubAppCredentials': '''class GitHubAppCredentials {
        String apiUri
        String getAppID() { '5548482' }
    }''',
    'org.jenkinsci.plugins.github_branch_source.Connector': '''class Connector {
        static def connection
        static def credential
        static def lookupScanCredentials(item, uri, id, owner) { credential }
        static def connect(uri, credential) { connection }
    }''',
    'org.kohsuke.github.HttpException': '''class HttpException extends IOException {
        int responseCode
        HttpException(int code) { super(code == 503 ? 'Service Unavailable' : 'HTTP error'); responseCode = code }
    }''',
    'hudson.slaves.OfflineCause': 'class OfflineCause { static class ByCLI {} }'
]
controllerSource.readLines().findAll { it.startsWith('import ') }.each { line ->
    String name = line.substring(7)
    if (!name.startsWith('java.') && !name.startsWith('groovy.')) {
        String simple = name.tokenize('.').last()
        loader.parseClass('package ' + name.substring(0, name.lastIndexOf('.')) + '\n' +
            (apiStubs[name] ?: ('class ' + simple + ' {}')))
    }
}
loader.parseClass('package ci; class OwnedRunner {}')
loader.parseClass('package ci; class RunnerBinding {}')
loader.parseClass('package ci; class CheckoutPolicy { static environment() { [] } }')
def actualController = loader.parseClass(controllerSource.replace('class Controller {', 'class ActualController {'))
def httpFailure = loader.loadClass('org.kohsuke.github.HttpException')
def scmSource = loader.loadClass('jenkins.scm.api.SCMSource')
def githubSource = loader.loadClass('org.jenkinsci.plugins.github_branch_source.GitHubSCMSource')
def prRevision = loader.loadClass('org.jenkinsci.plugins.github_branch_source.PullRequestSCMRevision')

// Readback must keep retry classification while dropping API error bodies.
def connector = loader.loadClass('org.jenkinsci.plugins.github_branch_source.Connector')
connector.credential = loader.loadClass('org.jenkinsci.plugins.github_branch_source.GitHubAppCredentials').newInstance()
scmSource.source = githubSource.newInstance(receiver: { null })
for (int code : [503, 404]) {
    int reads = 0
    List sleeps = []
    connector.connection = [getRepository: { name ->
        reads++
        throw httpFailure.newInstance(code)
    }]
    Exception failed = null
    try {
        actualController.retryGitHub({
            actualController.readback(
                [parent: 'job', getActions: { type -> [[name: 'krn/gate', id: 1]] }],
                [entry: [check_name: 'krn/gate', app_id: '5548482'], repository: 'owner/repo'],
                'COMPLETED', 'FAILURE')
        }, { seconds -> sleeps.add(seconds) })
    } catch (Exception problem) { failed = problem }
    assert failed != null
    assert failed.message == 'GitHub check readback failed; publication is unverified'
    assert failed.cause == null
    assert reads == (code == 503 ? 4 : 1)
    assert sleeps == (code == 503 ? [2, 4, 8] : [])
}
for (int code : [400, 401, 403, 404, 429, 499, 500, 503, 599, 600]) {
    int attempts = 0
    List sleeps = []
    try {
        actualController.retryGitHub({ attempts++; throw httpFailure.newInstance(code) },
            { seconds -> sleeps.add(seconds) })
        assert false
    } catch (IOException expected) {}
    boolean retryable = code >= 500 && code <= 599
    assert attempts == (retryable ? 4 : 1)
    assert sleeps == (retryable ? [2, 4, 8] : [])
}
int transportAttempts = 0
List transportSleeps = []
assert actualController.retryGitHub({
    if (++transportAttempts <= 2) { throw new IOException('transport') }
    'received'
}, { seconds -> transportSleeps.add(seconds) }) == 'received'
assert transportAttempts == 3
assert transportSleeps == [2, 4]
println('PASS real Controller: HTTP boundaries, IOException retry, sanitized readback classification')
loader.parseClass('''package ci
class Controller {
    static Map context
    static Map enrollment(run) { [runner: [remote_fs: '/var/lib/jenkins-agent']] }
    static Map sourceIdentity(run, enrollment) { context.identity }
    static void readback(run, identity, status, conclusion) {
        context.events.add('readback:' + status)
        if (context.scenario == 'readback-transient' && status == 'COMPLETED' && !context.readbackFailed) {
            context.readbackFailed = true
            throw new IOException('GitHub check readback failed; publication is unverified')
        }
    }
    static checkoutScm(scm, run, identity) { scm }
    static void requireNoRunner() { context.events.add('requireNoRunner') }
    static void requireRunnerBinding(run, enrollment) {}
    static void registerRunner(config, attempt) { context.events.add('register'); context.attempt = attempt }
    static boolean runnerOnline(attempt) { true }
    static void disconnectRunner(attempt) { context.events.add('disconnect') }
    static boolean runnerStopped(attempt) { true }
    static void removeRunner(attempt) { context.events.add('remove'); if (context.scenario == 'stop-failure') { throw new IllegalStateException('runner still attached') } }
    static def retryGitHub(Closure action, Closure sleeper) { ActualController.retryGitHub(action, sleeper) }
    static void requireCurrentHead(Closure run, identity, Closure sleeper) {
        context.events.add('currentHead')
        ActualController.requireCurrentHead(run, identity, sleeper)
    }
}
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
    def sleeps = []
    int headAttempts = 0
    scmSource.source = githubSource.newInstance(receiver: {
        headAttempts++
        if (scenario == 'head-transient' && headAttempts <= 2 || scenario == 'head-exhausted' || scenario == 'head-final-exhausted' && headAttempts >= 2) {
            throw httpFailure.newInstance(503)
        }
        if (scenario == 'head-404') { throw httpFailure.newInstance(404) }
        if (scenario == 'head-other') { throw new IllegalStateException('other') }
        prRevision.newInstance(pullHash: identity.source_sha, baseHash: identity.base_sha)
    })
    def context = [identity: identity, events: events, scenario: scenario]
    controller.context = context
    def env = [NODE_NAME: null]
    List timeoutScopes = []
    def build = [rawBuild: [parent: 'job'], startTimeInMillis: admitted, result: null]
    def binding = new Binding([currentBuild: build, env: env])
    def script = scriptClass.newInstance()
    script.binding = binding
    int terminalAttempts = 0
    binding.setVariable('sleep', { Map options ->
        assert options.unit == 'SECONDS'
        sleeps.add(options.time)
    })
    binding.setVariable('publishChecks', { Map options ->
        if (options.status == 'COMPLETED') {
            terminalAttempts++
            if (scenario == 'publish-exhausted' || scenario == 'publish-transient' && terminalAttempts == 1) {
                throw httpFailure.newInstance(503)
            }
        }
        checks.add(options)
        events.add('check:' + options.status)
    })
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
            return scenario == 'executor-timeout' ? 124 : (scenario in ['failure', 'failure-reset', 'publish-transient', 'publish-exhausted', 'readback-transient'] ? 23 : 0)
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
            if (scenario in ['failure-reset', 'reset-failure', 'post-gate-failure']) { throw new IllegalStateException(scenario == 'post-gate-failure' ? 'reset receiver\u0085\u2028refused\u202e' : 'reset receiver refused') }
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
    if (scenario in ['head-exhausted', 'head-404', 'head-other']) {
        assert thrown != null
        assert build.result == 'FAILURE'
        assert finalCheck.conclusion == 'FAILURE'
        assert finalCheck.summary.contains('failed at stage execution: ')
        assert terminalAttempts == 1
        assert headAttempts == (scenario == 'head-exhausted' ? 4 : 1)
        assert sleeps == (scenario == 'head-exhausted' ? [2, 4, 8] : [])
        println('PASS Pipeline receiver scenario: ' + scenario)
        return
    }
    if (scenario == 'publish-exhausted') {
        assert thrown.message == 'Executor returned 23'
        assert build.result == 'FAILURE'
        assert terminalAttempts == 4
        assert sleeps == [2, 4, 8]
        assert events.contains('echo:Failure check publication is unverified')
        println('PASS Pipeline receiver scenario: ' + scenario)
        return
    }
    if (scenario == 'head-final-exhausted') {
        assert headAttempts == 5
        assert sleeps == [2, 4, 8]
        assert finalCheck.summary.contains('failed at stage head-check: HttpException: Service Unavailable')
        assert build.result == 'FAILURE'
    }
    if (scenario in ['publish-transient', 'readback-transient']) {
        assert terminalAttempts == 2
        assert sleeps == [2]
        assert build.result == 'FAILURE'
        assert events.last() == 'readback:COMPLETED'
    }
    if (scenario == 'head-transient') {
        assert headAttempts == 4 // three at admission, one before success publication
        assert sleeps == [2, 4]
    }
    if (scenario in ['success', 'head-transient']) {
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
        assert events.contains('reset') || scenario == 'stop-failure': scenario
        assert events.indexOf('export') < events.indexOf('disconnect') || scenario == 'allocation-timeout'
        assert events.indexOf('unstash') < events.indexOf('reset') || scenario in ['dead-channel', 'allocation-timeout', 'stop-failure']
        if (!(scenario in ['dead-channel', 'unstash-failure', 'allocation-timeout', 'stop-failure'])) {
            assert events.indexOf('archive:ci-evidence/*') < events.indexOf('reset'): scenario
        }
        if (scenario in ['cancel', 'timeout', 'allocation-timeout']) {
            assert finalCheck.conclusion == (scenario == 'cancel' ? 'CANCELED' : 'TIME_OUT')
        }
        if (scenario == 'executor-timeout') { assert finalCheck.conclusion == 'TIME_OUT' }
        if (scenario in ['failure', 'failure-reset']) {
            assert thrown.message == 'Executor returned 23'
            assert finalCheck.summary.contains('failed at stage execution: ')
            assert finalCheck.text.contains('failed at stage')
            assert finalCheck.text.contains('failed test: diagnostic receiver')
        }
        if (scenario == 'post-gate-failure') {
            assert finalCheck.summary.contains('failed at stage finish: IllegalStateException: reset receiver  refused ;')
            assert finalCheck.summary.contains('gate=true')
            assert finalCheck.text.contains('failed at stage finish: IllegalStateException: reset receiver  refused ')
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
        if (scenario == 'incomplete-export') {
            assert !report.evidence_complete
            assert finalCheck.summary.contains('failed at stage export: ')
            assert finalCheck.summary.contains('Evidence export incomplete')
        }
        if (scenario == 'stop-failure') {
            assert finalCheck.summary.contains('failed at stage runner-stop: IllegalStateException: runner still attached')
            assert finalCheck.summary.contains('gate=true')
        }
        if (scenario == 'archive-failure') { assert finalCheck.summary.contains('failed at stage evidence-archive: ') }
        if (scenario == 'unstash-failure') { assert finalCheck.summary.contains('failed at stage export: IllegalStateException: controller transfer failed') }
        if (scenario == 'dead-channel') { assert finalCheck.summary.contains('failed at stage ') }
    }
    println('PASS Pipeline receiver scenario: ' + scenario)
}
['head-transient', 'head-exhausted', 'head-final-exhausted', 'head-404', 'head-other', 'publish-transient', 'publish-exhausted', 'readback-transient', 'success', 'failure', 'cancel', 'timeout', 'executor-timeout', 'allocation-timeout', 'failure-reset', 'reset-failure', 'dead-channel',
 'incomplete-export', 'unstash-failure', 'archive-failure', 'verify-failure', 'post-gate-failure', 'stop-failure', 'stale-base', 'queued-cancel'].each(run)
println('PASS age-bounded main priority: same-time preference, old PR aging, FIFO tie, integer range')
