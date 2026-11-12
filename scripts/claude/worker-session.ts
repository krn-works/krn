// A worker session is one `krn lane run` started (KRN_SESSION_CLASS=lane) or the launcher marked
// KRN_ROLE=worker. Informational hooks (context gauge, hook-error digest) say nothing there: the lead
// reads them, and D23 K runs carried 10.1 hook messages against 1.1 for the plain arm.
export function isWorkerSession(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.KRN_SESSION_CLASS === 'lane' || env.KRN_ROLE === 'worker';
}
