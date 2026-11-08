import { once } from 'node:events';
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';

// A scripted OpenAI Responses provider for the real Codex binary: a private
// CODEX_HOME whose model provider points base_url here runs app-server turns
// without an account, network access or a paid KRN_LIVE recording. Each
// POST /v1/responses takes the next scripted reply; anything else is a 404
// and every request is kept for the test to assert on.

export type MockRequest = {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
};

/** One server-sent event of a streamed Responses reply. */
export type ResponseEvent = { readonly type: string } & Record<string, unknown>;

/** A scripted reply: the events of one stream, or an HTTP error. */
export type MockReply =
  | { readonly events: readonly ResponseEvent[] }
  | {
      readonly status: number;
      readonly body: unknown;
      readonly headers?: Record<string, string>;
    };

export type MockProvider = {
  /** The base_url a Codex model provider takes, ending in /v1. */
  readonly baseUrl: string;
  readonly requests: readonly MockRequest[];
  close(): Promise<void>;
};

const usage = {
  input_tokens: 10,
  input_tokens_details: { cached_tokens: 0 },
  output_tokens: 5,
  output_tokens_details: { reasoning_tokens: 0 },
  total_tokens: 15,
};

/** A completed reply whose one assistant message carries text. */
export function assistantReply(id: string, text: string): MockReply {
  return {
    events: [
      { type: 'response.created', response: { id } },
      {
        type: 'response.output_item.done',
        item: {
          type: 'message',
          role: 'assistant',
          phase: 'final_answer',
          id: `${id}-message`,
          content: [{ type: 'output_text', text }],
        },
      },
      { type: 'response.completed', response: { id, usage } },
    ],
  };
}

async function body(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function write(response: ServerResponse, reply: MockReply | undefined): void {
  if (!reply) {
    response.writeHead(500, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify({ error: { message: 'mock script exhausted' } }),
    );
    return;
  }
  if ('status' in reply) {
    response.writeHead(reply.status, {
      'content-type': 'application/json',
      ...reply.headers,
    });
    response.end(JSON.stringify(reply.body));
    return;
  }
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const event of reply.events)
    response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  response.end();
}

/** Starts the provider on a loopback port; replies are used in order. */
export async function startMockProvider(
  replies: readonly MockReply[],
): Promise<MockProvider> {
  const requests: MockRequest[] = [];
  let next = 0;
  const server = createServer(async (request, response) => {
    const path = new URL(request.url ?? '/', 'http://mock').pathname;
    requests.push({
      method: request.method ?? '',
      path,
      body: await body(request),
    });
    if (request.method === 'POST' && path === '/v1/responses')
      write(response, replies[next++]);
    else {
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end('{}');
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () =>
      new Promise((done) => {
        server.closeAllConnections();
        server.close(() => done());
      }),
  };
}

/** config.toml for a private CODEX_HOME whose only provider is the mock. */
export function mockProviderConfig(baseUrl: string): string {
  return [
    'model = "mock-model"',
    'model_provider = "mock"',
    'approval_policy = "never"',
    '',
    '[model_providers.mock]',
    'name = "mock"',
    `base_url = "${baseUrl}"`,
    'wire_api = "responses"',
    'request_max_retries = 0',
    'stream_max_retries = 0',
    '',
  ].join('\n');
}
