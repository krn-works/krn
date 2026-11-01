package ci

/** Lockable Resources orders larger integer priorities first, ties FIFO.
 * Main receives two minutes of preference; an older PR eventually outranks
 * newly arriving main builds. No preemption, draft skipping or timeout/requeue.
 */
class QueuePolicy {
    static int priority(long admittedAtMillis, boolean pullRequest) {
        long minute = Math.floorDiv(admittedAtMillis, 60000L)
        long value = -minute + (pullRequest ? 0L : 2L)
        if (admittedAtMillis < 0 || value < Integer.MIN_VALUE || value > Integer.MAX_VALUE) {
            throw new IllegalStateException('Admission time outside supported lock priority range')
        }
        return (int) value
    }
}
