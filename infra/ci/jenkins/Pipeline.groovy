// Remote Jenkinsfile Provider loads ONLY this protected central definition.
// Configure the implicit trusted library `owned-ci` at the SAME exact config
// commit; disable version overrides. No PR Jenkinsfile/library is evaluated.
properties([disableConcurrentBuilds()])
if (!params.isEmpty()) {
    error('This job accepts no admission, command or configuration parameters')
}
// SCMVar binds the product revision needed by native GitHub Checks.
def sourceScm = scm
ownedCi(sourceScm)
