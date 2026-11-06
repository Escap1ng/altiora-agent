import assert from "node:assert/strict";
import { test } from "node:test";
import { assertPublicUrl, isBlockedAddress, webfetchTool } from "../../src/tools/webfetch.ts";
import type { ToolContext } from "../../src/tools/registry.ts";

function context(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    cwd: process.cwd(),
    platform: process.platform,
    signal: new AbortController().signal,
    maxOutputChars: 4000,
    bash: { shell: "auto", timeoutMs: 1000 },
    todos: [],
    lookupHost: async () => ["93.184.216.34"],
    fetchImpl: async () =>
      new Response("hello", { status: 200, headers: { "content-type": "text/plain" } }),
    ...overrides,
  };
}

test("fetches text through the transport", async () => {
  const result = await webfetchTool.execute(webfetchTool.parse({ url: "https://example.com" }), context());
  assert.equal(result.output, "hello");
  assert.equal(result.isError, false);
});

test("blocks loopback and link-local addresses", () => {
  assert.equal(isBlockedAddress("127.0.0.1"), true);
  assert.equal(isBlockedAddress("10.1.2.3"), true);
  assert.equal(isBlockedAddress("172.20.0.1"), true);
  assert.equal(isBlockedAddress("192.168.1.1"), true);
  assert.equal(isBlockedAddress("169.254.169.254"), true);
  assert.equal(isBlockedAddress("::1"), true);
  assert.equal(isBlockedAddress("93.184.216.34"), false);
});

test("rejects private hosts and non-http schemes", async () => {
  await assert.rejects(assertPublicUrl("http://127.0.0.1/x", async () => ["127.0.0.1"]), /blocked address/);
  await assert.rejects(assertPublicUrl("http://localhost/x", async () => ["93.184.216.34"]), /blocked host/);
  await assert.rejects(assertPublicUrl("file:///etc/passwd", async () => []), /unsupported url scheme/);
});

test("rejects redirects into private space", async () => {
  const fetchImpl = async (): Promise<Response> =>
    new Response(null, { status: 302, headers: { location: "http://10.0.0.1/secret" } });
  const tool = webfetchTool;
  await assert.rejects(
    tool.execute(tool.parse({ url: "https://example.com" }), context({ fetchImpl })),
    /blocked address/,
  );
});

test("follows a public redirect once", async () => {
  let calls = 0;
  const fetchImpl = async (url: string | URL | Request): Promise<Response> => {
    calls += 1;
    if (calls === 1) {
      return new Response(null, { status: 302, headers: { location: "https://example.com/final" } });
    }
    return new Response(`final:${String(url)}`, {
      status: 200,
      headers: { "content-type": "text/plain" },
    });
  };
  const result = await webfetchTool.execute(
    webfetchTool.parse({ url: "https://example.com/start" }),
    context({ fetchImpl }),
  );
  assert.equal(result.output, "final:https://example.com/final");
});
