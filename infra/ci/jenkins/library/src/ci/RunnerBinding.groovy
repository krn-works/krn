package ci

import com.cloudbees.groovy.cps.NonCPS

/** Pure comparison of the two transports' public deployment identity. */
class RunnerBinding {
    static final String CREDENTIAL_ID = 'ci-runner-ssh'
    static final String USER = 'jenkins'
    static final String KNOWN_HOSTS = '/etc/ci-platform/runner_known_hosts'

    @NonCPS
    static Map verify(Map enrolled, Map control, String knownHosts,
                      String credentialId, String username) {
        Map endpoint = control.runner as Map
        if (control.schema_version != 1 || endpoint == null ||
            enrolled.host != endpoint.host || enrolled.port != 22 || endpoint.user != USER ||
            username != endpoint.user || credentialId != CREDENTIAL_ID ||
            enrolled.credentials_id != CREDENTIAL_ID || endpoint.known_hosts_file != KNOWN_HOSTS) {
            throw new IllegalStateException('Jenkins and Go runner endpoint/credential pins differ')
        }
        def keys = knownHosts.readLines().collect { it.trim() }.findAll { it && !it.startsWith('#') }
        def pin = (enrolled.host_key ?: '').trim().tokenize()
        if (keys.size() != 1 || pin.size() != 2) {
            throw new IllegalStateException('One explicit runner public host key is required')
        }
        def fields = keys[0].tokenize()
        if (fields.size() < 3 || fields[0] != endpoint.host ||
            fields[1] != pin[0] || fields[2] != pin[1]) {
            throw new IllegalStateException('Jenkins and Go runner public host keys differ')
        }
        try {
            byte[] blob = Base64.decoder.decode(pin[1])
            if (blob.length == 0 || Base64.encoder.encodeToString(blob) != pin[1]) {
                throw new IllegalArgumentException()
            }
        } catch (IllegalArgumentException ignored) {
            throw new IllegalStateException('Runner public host key encoding is invalid')
        }
        return [host: endpoint.host, port: 22, user: USER,
                credentials_id: CREDENTIAL_ID, host_key: pin.join(' ')]
    }
}
