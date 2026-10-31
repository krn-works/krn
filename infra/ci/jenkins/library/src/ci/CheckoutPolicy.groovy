package ci

import com.cloudbees.groovy.cps.NonCPS
import hudson.plugins.git.extensions.impl.BuildChooserSetting
import hudson.plugins.git.extensions.impl.CloneOption
import hudson.plugins.git.extensions.impl.SubmoduleOption
import jenkins.plugins.git.AbstractGitSCMSource

/** The authenticated controller checkout has no source-selected callbacks. */
class CheckoutPolicy {
    static final Set<String> INHERITED_TYPES = [
        'jenkins.plugins.git.GitSCMSourceDefaults',
        'hudson.plugins.git.extensions.impl.BuildChooserSetting',
        'hudson.plugins.git.extensions.impl.CloneOption'
    ].toSet().asImmutable()

    @NonCPS
    static List extensions(Collection inherited, def revision, String sha) {
        inherited.each { extension ->
            if (!(extension.getClass().name in INHERITED_TYPES) ||
                (extension instanceof BuildChooserSetting &&
                 extension.buildChooser.getClass() != AbstractGitSCMSource.SpecificRevisionBuildChooser)) {
                throw new IllegalStateException('Controller checkout extension is not allowlisted')
            }
        }
        if (!(sha ==~ /[0-9a-f]{40}/) || revision == null) {
            throw new IllegalStateException('Pinned source revision required for checkout')
        }
        // Recreate, never copy callbacks or user-supplied clone/reference options.
        def pinned = new AbstractGitSCMSource.SCMRevisionImpl(revision.head, sha)
        def chooser = new BuildChooserSetting(new AbstractGitSCMSource.SpecificRevisionBuildChooser(pinned))
        def clone = new CloneOption(false, false, null, 15)
        clone.setHonorRefspec(true) // Also requires native CLI Git, not JGit.
        def submodules = new SubmoduleOption(true, false, false, null, 15, false)
        return [chooser, clone, submodules]
    }

    @NonCPS
    static List<String> environment() {
        return [
            'GIT_CONFIG_GLOBAL=/dev/null', 'GIT_CONFIG_SYSTEM=/dev/null', 'GIT_CONFIG_NOSYSTEM=1',
            'GIT_LFS_SKIP_SMUDGE=1', 'GIT_CONFIG_COUNT=3',
            'GIT_CONFIG_KEY_0=core.hooksPath', 'GIT_CONFIG_VALUE_0=/dev/null',
            'GIT_CONFIG_KEY_1=submodule.recurse', 'GIT_CONFIG_VALUE_1=false',
            'GIT_CONFIG_KEY_2=protocol.file.allow', 'GIT_CONFIG_VALUE_2=never'
        ]
    }
}
