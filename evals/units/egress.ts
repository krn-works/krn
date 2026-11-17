// Network for a sandboxed install without the host's loopback or private networks.
//
// The install phase runs in a network namespace of its own (only its own `lo`), so nothing inside reaches a host
// listener directly: not 127.0.0.1, not [::1], not a LAN address. Package downloads go through an HTTP proxy that
// this process serves on a unix socket; `forward.ts` runs inside the sandbox, listens on the sandbox's own loopback
// and pipes each connection to that socket. The proxy resolves the destination itself, refuses it when any address
// is loopback, private, link-local or one of the host's own, and connects to the vetted address with no second
// lookup. It passes CONNECT tunnels through untouched (no TLS termination) and forwards plain absolute-URI HTTP.

import { lookup } from 'node:dns/promises';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import {
  createServer,
  type IncomingMessage,
  request,
  type Server,
} from 'node:http';
import { BlockList, connect, isIP, type Socket } from 'node:net';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The proxy address a sandboxed command sees: its own loopback, where forward.ts listens. */
export const SANDBOX_PROXY_PORT = 3128;
export const FORWARDER = fileURLToPath(new URL('forward.ts', import.meta.url));

// No ::ffff:0:0/96 rule: BlockList matches IPv4 addresses against IPv4-mapped IPv6 subnets, so it would refuse every
// IPv4 address; unmapped() judges the mapped form as IPv4 instead.
const blocked = new BlockList();
for (const [net, bits] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const)
  blocked.addSubnet(net, bits, 'ipv4');
for (const [net, bits] of [
  ['::', 128],
  ['::1', 128],
  ['64:ff9b::', 96],
  ['64:ff9b:1::', 48],
  ['fc00::', 7],
  ['fe80::', 10],
  ['fec0::', 10],
  ['ff00::', 8],
] as const)
  blocked.addSubnet(net, bits, 'ipv6');

/** An IPv4-mapped IPv6 address as its IPv4 form, so ::ffff:127.0.0.1 is judged as 127.0.0.1. */
function unmapped(ip: string): string {
  const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  return m?.[1] ?? ip;
}

/**
 * Whether a sandboxed install may connect to `ip`: never loopback, unspecified, private, shared, link-local,
 * multicast, reserved or NAT64 space, never an IPv4-mapped form of those, and never an address of this host.
 */
export function egressAllowed(
  ip: string,
  hostAddresses: readonly string[] = ownAddresses(),
): boolean {
  const a = unmapped(ip.replace(/^\[|\]$/g, '').replace(/%.*$/, ''));
  const family = isIP(a);
  if (family === 0) return false;
  if (blocked.check(a, family === 4 ? 'ipv4' : 'ipv6')) return false;
  return !hostAddresses.some((h) => unmapped(h.replace(/%.*$/, '')) === a);
}

function ownAddresses(): string[] {
  return Object.values(networkInterfaces())
    .flat()
    .flatMap((i) => (i ? [i.address] : []));
}

/** The vetted address for `host`, or the reason it is refused. One lookup; the caller connects to this address. */
export async function vet(
  host: string,
): Promise<{ ip: string } | { refused: string }> {
  const bare = host.replace(/^\[|\]$/g, '');
  let ips: string[];
  try {
    ips = isIP(bare)
      ? [bare]
      : (await lookup(bare, { all: true, verbatim: true })).map(
          (r) => r.address,
        );
  } catch (e) {
    return { refused: `${host} does not resolve: ${(e as Error).message}` };
  }
  const own = ownAddresses();
  const bad = ips.find((ip) => !egressAllowed(ip, own));
  if (bad !== undefined || ips.length === 0)
    return { refused: `${host} resolves to ${bad ?? 'nothing'}` };
  return { ip: ips[0] as string };
}

function splitHostPort(
  authority: string,
): { host: string; port: number } | undefined {
  const m = /^(\[[^\]]+\]|[^:]+):(\d+)$/.exec(authority);
  if (!m) return undefined;
  return { host: m[1] as string, port: Number(m[2]) };
}

function onConnect(req: IncomingMessage, client: Socket, head: Buffer): void {
  client.on('error', () => client.destroy());
  const target = splitHostPort(req.url ?? '');
  if (!target) {
    client.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    return;
  }
  void vet(target.host).then((v) => {
    if ('refused' in v) {
      client.end(
        `HTTP/1.1 403 Forbidden\r\nX-Egress-Refused: ${v.refused.replace(/[\r\n]/g, ' ')}\r\n\r\n`,
      );
      return;
    }
    const up = connect(target.port, v.ip, () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length > 0) up.write(head);
      up.pipe(client);
      client.pipe(up);
    });
    up.on('error', () => {
      if (client.writable) client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
      else client.destroy();
    });
    client.on('close', () => up.destroy());
  });
}

function onRequest(
  req: IncomingMessage,
  res: import('node:http').ServerResponse,
): void {
  let url: URL;
  try {
    url = new URL(req.url ?? '');
  } catch {
    res.writeHead(400).end();
    return;
  }
  if (url.protocol !== 'http:') {
    res.writeHead(400).end();
    return;
  }
  void vet(url.hostname).then((v) => {
    if ('refused' in v) {
      res.writeHead(403, { 'X-Egress-Refused': v.refused }).end();
      return;
    }
    const headers: import('node:http').OutgoingHttpHeaders = {
      ...req.headers,
      host: url.host,
    };
    delete headers['proxy-connection'];
    delete headers['proxy-authorization'];
    const up = request(
      {
        host: v.ip,
        port: Number(url.port || 80),
        method: req.method,
        path: url.pathname + url.search,
        headers,
      },
      (r) => {
        res.writeHead(r.statusCode ?? 502, r.headers);
        r.pipe(res);
      },
    );
    up.on('error', () => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    req.pipe(up);
  });
}

export interface Egress {
  /** The unix socket the sandbox's forwarder dials; its directory must be bound into the sandbox. */
  socket: string;
  /** The directory holding the socket. */
  dir: string;
  close(): Promise<void>;
}

/**
 * Starts the filtering proxy on a fresh unix socket under `parent` (keep it short: unix paths stop at 107 bytes).
 * It serves from this process's event loop: spawn the sandbox asynchronously, since spawnSync blocks the loop and
 * every download through the proxy then hangs.
 */
export async function startEgress(parent: string): Promise<Egress> {
  const dir = mkdtempSync(join(parent, 'egress-'));
  const socket = join(dir, 'proxy.sock');
  if (Buffer.byteLength(socket) > 107)
    throw new Error(`egress socket path too long for a unix socket: ${socket}`);
  const server: Server = createServer(onRequest);
  // Tunnels leave the HTTP server's connection tracking: close() destroys this server's own so it never waits on one.
  const tunnels = new Set<Socket>();
  server.on('connect', (req: IncomingMessage, client: Socket, head: Buffer) => {
    tunnels.add(client);
    client.on('close', () => tunnels.delete(client));
    onConnect(req, client, head);
  });
  server.on('clientError', (_e, s) => s.destroy());
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socket, () => resolve());
  });
  return {
    socket,
    dir,
    close: () =>
      new Promise((resolve) => {
        server.close(() => {
          if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
          resolve();
        });
        server.closeAllConnections();
        for (const t of tunnels) t.destroy();
      }),
  };
}

/** Proxy variables for a sandboxed command; NO_PROXY is left unset so nothing bypasses the filter. */
export function proxyEnv(): NodeJS.ProcessEnv {
  const p = `http://127.0.0.1:${SANDBOX_PROXY_PORT}`;
  return {
    HTTP_PROXY: p,
    HTTPS_PROXY: p,
    http_proxy: p,
    https_proxy: p,
    // Node's built-in fetch ignores the proxy variables without this.
    NODE_USE_ENV_PROXY: '1',
  };
}
