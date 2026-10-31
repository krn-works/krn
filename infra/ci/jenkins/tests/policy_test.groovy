import ci.CheckoutPolicy
import ci.Controller
import ci.RunnerBinding
import hudson.plugins.git.extensions.impl.BuildChooserSetting
import hudson.plugins.git.extensions.impl.CloneOption
import hudson.plugins.git.extensions.impl.GitLFSPull
import hudson.plugins.git.extensions.impl.SubmoduleOption
import hudson.plugins.git.util.DefaultBuildChooser
import jenkins.plugins.git.AbstractGitSCMSource
import jenkins.plugins.git.GitSCMSourceDefaults
import jenkins.scm.api.SCMHead
import org.jenkinsci.plugins.gitclient.GitClient

// Run with the installed Jenkins/plugin jars; no Jenkins instance or keys used.
def rejects = { Closure action ->
    boolean rejected = false
    try { action.call() } catch (IllegalStateException expected) { rejected = true }
    assert rejected
}
// The enabled contract is exactly Product plus GLOBAL, with string IDs as
// supplied by enrollment JSON. No Jenkins instance or credential lookup occurs.
def enrollmentFixture = {
    def common = [app_id: '5548482', config_sha: '1' * 40,
                  image_fingerprint: '2' * 64, main_branch: 'main',
                  timeout_seconds: 1800, memory_mib: 6144, process_limit: 512]
    [schema_version: 1, enabled: true, library_sha: '1' * 40,
     repositories: [
         'krn-works/krn': common + [repo_id: '1409811398', job: 'ci/product',
                                   tier: 'product', check_name: 'krn/gate'],
         'krn-works/krn-codex-skills': common + [repo_id: '1246837409', jobs: [
             'ci/global-fast': [tier: 'global-fast', check_name: 'gate (fast)'],
             'ci/global-deep': [tier: 'global-deep', check_name: 'gate (deep)']]]]]
}
Controller.validateEnrollment(enrollmentFixture())
[
    wrongProductApp: { c -> c.repositories['krn-works/krn'].app_id = '1' },
    wrongGlobalApp: { c -> c.repositories['krn-works/krn-codex-skills'].app_id = '1' },
    numericApp: { c -> c.repositories['krn-works/krn'].app_id = 5548482 },
    thirdRepository: { c -> c.repositories['krn-works/third'] = [:] },
    missingProduct: { c -> c.repositories.remove('krn-works/krn') },
    missingGlobal: { c -> c.repositories.remove('krn-works/krn-codex-skills') },
    repositoryAlias: { c -> c.repositories['krn-works/alias'] = c.repositories.remove('krn-works/krn') },
    wrongProductId: { c -> c.repositories['krn-works/krn'].repo_id = '1246837409' },
    wrongGlobalId: { c -> c.repositories['krn-works/krn-codex-skills'].repo_id = '1409811398' },
    numericRepositoryId: { c -> c.repositories['krn-works/krn'].repo_id = 1409811398 },
    wrongProductName: { c -> c.repositories['krn-works/krn'].check_name = 'gate' },
    wrongProductTier: { c -> c.repositories['krn-works/krn'].tier = 'global-fast' },
    wrongFastName: { c -> c.repositories['krn-works/krn-codex-skills'].jobs['ci/global-fast'].check_name = 'gate (deep)' },
    wrongDeepName: { c -> c.repositories['krn-works/krn-codex-skills'].jobs['ci/global-deep'].check_name = 'gate (fast)' },
    missingGlobalJob: { c -> c.repositories['krn-works/krn-codex-skills'].jobs.remove('ci/global-deep') },
    globalJobAppOverride: { c -> c.repositories['krn-works/krn-codex-skills'].jobs['ci/global-fast'].app_id = '1' },
    globalJobIdOverride: { c -> c.repositories['krn-works/krn-codex-skills'].jobs['ci/global-deep'].repo_id = '1409811398' }
].each { scenario, mutate ->
    def config = enrollmentFixture()
    mutate.call(config)
    boolean rejected = false
    try { Controller.validateEnrollment(config) } catch (IllegalStateException expected) { rejected = true }
    assert rejected: scenario
}
// An invalid unselected repository also blocks admission before source lookup.
def wrongGlobal = enrollmentFixture()
wrongGlobal.repositories['krn-works/krn-codex-skills'].app_id = '1'
rejects { Controller.sourceIdentity(null, wrongGlobal) }

String sha = '1' * 40
def revision = new AbstractGitSCMSource.SCMRevisionImpl(new SCMHead('source'), sha)
def originalClone = new CloneOption(true, false, '/untrusted-reference', 1)
def safe = CheckoutPolicy.extensions([new GitSCMSourceDefaults(false), originalClone], revision, sha)
assert safe*.getClass() == [BuildChooserSetting, CloneOption, SubmoduleOption]
assert safe[1].shallow == false && safe[1].reference == null
assert !safe[1].is(originalClone)
assert safe[2].disableSubmodules && !safe[2].parentCredentials
assert !safe[2].recursiveSubmodules && !safe[2].trackingSubmodules
assert safe[0].buildChooser.getCandidateRevisions(false, null, (GitClient) null, null, null, null).first().sha1String == sha
rejects { CheckoutPolicy.extensions([new SubmoduleOption(false, true, false, null, 1, true)], revision, sha) }
rejects { CheckoutPolicy.extensions([new GitLFSPull()], revision, sha) }
rejects { CheckoutPolicy.extensions([new Object()], revision, sha) }
rejects { CheckoutPolicy.extensions([new BuildChooserSetting(new DefaultBuildChooser())], revision, sha) }

// Synthetic public pin; no private key or real credential is generated/read.
def fixture = {
    [enrolled: [host: '203.0.113.9', port: 22, credentials_id: 'ci-runner-ssh',
                host_key: 'ssh-ed25519 AQID'],
     control: [schema_version: 1, runner: [host: '203.0.113.9', user: 'jenkins',
                known_hosts_file: '/etc/ci-platform/runner_known_hosts']],
     known: '203.0.113.9 ssh-ed25519 AQID\n', id: 'ci-runner-ssh', user: 'jenkins']
}
def verify = { Map f -> RunnerBinding.verify(f.enrolled, f.control, f.known, f.id, f.user) }
assert verify(fixture()).port == 22
[
    { f -> f.control.runner.host = '203.0.113.10' },
    { f -> f.enrolled.port = 2222 },
    { f -> f.control.runner.user = 'other' },
    { f -> f.user = 'other' },
    { f -> f.id = 'other-key' },
    { f -> f.enrolled.credentials_id = 'other-key' },
    { f -> f.control.runner.known_hosts_file = '/different/pins' },
    { f -> f.enrolled.host_key = 'ssh-ed25519 BAUG' },
    { f -> f.known = '203.0.113.10 ssh-ed25519 AQID\n' },
    { f -> f.known = '|1|hashed|host ssh-ed25519 AQID\n' },
    { f -> f.known += '203.0.113.9 ssh-ed25519 BAUG\n' }
].each { mutate ->
    def f = fixture()
    mutate.call(f)
    rejects { verify(f) }
}
println('PASS: approved two-repository enrollment, checkout policy, exact revision, and runner binding negative cases')
