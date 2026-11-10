import { existsSync } from 'node:fs';
import { join } from 'node:path';

export const PROXY_PORT = 47318;
export const HEALTH_TIMEOUT_MS = 300;
export const KILL_FILE = '.krn/runs/ctx-proxy/off';

// The base URL a new Claude session should use, or undefined to launch
// unchanged. Fails open: a kill switch (KRN_CTX_PROXY=off or the off file under
// `root`), a foreign ANTHROPIC_BASE_URL, or a proxy that does not answer
// /krn-health with 200 within KRN_CTX_PROXY_TIMEOUT_MS (default 300) all mean "no proxy".
export async function proxyBaseUrl(
  env: NodeJS.ProcessEnv,
  root: string,
  timeoutMs = Number(env.KRN_CTX_PROXY_TIMEOUT_MS) || HEALTH_TIMEOUT_MS,
): Promise<string | undefined> {
  if (env.KRN_CTX_PROXY === 'off' || existsSync(join(root, KILL_FILE))) return;
  const port = Number(env.KRN_CTX_PROXY_PORT ?? PROXY_PORT);
  const base = `http://127.0.0.1:${port}`;
  // Never override a base URL the operator pointed somewhere else.
  if (env.ANTHROPIC_BASE_URL && env.ANTHROPIC_BASE_URL !== base) return;
  try {
    const reply = await fetch(`${base}/krn-health`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    return reply.status === 200 ? base : undefined;
  } catch {
    return undefined;
  }
}
