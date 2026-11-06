import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { HarnessError } from "../core/errors.ts";
import { asObject, requireString, type ToolDefinition } from "./registry.ts";
import { truncateText } from "./truncate.ts";

const MAX_BYTES = 5 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const TIMEOUT_MS = 30000;

interface WebFetchInput {
  url: string;
}

const BLOCKED_V4 = [
  /^0\./,
  /^10\./,
  /^127\./,
  /^169\.254\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
];

export function isBlockedAddress(address: string): boolean {
  if (isIP(address) === 4) return BLOCKED_V4.some((pattern) => pattern.test(address));
  if (isIP(address) === 6) {
    const normalized = address.toLowerCase();
    return (
      normalized === "::1" ||
      normalized === "::" ||
      normalized.startsWith("fc") ||
      normalized.startsWith("fd") ||
      normalized.startsWith("fe8") ||
      normalized.startsWith("fe9") ||
      normalized.startsWith("fea") ||
      normalized.startsWith("feb") ||
      normalized.startsWith("::ffff:127.") ||
      normalized.startsWith("::ffff:10.") ||
      normalized.startsWith("::ffff:192.168.")
    );
  }
  return true;
}

export async function assertPublicUrl(
  raw: string,
  lookupHost: (host: string) => Promise<string[]>,
): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new HarnessError(`invalid url: ${raw}`, { code: "bad_request" });
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new HarnessError(`unsupported url scheme: ${url.protocol}`, { code: "bad_request" });
  }
  const host = url.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) {
    throw new HarnessError(`blocked host: ${host}`, { code: "bad_request" });
  }
  const addresses = isIP(host) === 0 ? await lookupHost(host) : [host];
  if (addresses.length === 0) throw new HarnessError(`cannot resolve host: ${host}`, { code: "bad_request" });
  for (const address of addresses) {
    if (isBlockedAddress(address)) {
      throw new HarnessError(`blocked address for ${host}: ${address}`, { code: "bad_request" });
    }
  }
  return url;
}

async function readCapped(response: Response): Promise<string> {
  const declared = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > MAX_BYTES) {
    throw new HarnessError(`response too large: ${declared} bytes`, { code: "bad_request" });
  }
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BYTES) {
      await reader.cancel();
      throw new HarnessError(`response exceeded ${MAX_BYTES} bytes`, { code: "bad_request" });
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))));
}

export const webfetchTool: ToolDefinition<WebFetchInput> = {
  name: "webfetch",
  description: "Fetch a public http(s) URL and return its text content.",
  readOnly: true,
  parameters: {
    type: "object",
    properties: {
      url: { type: "string", description: "Public http or https URL." },
    },
    required: ["url"],
  },
  parse(input) {
    const record = asObject(input);
    return { url: requireString(record, "url") };
  },
  resources(input) {
    return [input.url];
  },
  async execute(input, context) {
    const fetchImpl = context.fetchImpl ?? fetch;
    const lookupHost =
      context.lookupHost ?? (async (host: string) => (await lookup(host, { all: true })).map((entry) => entry.address));

    let url = await assertPublicUrl(input.url, lookupHost);
    const signal = AbortSignal.any([context.signal, AbortSignal.timeout(TIMEOUT_MS)]);

    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const response = await fetchImpl(url, { signal, redirect: "manual" });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (location === null) {
          return { output: `redirect without location from ${url.toString()}`, isError: true, truncated: false };
        }
        url = await assertPublicUrl(new URL(location, url).toString(), lookupHost);
        continue;
      }
      if (!response.ok) {
        return { output: `http ${response.status} from ${url.toString()}`, isError: true, truncated: false };
      }
      const contentType = response.headers.get("content-type") ?? "";
      if (
        !contentType.startsWith("text/") &&
        !contentType.includes("json") &&
        !contentType.includes("xml") &&
        contentType !== ""
      ) {
        return { output: `unsupported content type: ${contentType}`, isError: true, truncated: false };
      }
      const text = await readCapped(response);
      const result = truncateText(text, context.maxOutputChars);
      return { output: result.text === "" ? "(empty response)" : result.text, isError: false, truncated: result.truncated };
    }
    return { output: `too many redirects: ${input.url}`, isError: true, truncated: false };
  },
};
