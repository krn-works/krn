# Required plugin identities

This is an inventory, **not an installation input or version lock**. Do not
resolve these names to `latest`. Existing `plugins.txt` pins remain unverified
direct candidates. Freeze compatible exact versions, transitive dependencies
and digests before any installation; no such installation is authorized here.

| Plugin ID | Role |
| --- | --- |
| configuration-as-code | Controller configuration |
| matrix-auth | Admin-only seed permissions |
| script-security | Pipeline trust boundary |
| workflow-job | Pipeline jobs |
| workflow-cps | Pipeline execution |
| workflow-basic-steps | timeout, waitUntil, stash, writeFile |
| workflow-durable-task-step | node and sh |
| workflow-scm-step | checkout |
| workflow-multibranch | Source revision context |
| pipeline-groovy-lib | Global trusted library |
| git | Full source checkout/bundle |
| command-launcher | Trusted local control agent |
| ssh-slaves | Native SSH runner launch |
| lockable-resources | Global ci-runner slot |
| github-branch-source | GitHub App scan, origin PR head and main |
| remote-file | Protected central Jenkinsfile |
| checks-api | Explicit publishChecks |
| github-checks | Native controller-side Checks publisher |

The trust wrapper also uses Jenkins core and the plugins' Java APIs. Exact
runtime compatibility and source/job configuration must be qualified against
the eventual complete lock. No JUnit automatic check publisher is needed.
