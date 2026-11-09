import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

// The only upstream the proxy ever talks to in production. There is no env or
// config switch: credentials pass through here, so the destination is code.
export const UPSTREAM = 'https://api.anthropic.com';
export const DEFAULT_METRICS = '.krn/runs/ctx-proxy/metrics.jsonl';
const KEEP_TOOL_USES = 8;
const MIN_CLEAR_BYTES = 1024;
const COLD_AFTER_S = 300;
const SESSION_HEADER = 'x-claude-code-session-id';

type Json = Record<string, unknown>;
type Usage = {
  input: number;
  cacheRead: number;
  cacheCreation: number;
  output: number;
};
export type Shadow = {
  toolResults: number;
  toolResultBytes: number;
  wouldClearBytes: number;
};

const isObject = (v: unknown): v is Json =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown): number => (typeof v === 'number' ? v : 0);
const blocks = (request: Json): Json[] => {
  const messages = Array.isArray(request.messages) ? request.messages : [];
  const out: Json[] = [];
  for (const message of messages) {
    if (isObject(message) && Array.isArray(message.content)) {
      out.push(...message.content.filter(isObject));
    }
  }
  return out;
};

// What a clearing policy would remove: tool_result blocks whose tool use is
// older than the last `keep` tool uses, ignoring results under one kilobyte.
export function shadowClear(request: Json, keep = KEEP_TOOL_USES): Shadow {
  const all = blocks(request);
  const recent = new Set(
    all
      .filter((b) => b.type === 'tool_use')
      .map((b) => b.id)
      .slice(-keep),
  );
  const shadow: Shadow = {
    toolResults: 0,
    toolResultBytes: 0,
    wouldClearBytes: 0,
  };
  for (const block of all) {
    if (block.type !== 'tool_result') continue;
    const bytes = Buffer.byteLength(JSON.stringify(block.content ?? ''));
    shadow.toolResults += 1;
    shadow.toolResultBytes += bytes;
    if (bytes >= MIN_CLEAR_BYTES && !recent.has(block.tool_use_id)) {
      shadow.wouldClearBytes += bytes;
    }
  }
  return shadow;
}

function sessionKey(request: Json, header: unknown): string {
  let seed = typeof header === 'string' ? header : '';
  if (!seed) {
    const messages = Array.isArray(request.messages) ? request.messages : [];
    const first = messages.find((m) => isObject(m) && m.role === 'user');
    seed = JSON.stringify(first ?? '');
  }
  return createHash('sha256').update(seed).digest('hex').slice(0, 12);
}

// Reads usage from an identity-encoded body: SSE events or one JSON document.
class UsageTap {
  usage: Usage = { input: 0, cacheRead: 0, cacheCreation: 0, output: 0 };
  private buffer = '';
  private plain = '';
  private readonly stream: boolean;
  constructor(stream: boolean) {
    this.stream = stream;
  }

  push(chunk: Buffer): void {
    if (!this.stream) {
      this.plain += chunk.toString('utf8');
      return;
    }
    this.buffer += chunk.toString('utf8');
    let at = this.buffer.indexOf('\n');
    while (at >= 0) {
      this.line(this.buffer.slice(0, at));
      this.buffer = this.buffer.slice(at + 1);
      at = this.buffer.indexOf('\n');
    }
  }

  end(): void {
    if (this.stream) this.line(this.buffer);
    else this.take(this.plain, false);
  }

  private line(raw: string): void {
    if (raw.startsWith('data:')) this.take(raw.slice(5).trim(), true);
  }

  private take(text: string, event: boolean): void {
    let doc: unknown;
    try {
      doc = JSON.parse(text);
    } catch {
      return;
    }
    if (!isObject(doc)) return;
    const message = event && isObject(doc.message) ? doc.message : doc;
    const usage = isObject(doc.usage) ? doc.usage : message.usage;
    if (!isObject(usage)) return;
    const u = this.usage;
    u.input = num(usage.input_tokens) || u.input;
    u.cacheRead = num(usage.cache_read_input_tokens) || u.cacheRead;
    u.cacheCreation = num(usage.cache_creation_input_tokens) || u.cacheCreation;
    u.output = num(usage.output_tokens) || u.output;
  }
}

export type ProxyOptions = {
  // Test-only: production callers omit it and get UPSTREAM.
  upstream?: string;
  metricsPath?: string;
  keep?: number;
  now?: () => number;
};

export function createProxy(options: ProxyOptions = {}): http.Server {
  const upstream = new URL(options.upstream ?? UPSTREAM);
  const transport = upstream.protocol === 'https:' ? https : http;
  const metricsPath = options.metricsPath ?? DEFAULT_METRICS;
  const now = options.now ?? Date.now;
  const lastSeen = new Map<string, number>();

  function record(line: Json): void {
    mkdirSync(dirname(metricsPath), { recursive: true });
    appendFileSync(metricsPath, `${JSON.stringify(line)}\n`);
  }

  function forward(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    body: Buffer,
    onDone?: (tap: UsageTap) => void,
    watch = false,
  ): void {
    const headers = { ...req.headers, host: upstream.host };
    delete headers['accept-encoding'];
    delete headers.connection;
    const out = transport.request(
      {
        protocol: upstream.protocol,
        hostname: upstream.hostname,
        port: upstream.port || undefined,
        method: req.method,
        path: req.url,
        headers,
      },
      (reply) => {
        res.writeHead(
          reply.statusCode ?? 502,
          reply.statusMessage,
          reply.headers,
        );
        const tap = new UsageTap(
          String(reply.headers['content-type'] ?? '').includes(
            'text/event-stream',
          ),
        );
        if (watch) reply.on('data', (c: Buffer) => tap.push(c));
        reply.on('end', () => {
          if (watch) {
            tap.end();
            onDone?.(tap);
          }
        });
        reply.pipe(res);
      },
    );
    out.on('error', () => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    out.end(body);
  }

  return http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/krn-health') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok\n');
      return;
    }
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const path = (req.url ?? '').split('?')[0];
      if (req.method !== 'POST' || path !== '/v1/messages') {
        forward(req, res, body);
        return;
      }
      let request: Json = {};
      try {
        const parsed: unknown = JSON.parse(body.toString('utf8'));
        if (isObject(parsed)) request = parsed;
      } catch {
        /* Unparsable bodies still pass through, with zeroed shadow metrics. */
      }
      const ts = now();
      const session = sessionKey(request, req.headers[SESSION_HEADER]);
      const previous = lastSeen.get(session);
      lastSeen.set(session, ts);
      const gap = previous === undefined ? null : (ts - previous) / 1000;
      const shadow = shadowClear(request, options.keep);
      forward(
        req,
        res,
        body,
        (tap) => {
          record({
            ts: new Date(ts).toISOString(),
            session,
            model: typeof request.model === 'string' ? request.model : null,
            input_tokens: tap.usage.input,
            cache_read_tokens: tap.usage.cacheRead,
            cache_creation_tokens: tap.usage.cacheCreation,
            output_tokens: tap.usage.output,
            request_bytes: body.length,
            tool_result_count: shadow.toolResults,
            tool_result_bytes: shadow.toolResultBytes,
            would_clear_bytes: shadow.wouldClearBytes,
            would_clear_tokens: Math.round(shadow.wouldClearBytes / 4),
            gap_s: gap,
            cold: gap !== null && gap > COLD_AFTER_S,
          });
        },
        true,
      );
    });
  });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const server = createProxy();
  server.listen(Number(process.argv[2] ?? 0), '127.0.0.1', () => {
    const address = server.address();
    if (address && typeof address === 'object') {
      console.log(`ctx-proxy listening on 127.0.0.1:${address.port}`);
    }
  });
}
