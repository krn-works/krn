package ci

import com.cloudbees.groovy.cps.NonCPS
import hudson.model.Node
import hudson.model.Slave
import hudson.slaves.DumbSlave
import hudson.slaves.EphemeralNode
import hudson.slaves.RetentionStrategy
import hudson.plugins.sshslaves.SSHLauncher
import hudson.plugins.sshslaves.verifiers.ManuallyProvidedKeyVerificationStrategy
import jenkins.model.Jenkins

/** Fixed runner VM; only its Jenkins registration is disposable. */
class OwnedRunner extends Slave implements EphemeralNode {
    final String attemptId

    OwnedRunner(Map config, String attempt) {
        super('runner', config.remote_fs as String, launcher(config))
        attemptId = attempt
        numExecutors = 1
        mode = Node.Mode.EXCLUSIVE
        labelString = 'runner'
        // NOOP launches once on registration, but never periodically reconnects.
        // EphemeralNode is not saved, so restart cannot auto-launch a dirty VM.
        retentionStrategy = RetentionStrategy.NOOP
    }

    @NonCPS
    private static SSHLauncher launcher(Map config) {
        def launcher = new SSHLauncher(config.host as String, config.port as int,
                                       config.credentials_id as String)
        launcher.setSshHostKeyVerificationStrategy(
            new ManuallyProvidedKeyVerificationStrategy(config.host_key as String))
        launcher.setMaxNumRetries(0)
        launcher.setLaunchTimeoutSeconds(60)
        return launcher
    }

    @NonCPS
    Node asNode() { this }

    @NonCPS
    Slave.SlaveDescriptor getDescriptor() {
        Jenkins.get().getDescriptorByType(DumbSlave.DescriptorImpl)
    }
}
