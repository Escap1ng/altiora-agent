import assert from "node:assert/strict";
import { test } from "node:test";
import { fetchModelLimits } from "../../src/providers/models.ts";
import { startMockServer } from "../mock/openai-server.ts";

test("reads context_window and max_output for the requested model", async () => {
  const mock = await startMockServer(() => ({
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ data: [{ id: "m", context_window: 1048576, max_output: 393216 }] }),
  }));
  try {
    const limits = await fetchModelLimits({ baseUrl: mock.url, apiKey: "secret", model: "m" });
    assert.deepEqual(limits, { contextWindow: 1048576, maxOutputTokens: 393216 });
    assert.equal(mock.requests[0]?.url, "/v1/models");
    assert.equal(mock.requests[0]?.headers.authorization, "Bearer secret");
  } finally {
    await mock.close();
  }
});

test("accepts context_length as an alias", async () => {
  const mock = await startMockServer(() => ({
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ data: [{ id: "m", context_length: 200000 }] }),
  }));
  try {
    const limits = await fetchModelLimits({ baseUrl: mock.url, apiKey: "k", model: "m" });
    assert.deepEqual(limits, { contextWindow: 200000 });
  } finally {
    await mock.close();
  }
});

test("returns undefined when the model is absent from the listing", async () => {
  const mock = await startMockServer(() => ({
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ data: [{ id: "other", context_window: 1048576 }] }),
  }));
  try {
    assert.equal(await fetchModelLimits({ baseUrl: mock.url, apiKey: "k", model: "m" }), undefined);
  } finally {
    await mock.close();
  }
});

test("returns undefined for a non-200 response", async () => {
  const mock = await startMockServer(() => ({ status: 404, body: "not found" }));
  try {
    assert.equal(await fetchModelLimits({ baseUrl: mock.url, apiKey: "k", model: "m" }), undefined);
  } finally {
    await mock.close();
  }
});

test("returns undefined for a malformed payload", async () => {
  const mock = await startMockServer(() => ({
    headers: { "content-type": "application/json" },
    body: "{not json",
  }));
  try {
    assert.equal(await fetchModelLimits({ baseUrl: mock.url, apiKey: "k", model: "m" }), undefined);
  } finally {
    await mock.close();
  }
});

test("returns undefined when the connection drops", async () => {
  const mock = await startMockServer(() => ({ destroy: true }));
  try {
    assert.equal(await fetchModelLimits({ baseUrl: mock.url, apiKey: "k", model: "m" }), undefined);
  } finally {
    await mock.close();
  }
});

test("ignores implausible token counts", async () => {
  const mock = await startMockServer(() => ({
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ data: [{ id: "m", context_window: 0, max_output: 99_000_000 }] }),
  }));
  try {
    assert.equal(await fetchModelLimits({ baseUrl: mock.url, apiKey: "k", model: "m" }), undefined);
  } finally {
    await mock.close();
  }
});
