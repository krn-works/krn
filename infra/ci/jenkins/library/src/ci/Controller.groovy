package ci

import com.cloudbees.groovy.cps.NonCPS
import com.cloudbees.plugins.credentials.CredentialsProvider
import com.cloudbees.jenkins.plugins.sshcredentials.SSHUserPrivateKey
import groovy.json.JsonSlurperClassic
import hudson.model.Node
import hudson.plugins.git.GitSCM
import hudson.plugins.git.UserRemoteConfig
import hudson.slaves.CommandLauncher
import hudson.slaves.OfflineCause
import io.jenkins.plugins.checks.github.GitHubChecksAction
import jenkins.model.Jenkins
import jenkins.scm.api.SCMRevisionAction
import jenkins.scm.api.SCMSource
import jenkins.scm.api.SCMHeadOrigin
import org.jenkinsci.plugins.github_branch_source.Connector
import org.jenkinsci.plugins.github_branch_source.GitHubAppCredentials
import org.jenkinsci.plugins.github_branch_source.GitHubSCMSource
import org.jenkinsci.plugins.github_branch_source.PullRequestSCMRevision
import org.jenkinsci.plugins.github_branch_source.SSHCheckoutTrait
import io.jenkins.plugins.checks.github.status.GitHubSCMSourceStatusChecksTrait
import org.jenkinsci.plugins.workflow.libs.GlobalLibraries
import org.jenkinsci.plugins.workflow.libs.LibrariesAction
import org.jenkinsci.plugins.workflow.multibranch.extended.RemoteJenkinsFileWorkflowBranchProjectFactory
import org.kohsuke.github.HttpException
import java.nio.file.Files
import java.nio.file.LinkOption
import java.nio.file.Paths
import java.security.MessageDigest

/** Controller-only APIs. No credentials, URLs, node names or commands from PRs. */
class Controller {
    static final String ENROLLMENT = '/etc/ci-platform/jenkins-enrollment.json'
    static final String CONTROL = '/etc/ci-platform/control.json'

    @NonCPS
    private static String trustedText(String filename, int limit) {
        def path = Paths.get(filename)
        if (!path.absolute || path.normalize() != path) {
            throw new IllegalStateException('Canonical trusted input path required')
        }
        for (def part = path; part != null; part = part.parent) {
            if (Files.isSymbolicLink(part) ||
                Files.getAttribute(part, 'unix:uid', LinkOption.NOFOLLOW_LINKS) != 0 ||
                (((Number) Files.getAttribute(part, 'unix:mode', LinkOption.NOFOLLOW_LINKS)).intValue() & 0022) != 0) {
                throw new IllegalStateException('Trusted input and parents must be root-owned and not writable by others')
            }
        }
        if (!Files.isRegularFile(path, LinkOption.NOFOLLOW_LINKS) ||
            Files.size(path) == 0 || Files.size(path) > limit) {
            throw new IllegalStateException('Bounded external trusted input required')
        }
        return Files.readString(path)
    }

    @NonCPS
    static Map enrollment(def run) {
        Map config = new JsonSlurperClassic().parseText(trustedText(ENROLLMENT, 65536)) as Map
        validateEnrollment(config)
        def library = GlobalLibraries.get().libraries.find { it.name == 'owned-ci' }
        def loaded = run.getAction(LibrariesAction)?.libraries?.find { it.name == 'owned-ci' }
        if (!library || library.defaultVersion != config.library_sha ||
            library.allowVersionOverride || !library.implicit || !loaded?.trusted ||
            loaded.version != config.library_sha) {
            throw new IllegalStateException('Implicit trusted library must be pinned to the enrolled exact SHA')
        }
        def factory = run.parent.parent.projectFactory
        if (!(factory instanceof RemoteJenkinsFileWorkflowBranchProjectFactory) ||
            factory.matchBranches || factory.lookupInParameters ||
            factory.remoteJenkinsFile != 'infra/ci/jenkins/Pipeline.groovy' ||
            factory.remoteJenkinsFileSCM.branches*.name != [config.library_sha]) {
            throw new IllegalStateException('Central Pipeline must use the same fixed configuration SHA')
        }
        if (Jenkins.get().numExecutors != 0) {
            throw new IllegalStateException('Built-in executors must remain zero')
        }
        def control = Jenkins.get().getNode('control')
        if (!control || control.numExecutors != 1 || control.mode != Node.Mode.EXCLUSIVE ||
            !(control.launcher instanceof CommandLauncher)) {
            throw new IllegalStateException('Exactly one exclusive trusted control executor is required')
        }
        Map runner = config.runner as Map
        if (!runner || !(runner.host ==~ /[A-Za-z0-9.-]{1,253}/) ||
            !(runner.port instanceof Integer) || runner.port < 1 || runner.port > 65535 ||
            !(runner.credentials_id ==~ /[A-Za-z0-9_.-]{1,80}/) ||
            !(runner.remote_fs ==~ /\/[A-Za-z0-9_\/-]{1,160}/) ||
            !(runner.host_key instanceof String) || runner.host_key.isBlank()) {
            throw new IllegalStateException('Fixed SSH runner enrollment is incomplete')
        }
        config.runner_binding = currentRunnerBinding(run, runner)
        return config
    }

    @NonCPS
    static void validateEnrollment(Map config) {
        Map approvedRepositories = ['krn-works/krn': '1409811398',
                                    'krn-works/krn-codex-skills': '1246837409']
        if (config.schema_version != 1 || config.enabled != true ||
            !(config.library_sha ==~ /[0-9a-f]{40}/) ||
            !(config.repositories instanceof Map) ||
            config.repositories.keySet() != approvedRepositories.keySet()) {
            throw new IllegalStateException('Jenkins requires exactly the approved repository enrollment')
        }
        approvedRepositories.each { repository, repoId ->
            def record = config.repositories[repository]
            if (!(record instanceof Map)) {
                throw new IllegalStateException('Repository enrollment must be a map')
            }
            List entries
            if (repository == 'krn-works/krn') {
                if (record.jobs != null || record.tier != 'product' || record.check_name != 'krn/gate') {
                    throw new IllegalStateException('Product requires the approved krn/gate job')
                }
                entries = [record]
            } else {
                if (!(record.jobs instanceof Map) || record.jobs.isEmpty()) {
                    throw new IllegalStateException('GLOBAL requires its approved fast/deep jobs')
                }
                entries = record.jobs.keySet().collect { job -> selectedEntry(record, job) }
            }
            // Check both the repository record and merged GLOBAL jobs: child fields
            // must not substitute a different repository or publishing App.
            ([record] + entries).each { entry ->
                if (!(entry.repo_id instanceof String) || entry.repo_id != repoId ||
                    !(entry.app_id instanceof String) || entry.app_id != '5548482') {
                    throw new IllegalStateException('Repository ID and publishing App must match the approved contract')
                }
            }
        }
    }

    @NonCPS
    private static Map currentRunnerBinding(def run, Map runner) {
        if (runner.credentials_id != RunnerBinding.CREDENTIAL_ID) {
            throw new IllegalStateException('Runner credential differs from the deployment contract')
        }
        String text = trustedText(CONTROL, 262144)
        Map control = new JsonSlurperClassic().parseText(text) as Map
        String knownHosts = trustedText(RunnerBinding.KNOWN_HOSTS, 65536)
        def credential = CredentialsProvider.findCredentialById(
            RunnerBinding.CREDENTIAL_ID, SSHUserPrivateKey, run)
        if (!(credential instanceof SSHUserPrivateKey)) {
            throw new IllegalStateException('Pinned runner SSH credential is unavailable')
        }
        Map binding = RunnerBinding.verify(runner, control, knownHosts,
                                           credential.id, credential.username)
        binding.control_sha256 = MessageDigest.getInstance('SHA-256').digest(text.getBytes('UTF-8')).encodeHex().toString()
        binding.known_hosts_sha256 = MessageDigest.getInstance('SHA-256').digest(knownHosts.getBytes('UTF-8')).encodeHex().toString()
        return binding
    }

    @NonCPS
    static void requireRunnerBinding(def run, Map config) {
        if (currentRunnerBinding(run, config.runner as Map) != config.runner_binding) {
            throw new IllegalStateException('Runner deployment inputs changed during the attempt')
        }
    }

    @NonCPS
    static Map sourceIdentity(def run, Map config) {
        validateEnrollment(config)
        def source = SCMSource.SourceByItem.findSource(run.parent)
        if (!(source instanceof GitHubSCMSource)) {
            throw new IllegalStateException('GitHub Branch Source context required')
        }
        def checks = source.traits.find { it instanceof GitHubSCMSourceStatusChecksTrait }
        if (source.traits.any { it instanceof SSHCheckoutTrait } ||
            !checks?.skip || !checks.skipNotifications) {
            throw new IllegalStateException('Native HTTPS App checkout and disabled automatic notifications required')
        }
        String repository = source.repoOwner + '/' + source.repository
        Map record = config.repositories[repository] as Map
        Map entry = selectedEntry(record, run.parent.parent.fullName)
        if (!entry || entry.job != run.parent.parent.fullName ||
            !(entry.repo_id ==~ /[1-9][0-9]{0,19}/) ||
            entry.config_sha != config.library_sha ||
            !(entry.image_fingerprint ==~ /[0-9a-f]{64}/) ||
            !(entry.tier in ['product', 'global-fast', 'global-deep']) ||
            !(entry.check_name ==~ /[A-Za-z0-9_\/. ()-]{1,80}/) ||
            !(entry.main_branch ==~ /[A-Za-z0-9_.\/-]{1,100}/) ||
            !(entry.app_id ==~ /[1-9][0-9]{0,19}/)) {
            throw new IllegalStateException('Repository is not enrolled in the protected map')
        }
        approvedApp(run, source, entry)
        validateResourceLimits(entry)
        def revision = SCMRevisionAction.getRevision(source, run)
        String sha
        String baseSha = null
        boolean pullRequest = revision instanceof PullRequestSCMRevision
        if (pullRequest) {
            if (revision.head.checkoutStrategy.toString() != 'HEAD' ||
                revision.head.origin != SCMHeadOrigin.DEFAULT) {
                throw new IllegalStateException('PR discovery must build the head revision')
            }
            sha = revision.pullHash
            // Product admission also reads policy at this exact native base.
            baseSha = revision.baseHash
            if (!(baseSha ==~ /[0-9a-f]{40}/)) {
                throw new IllegalStateException('PR revision requires its pinned base SHA')
            }
        } else {
            if (revision?.head?.name != entry.main_branch) {
                throw new IllegalStateException('Only the enrolled main branch and origin PRs are admitted')
            }
            sha = revision?.hash
        }
        if (!(sha ==~ /[0-9a-f]{40}/)) {
            throw new IllegalStateException('Source SCMRevisionAction has no exact head SHA')
        }
        return [repository: repository, source_sha: sha, base_sha: baseSha,
                pull_request: pullRequest, entry: new LinkedHashMap(entry)]
    }

    @NonCPS
    static void validateResourceLimits(Map entry) {
        [timeout_seconds: [30, 7200], memory_mib: [256, 14336], process_limit: [64, 4096]].each { key, bounds ->
            def value = entry[key]
            if (!(value instanceof Integer) || value < bounds[0] || value > bounds[1]) {
                throw new IllegalStateException('Invalid enrolled resource limits')
            }
        }
    }

    @NonCPS
    private static Map selectedEntry(Map record, String job) {
        if (!record) { return null }
        if (record.jobs == null) {
            if (record.tier != 'product') {
                throw new IllegalStateException('GLOBAL requires separate enrolled fast/deep jobs')
            }
            return new LinkedHashMap(record) // Existing Product enrollment is unchanged.
        }
        if (!(record.jobs instanceof Map) || record.jobs.size() != 2 || record.job != null ||
            record.tier != null || record.check_name != null ||
            !record.jobs.values().every { it instanceof Map } ||
            record.jobs.values()*.tier.toSet() != ['global-fast', 'global-deep'].toSet() ||
            !record.jobs.values().every {
                it.check_name == (it.tier == 'global-fast' ? 'gate (fast)' : 'gate (deep)')
            }) {
            throw new IllegalStateException('GLOBAL needs exactly two distinct native gate jobs')
        }
        Map selected = record.jobs[job] as Map
        if (!selected) { throw new IllegalStateException('Parent Multibranch job is not enrolled') }
        Map entry = new LinkedHashMap(record)
        entry.remove('jobs')
        entry.putAll(selected)
        entry.job = job
        return entry
    }

    @NonCPS
    static GitSCM checkoutScm(def scm, def run, Map identity) {
        def source = SCMSource.SourceByItem.findSource(run.parent) as GitHubSCMSource
        approvedApp(run, source, identity.entry as Map)
        if (scm.getClass() != GitSCM || scm.userRemoteConfigs.size() != 1) {
            throw new IllegalStateException('One native Git source remote is required')
        }
        def remote = scm.userRemoteConfigs[0]
        def uri = new URI(remote.url)
        String path = '/' + source.repoOwner + '/' + source.repository
        if (remote.credentialsId != source.credentialsId ||
            uri.scheme != 'https' || uri.host != 'github.com' || uri.userInfo != null ||
            !(uri.port in [-1, 443]) || uri.query != null || uri.fragment != null ||
            !(uri.path in [path, path + '.git']) ||
            !(remote.name in [null, '', 'origin'])) {
            throw new IllegalStateException('Checkout must use only the source App over native GitHub HTTPS')
        }
        def revision = SCMRevisionAction.getRevision(source, run)
        def extensions = CheckoutPolicy.extensions(scm.extensions, revision, identity.source_sha as String)
        def refspecs = (remote.refspec ?: '').tokenize()
        if (identity.entry.tier != 'product') {
            String heads = '+refs/heads/*:refs/remotes/origin/*'
            if (!refspecs.contains(heads)) { refspecs.add(heads) }
        }
        String refspec = refspecs.join(' ')
        def remotes = [new UserRemoteConfig(remote.url, 'origin', refspec, remote.credentialsId)]
        // Empty legacy submodule configuration; only reconstructed callbacks.
        return new GitSCM(remotes, scm.branches, false, [], null, scm.gitTool, extensions)
    }

    @NonCPS
    private static GitHubAppCredentials approvedApp(def run, GitHubSCMSource source, Map entry) {
        if (!source?.credentialsId ||
            !(source.apiUri in [null, '', 'https://api.github.com', 'https://api.github.com/'])) {
            throw new IllegalStateException('Enrolled GitHub.com App source required')
        }
        def credential = Connector.lookupScanCredentials(run.parent, source.apiUri,
                                                        source.credentialsId, source.repoOwner)
        if (!(credential instanceof GitHubAppCredentials) || credential.getAppID() != entry.app_id ||
            !(credential.apiUri in [null, '', 'https://api.github.com', 'https://api.github.com/'])) {
            throw new IllegalStateException('Source credential must be the enrolled GitHub App')
        }
        // Identity/type inspection only: native checkout owns token materialization.
        return credential
    }

    @NonCPS
    private static boolean retryableGitHubFailure(Exception problem) {
        // HttpException is also an IOException: never retry HTTP 4xx.
        if (problem instanceof HttpException) {
            return problem.responseCode >= 500 && problem.responseCode <= 599
        }
        return problem instanceof IOException
    }

    // CPS-compatible: the caller supplies Pipeline sleep; tests inject a recorder.
    static def retryGitHub(Closure action, Closure sleeper) {
        for (int attempt = 0; ; attempt++) {
            try {
                return action()
            } catch (Exception problem) {
                if (attempt >= 3 || !retryableGitHubFailure(problem)) { throw problem }
                sleeper(2 << attempt)
            }
        }
    }

    static void requireCurrentHead(Closure run, Map identity, Closure sleeper) {
        // Resolve rawBuild only inside the synchronous attempt. Jenkins objects
        // must not remain in CPS locals across the injected Pipeline sleep.
        retryGitHub({ requireCurrentHeadAttempt(run(), identity) }, sleeper)
    }

    @NonCPS
    private static void requireCurrentHeadAttempt(def run, Map identity) {
        def source = SCMSource.SourceByItem.findSource(run.parent) as GitHubSCMSource
        def recorded = SCMRevisionAction.getRevision(source, run)
        def current = source.fetch(recorded.head, null)
        String sha = current instanceof PullRequestSCMRevision ? current.pullHash : current?.hash
        boolean baseMoved = identity.pull_request &&
            (!(current instanceof PullRequestSCMRevision) || current.baseHash != identity.base_sha)
        if (sha != identity.source_sha || baseMoved) {
            throw new IllegalStateException('Source head/base moved; this attempt cannot publish SUCCESS')
        }
    }

    @NonCPS
    static void requireNoRunner() {
        if (Jenkins.get().getNode('runner') != null) {
            throw new IllegalStateException('Runner registration exists; operator reconciliation required')
        }
    }

    @NonCPS
    static void registerRunner(Map config, String attempt) {
        requireNoRunner()
        if (!Jenkins.get().nodesObject.addNodeIfAbsent(new OwnedRunner(config, attempt))) {
            throw new IllegalStateException('Runner registration race')
        }
    }

    @NonCPS
    static boolean runnerOnline(String attempt) {
        def node = ownedRunner(attempt)
        if (node == null) { throw new IllegalStateException('Runner registration missing') }
        return node.toComputer()?.online == true
    }

    @NonCPS
    private static def ownedRunner(String attempt) {
        def node = Jenkins.get().getNode('runner')
        if (node != null && (!(node instanceof OwnedRunner) || node.attemptId != attempt)) {
            throw new IllegalStateException('Runner ownership mismatch')
        }
        return node
    }

    @NonCPS
    static void disconnectRunner(String attempt) {
        def node = ownedRunner(attempt)
        if (node == null) { return } // Restart: ephemeral registration is absent.
        def computer = node.toComputer()
        computer.setAcceptingTasks(false)
        computer.setTemporarilyOffline(true, new OfflineCause.ByCLI('CI cleanup'))
        computer.disconnect(new OfflineCause.ByCLI('CI cleanup'))
    }

    @NonCPS
    static boolean runnerStopped(String attempt) {
        def node = ownedRunner(attempt)
        if (node == null) { return true }
        def computer = node.toComputer()
        return !computer.connecting && computer.channel == null &&
            computer.executors.every { it.currentExecutable == null } &&
            computer.oneOffExecutors.every { it.currentExecutable == null }
    }

    @NonCPS
    static void removeRunner(String attempt) {
        if (!runnerStopped(attempt)) { throw new IllegalStateException('Runner remains busy') }
        def node = ownedRunner(attempt)
        if (node != null) { Jenkins.get().removeNode(node) }
    }

    @NonCPS
    static void readback(def run, Map identity, String status, String conclusion) {
        // Native publisher catches IOException; check its actual ID at receiver.
        try {
            def source = SCMSource.SourceByItem.findSource(run.parent) as GitHubSCMSource
            def credential = approvedApp(run, source, identity.entry as Map)
            def action = run.getActions(GitHubChecksAction).find { it.name == identity.entry.check_name }
            if (!action) { throw new IllegalStateException('Publisher returned no check ID') }
            def repository = Connector.connect(source.apiUri, credential).getRepository(identity.repository)
            // Installed github-api exposes the commit-scoped list, not getCheckRun(id).
            def check = repository.getCheckRuns(identity.source_sha, [filter: 'all']).find {
                it.id.toString() == action.id.toString()
            }
            String expectedConclusion = [CANCELED: 'CANCELLED', TIME_OUT: 'TIMED_OUT'].get(conclusion, conclusion)
            if (!check || repository.id.toString() != identity.entry.repo_id ||
                check.name != identity.entry.check_name || check.headSha != identity.source_sha ||
                check.externalId != run.externalizableId || check.app.id.toString() != identity.entry.app_id ||
                check.status.name() != status ||
                (expectedConclusion != null && check.conclusion?.name() != expectedConclusion)) {
                throw new IllegalStateException('Published check identity or outcome differs')
            }
        } catch (Exception ignored) {
            // Never propagate credential-library/API error bodies into console.
            String message = 'GitHub check readback failed; publication is unverified'
            if (retryableGitHubFailure(ignored)) { throw new IOException(message) }
            throw new IllegalStateException(message)
        }
    }
}
