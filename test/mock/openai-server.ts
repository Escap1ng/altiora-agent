import { createServer } from "node:http";
import type { IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";

export interface MockRequestRecord {
  body: Record<string, unknown> | null;
  headers: IncomingHttpHeaders;
  url: string;
  at: number;
}

export interface MockDestroy {
  afterChunks: number;
}

export interface MockResponse {
  status?: number;
  headers?: Record<string, string>;
  chunks?: string[];
  body?: string;
  destroy?: boolean | MockDestroy;
}

export type MockHandler = (request: MockRequestRecord, index: number) => MockResponse;

export interface MockServer {
  url: string;
  requests: MockRequestRecord[];
  close(): Promise<void>;
}

export function sseChunks(payloads: unknown[]): string[] {
  return [...payloads.map((payload) => `data: ${JSON.stringify(payload)}\n\n`), "data: [DONE]\n\n"];
}

export async function startMockServer(handler: MockHandler): Promise<MockServer> {
  const requests: MockRequestRecord[] = [];
  const server = createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += String(chunk);
    let body: Record<string, unknown> | null = null;
    if (raw !== "") {
      try {
        body = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        body = null;
      }
    }
    const record: MockRequestRecord = { body, headers: request.headers, url: request.url ?? "", at: Date.now() };
    requests.push(record);
    const result = handler(record, requests.length - 1);
    if (result.destroy === true) {
      response.socket?.destroy();
      return;
    }
    response.writeHead(result.status ?? 200, {
      "content-type": "text/event-stream",
      ...result.headers,
    });
    response.flushHeaders();
    if (result.body !== undefined) {
      response.end(result.body);
      return;
    }
    const chunks = result.chunks ?? [];
    const afterChunks =
      typeof result.destroy === "object" && result.destroy !== null ? result.destroy.afterChunks : undefined;
    if (typeof afterChunks === "number") {
      for (const chunk of chunks.slice(0, afterChunks)) response.write(chunk);
      await new Promise((resolve) => setTimeout(resolve, 30));
      response.socket?.destroy();
      return;
    }
    for (const chunk of chunks) response.write(chunk);
    response.end();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}/v1`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
