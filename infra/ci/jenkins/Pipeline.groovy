// Remote Jenkinsfile Provider loads ONLY this protected central definition.
// Configure the implicit trusted library `owned-ci` at the SAME exact config
// commit; disable version overrides. No PR Jenkinsfile/library is evaluated.
// Keep abortPrevious OFF until cancel/export/reset/receiver qualification.
properties([disableConcurrentBuilds(), buildDiscarder(logRotator(
    numToKeepStr: '30', artifactNumToKeepStr: '20', daysToKeepStr: '14', artifactDaysToKeepStr: '7'))])
if (!params.isEmpty()) {
    error('This job accepts no admission, command or configuration parameters')
}
// SCMVar binds the product revision needed by native GitHub Checks.
def sourceScm = scm
ownedCi(sourceScm)
