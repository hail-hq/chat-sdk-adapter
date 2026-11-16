import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Chat, NotImplementedError, type StreamChunk } from "chat";
import { createMemoryState } from "@chat-adapter/state-memory";
import { createHailAdapter, HailApiError } from "../src/index.js";
const from = "+14155550100",
  peer = "+14155550200",
  secret = "whsec_test";
const threadId = "hail:+14155550100:+14155550200",
  id = "fd658fd6-50ea-4248-acb1-3023bd51da0c";
const sms = {
  id,
  organization_id: "org-test",
  from_e164: from,
  to_e164: peer,
  direction: "outbound",
  agent_id: null,
  status: "sent",
  body: "Hello",
  provider_message_sid: "SM-test",
  segment_count: 1,
  error_code: null,
  requested_at: "2026-11-10T12:00:00Z",
  sent_at: "2026-11-10T12:00:01Z",
};
const event = {
  id: "delivery-test",
  type: "sms.received",
  api_version: "2026-06-06",
  organization_id: "org-test",
  created_at: "2026-11-10T12:00:00Z",
  data: { id, from: peer, to: from, body: "*literal*\nHello" },
};
function signed(
  body = JSON.stringify(event),
  timestamp = Math.floor(Date.now() / 1000),
  key = secret,
) {
  const mac = createHmac("sha256", key)
    .update(`${timestamp}.`)
    .update(body)
    .digest("hex");
  return new Request("https://bot.example/api/webhooks/hail", {
    method: "POST",
    body,
    headers: { "x-hail-signature": `t=${timestamp},v1=${mac}` },
  });
}
function adapter(options: Record<string, unknown> = {}) {
  return createHailAdapter({
    apiKey: "test-key",
    fromNumber: from,
    webhookSecret: secret,
    recipientConsent: true,
    ...options,
  });
}
const bots: Chat[] = [];
afterEach(async () => {
  await Promise.all(bots.splice(0).map((bot) => bot.shutdown()));
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("webhooks", () => {
  it.each([
    [
      "missing",
      () =>
        new Request("https://bot.example", {
          method: "POST",
          body: JSON.stringify(event),
        }),
    ],
    ["wrong secret", () => signed(undefined, undefined, "wrong")],
    ["stale", () => signed(undefined, Math.floor(Date.now() / 1000) - 301)],
    ["future", () => signed(undefined, Math.floor(Date.now() / 1000) + 301)],
    [
      "short digest",
      () =>
        new Request("https://bot.example", {
          method: "POST",
          body: "{}",
          headers: { "x-hail-signature": "t=1,v1=00" },
        }),
    ],
    [
      "changed body",
      () =>
        new Request(signed(), {
          body: JSON.stringify({
            ...event,
            data: { ...event.data, body: "tampered" },
          }),
        }),
    ],
  ] as const)(
    "rejects %s signatures before processing",
    async (_label, request) => {
      expect((await adapter().handleWebhook(request())).status).toBe(401);
    },
  );
  it("fails closed without a secret", async () => {
    vi.stubEnv("HAIL_WEBHOOK_SECRET", "");
    expect(
      (await adapter({ webhookSecret: undefined }).handleWebhook(signed()))
        .status,
    ).toBe(503);
  });
  it("rejects signed malformed payloads", async () => {
    expect((await adapter().handleWebhook(signed("{"))).status).toBe(400);
    expect(
      (
        await adapter().handleWebhook(
          signed(
            JSON.stringify({ ...event, data: { ...event.data, to: "bad" } }),
          ),
        )
      ).status,
    ).toBe(400);
  });
  it("acknowledges and skips senders or bodies it cannot map", async () => {
    for (const data of [
      { ...event.data, from: "AMAZON" },
      { ...event.data, body: null },
    ]) {
      expect(
        (
          await adapter().handleWebhook(
            signed(JSON.stringify({ ...event, data })),
          )
        ).status,
      ).toBe(200);
    }
  });
  it("ignores other events and other Hail numbers", async () => {
    expect(
      (
        await adapter().handleWebhook(
          signed(JSON.stringify({ ...event, type: "sms.delivered" })),
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await adapter().handleWebhook(
          signed(
            JSON.stringify({
              ...event,
              data: { ...event.data, to: "+14155550300" },
            }),
          ),
        )
      ).status,
    ).toBe(200);
  });
  it("accepts the Python signer fixture in Hail docs", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1700000000000);
    const request = new Request("https://bot.example", {
      method: "POST",
      body: '{"id":"evt_123","type":"email.received","data":{"id":"em_1"}}',
      headers: {
        "x-hail-signature":
          "t=1700000000,v1=72f7940d13ca8528cf655a04e82dabfe90a531e239241fda9bdff72980d33a4a",
      },
    });
    expect(
      (await adapter({ webhookSecret: "whsec_example" }).handleWebhook(request))
        .status,
    ).toBe(200);
  });
  it("routes literal SMS through real Chat, replies, stores history, and deduplicates retries", async () => {
    const sent: unknown[] = [];
    const hail = adapter({
      fetch: async (url: URL, init: RequestInit) => {
        sent.push({ url: String(url), body: JSON.parse(String(init.body)) });
        return Response.json(sms);
      },
    });
    const bot = new Chat({
      userName: "test",
      adapters: { hail },
      state: createMemoryState(),
    });
    bots.push(bot);
    const received: string[] = [];
    bot.onDirectMessage(async (thread, message) => {
      received.push(message.text);
      expect(message.threadId).toBe(threadId);
      expect(message.author.userId).toBe(peer);
      expect(message.metadata.dateSent.toISOString()).toBe(
        "2026-11-10T12:00:00.000Z",
      );
      await thread.post("Hello");
    });
    expect((await bot.webhooks.hail(signed())).status).toBe(200);
    expect((await bot.webhooks.hail(signed())).status).toBe(200);
    expect(received).toEqual(["*literal*\nHello"]);
    expect(sent).toEqual([
      {
        url: "https://api.hail.so/v1/sms",
        body: {
          from,
          to: peer,
          body: "Hello",
          recipient_consent: true,
          message_type: "informational",
        },
      },
    ]);
    const history: string[] = [];
    for await (const message of bot.thread(threadId).messages)
      history.push(message.text);
    expect(history).toContain("*literal*\nHello");
    expect(history).toContain("Hello");
  });
});
describe("background processing", () => {
  it("acknowledges a signed webhook before a slow handler finishes when waitUntil is supplied", async () => {
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const bot = new Chat({
      userName: "test",
      adapters: { hail: adapter() },
      state: createMemoryState(),
    });
    bots.push(bot);
    bot.onDirectMessage(async () => {
      entered();
      await gate;
    });
    const tasks: Promise<unknown>[] = [];
    const response = bot.webhooks.hail(signed(), {
      waitUntil: (task) => {
        tasks.push(task);
      },
    });
    await started;
    try {
      const status = await Promise.race([
        response.then((result) => result.status),
        new Promise<string>((resolve) =>
          setTimeout(() => resolve("blocked"), 100),
        ),
      ]);
      expect(status).toBe(200);
    } finally {
      release();
      await response;
      await Promise.all(tasks);
    }
  });
  it("waits for a handler when no background runtime is supplied", async () => {
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const bot = new Chat({
      userName: "test",
      adapters: { hail: adapter() },
      state: createMemoryState(),
    });
    bots.push(bot);
    bot.onDirectMessage(async () => {
      entered();
      await gate;
    });
    let acknowledged = false;
    const response = bot.webhooks.hail(signed()).then((result) => {
      acknowledged = true;
      return result;
    });
    await started;
    try {
      expect(acknowledged).toBe(false);
    } finally {
      release();
    }
    expect((await response).status).toBe(200);
  });
});

describe("documented setup", () => {
  function burstEvent(n: number) {
    return JSON.stringify({
      ...event,
      data: {
        ...event.data,
        id: `fd658fd6-50ea-4248-acb1-3023bd51da0${n}`,
        body: `text ${n}`,
      },
    });
  }
  it("handles texts sent in a row with the queue strategy", async () => {
    const bot = new Chat({
      userName: "test",
      adapters: { hail: adapter() },
      state: createMemoryState(),
      concurrency: "queue",
      logger: "silent",
    });
    bots.push(bot);
    const runs: { message: string; skipped: string[] }[] = [];
    bot.onDirectMessage(async (_thread, message, _channel, context) => {
      await new Promise((resolve) => setTimeout(resolve, 200));
      runs.push({
        message: message.text,
        skipped: (context?.skipped ?? []).map((m) => m.text),
      });
    });
    const tasks: Promise<unknown>[] = [];
    const options = { waitUntil: (task: Promise<unknown>) => tasks.push(task) };
    for (const n of [1, 2, 3]) {
      expect(
        (await bot.webhooks.hail(signed(burstEvent(n)), options)).status,
      ).toBe(200);
    }
    await Promise.all(tasks);
    expect(runs).toEqual([
      { message: "text 1", skipped: [] },
      { message: "text 3", skipped: ["text 2"] },
    ]);
  });
  it("loses a text sent during a reply with the default drop strategy", async () => {
    const bot = new Chat({
      userName: "test",
      adapters: { hail: adapter() },
      state: createMemoryState(),
      logger: "silent",
    });
    bots.push(bot);
    const handled: string[] = [];
    bot.onDirectMessage(async (_thread, message) => {
      await new Promise((resolve) => setTimeout(resolve, 200));
      handled.push(message.text);
    });
    const tasks: Promise<unknown>[] = [];
    const options = { waitUntil: (task: Promise<unknown>) => tasks.push(task) };
    for (const n of [1, 2]) {
      expect(
        (await bot.webhooks.hail(signed(burstEvent(n)), options)).status,
      ).toBe(200);
    }
    await Promise.allSettled(tasks);
    expect(handled).toEqual(["text 1"]);
  });
  it("starts a conversation through the adapter's openDM", async () => {
    const bodies: unknown[] = [];
    const hail = adapter({
      fetch: async (_url: URL, init: RequestInit) => {
        bodies.push(JSON.parse(String(init.body)));
        return Response.json(sms);
      },
    });
    const bot = new Chat({
      userName: "test",
      adapters: { hail },
      state: createMemoryState(),
    });
    bots.push(bot);
    await expect(bot.openDM(peer)).rejects.toThrow("Cannot infer adapter");
    await bot.initialize();
    const thread = bot.thread(await hail.openDM(peer));
    await thread.post("Hello");
    await bot.shutdown();
    expect(bodies).toEqual([
      {
        from,
        to: peer,
        body: "Hello",
        recipient_consent: true,
        message_type: "informational",
      },
    ]);
  });
});
describe("outbound", () => {
  it("resolves credentials per request and refuses redirects", async () => {
    let token = "first";
    const requests: RequestInit[] = [];
    const hail = adapter({
      apiKey: () => token,
      fetch: async (_url: URL, init: RequestInit) => {
        requests.push(init);
        return Response.json(sms);
      },
    });
    expect((await hail.postMessage(threadId, "Hello")).id).toBe(id);
    token = "second";
    await hail.postMessage(threadId, "Hello");
    expect(
      requests.map((init) => new Headers(init.headers).get("authorization")),
    ).toEqual(["Bearer first", "Bearer second"]);
    expect(requests.map((init) => init.redirect)).toEqual(["error", "error"]);
  });
  it("resolves the signing secret for each delivery", async () => {
    let key = secret;
    const hail = adapter({ webhookSecret: () => key });
    const body = JSON.stringify({ ...event, type: "sms.delivered" });
    expect((await hail.handleWebhook(signed(body))).status).toBe(200);
    key = "rotated";
    expect((await hail.handleWebhook(signed(body))).status).toBe(401);
    expect(
      (await hail.handleWebhook(signed(body, undefined, key))).status,
    ).toBe(200);
  });
  it("requires explicit consent before API calls", async () => {
    vi.stubEnv("HAIL_RECIPIENT_CONSENT", "");
    const fetch = vi.fn();
    await expect(
      adapter({ recipientConsent: undefined, fetch }).postMessage(
        threadId,
        "Hello",
      ),
    ).rejects.toThrow(/consent/i);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("checks consent per recipient", async () => {
    const fetch = vi.fn(async () => Response.json(sms));
    const hail = adapter({
      recipientConsent: async (to: string) => to === peer,
      fetch,
    });
    await hail.postMessage(threadId, "Hello");
    await expect(
      hail.postMessage(`hail:${from}:+14155550300`, "Hello"),
    ).rejects.toThrow(/consent/i);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("rejects attachments, empty text and overlength text before sending", async () => {
    const fetch = vi.fn();
    const hail = adapter({ fetch });
    await expect(
      hail.postMessage(threadId, {
        markdown: "Hello",
        files: [{ data: Buffer.from("image"), filename: "x.png" }],
      }),
    ).rejects.toThrow(/attach|file/i);
    await expect(hail.postMessage(threadId, "x".repeat(1601))).rejects.toThrow(
      /1600/,
    );
    await expect(hail.postMessage(threadId, "")).rejects.toThrow(/empty/);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("does not retry 429 or expose API error bodies, and passes Retry-After", async () => {
    const fetch = vi.fn(
      async () =>
        new Response("secret provider details", {
          status: 429,
          headers: { "Retry-After": "7" },
        }),
    );
    const error = await adapter({ fetch })
      .postMessage(threadId, "Hello")
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HailApiError);
    expect(error).toMatchObject({
      message: "Hail API request failed (429)",
      status: 429,
      retryAfterMs: 7000,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("reads Retry-After as an HTTP date, and leaves it out when missing", async () => {
    const date = new Date(Date.now() + 60_000).toUTCString();
    const dated = (await adapter({
      fetch: async () =>
        new Response(null, { status: 429, headers: { "Retry-After": date } }),
    })
      .postMessage(threadId, "Hello")
      .catch((e: unknown) => e)) as HailApiError;
    expect(dated.retryAfterMs).toBeGreaterThan(55_000);
    expect(dated.retryAfterMs).toBeLessThanOrEqual(60_000);
    const missing = (await adapter({
      fetch: async () => new Response(null, { status: 403 }),
    })
      .postMessage(threadId, "Hello")
      .catch((e: unknown) => e)) as HailApiError;
    expect(missing).toMatchObject({ status: 403, retryAfterMs: undefined });
    for (const [header, expected] of [
      ["7.5", 7500],
      ["soon", undefined],
      ["-1", undefined],
    ] as const) {
      const error = (await adapter({
        fetch: async () =>
          new Response(null, {
            status: 429,
            headers: { "Retry-After": header },
          }),
      })
        .postMessage(threadId, "Hello")
        .catch((e: unknown) => e)) as HailApiError;
      expect(error.retryAfterMs).toBe(expected);
    }
  });
  it("uses the versioned self-host API and requires an API key", async () => {
    const urls: string[] = [];
    await adapter({
      apiUrl: "http://localhost:8080/",
      fetch: async (url: URL) => {
        urls.push(String(url));
        return Response.json(sms);
      },
    }).postMessage(threadId, "Hello");
    expect(urls).toEqual(["http://localhost:8080/v1/sms"]);
    vi.stubEnv("HAIL_API_KEY", "");
    await expect(
      adapter({ apiKey: undefined }).postMessage(threadId, "Hello"),
    ).rejects.toThrow(/API key/i);
  });
});
describe("send retries", () => {
  function sends(...results: (number | Error)[]) {
    const keys: (string | null)[] = [];
    const fetch = vi.fn(async (_url: URL, init: RequestInit) => {
      keys.push(new Headers(init.headers).get("idempotency-key"));
      const result = results.shift();
      if (result instanceof Error) throw result;
      if (result === undefined || result < 300) return Response.json(sms);
      return new Response("busy", { status: result });
    });
    return { hail: adapter({ fetch }), fetch, keys };
  }
  async function settle<T>(promise: Promise<T>) {
    const outcome = promise.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    await vi.runAllTimersAsync();
    return await outcome;
  }
  afterEach(() => {
    vi.useRealTimers();
  });
  it("sends one idempotency key per message", async () => {
    const { hail, keys } = sends(201, 201);
    await hail.postMessage(threadId, "Hello");
    await hail.postMessage(threadId, "Hello");
    expect(keys[0]).toMatch(/^[0-9a-f-]{36}$/);
    expect(keys[1]).toMatch(/^[0-9a-f-]{36}$/);
    expect(keys[0]).not.toBe(keys[1]);
  });
  it("retries a timeout, network error, 409 or 5xx with the same key", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const timeout = new DOMException("timed out", "TimeoutError");
    for (const first of [timeout, new TypeError("fetch failed"), 409, 502]) {
      const { hail, fetch, keys } = sends(first, 201);
      const { value } = (await settle(hail.postMessage(threadId, "Hello"))) as {
        value: { id: string };
      };
      expect(value.id).toBe(id);
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(keys[1]).toBe(keys[0]);
    }
  });
  it("gives up after 3 attempts and throws the last error", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const { hail, fetch } = sends(503, 503, 503, 201);
    const { error } = (await settle(hail.postMessage(threadId, "Hello"))) as {
      error: HailApiError;
    };
    expect(error).toMatchObject({ name: "HailApiError", status: 503 });
    expect(fetch).toHaveBeenCalledTimes(3);
    const network = sends(
      new TypeError("fetch failed"),
      new TypeError("fetch failed"),
      new TypeError("fetch failed"),
    );
    const failed = (await settle(
      network.hail.postMessage(threadId, "Hello"),
    )) as { error: Error };
    expect(failed.error.message).toBe("fetch failed");
    expect(network.fetch).toHaveBeenCalledTimes(3);
  });
  it("does not retry a replayed result, a long Retry-After, a redirect or a custom error", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const cases: [() => Promise<Response>, number | string][] = [
      [
        async () =>
          new Response(null, {
            status: 502,
            headers: { "Idempotency-Replay": "true" },
          }),
        502,
      ],
      [
        async () =>
          new Response(null, { status: 503, headers: { "Retry-After": "30" } }),
        503,
      ],
      [
        async () => {
          throw new TypeError("fetch failed", {
            cause: new Error("unexpected redirect"),
          });
        },
        "fetch failed",
      ],
      [
        async () => {
          throw new Error("bad custom fetch");
        },
        "bad custom fetch",
      ],
    ];
    for (const [respond, expected] of cases) {
      const fetch = vi.fn(respond);
      const { error } = (await settle(
        adapter({ fetch }).postMessage(threadId, "Hello"),
      )) as { error: HailApiError };
      if (typeof expected === "number") expect(error.status).toBe(expected);
      else expect(error.message).toBe(expected);
      expect(fetch).toHaveBeenCalledTimes(1);
    }
  });
  it("waits for a short Retry-After before retrying", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
    const times: number[] = [];
    let calls = 0;
    const fetch = vi.fn(async () => {
      times.push(Date.now());
      return calls++ === 0
        ? new Response(null, { status: 503, headers: { "Retry-After": "7" } })
        : Response.json(sms);
    });
    await settle(adapter({ fetch }).postMessage(threadId, "Hello"));
    expect(fetch).toHaveBeenCalledTimes(2);
    expect((times[1] as number) - (times[0] as number)).toBeGreaterThanOrEqual(
      7000,
    );
  });
  it("throws the first failure when Hail still reports the send in progress", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const timeout = new DOMException("timed out", "TimeoutError");
    const { hail } = sends(timeout, 409, 409);
    const { error } = (await settle(hail.postMessage(threadId, "Hello"))) as {
      error: Error;
    };
    expect(error).toBe(timeout);
  });
  it("does not retry other client errors", async () => {
    for (const status of [400, 401, 402, 403, 422]) {
      const { hail, fetch } = sends(status, 201);
      await expect(hail.postMessage(threadId, "Hello")).rejects.toMatchObject({
        status,
      });
      expect(fetch).toHaveBeenCalledTimes(1);
    }
  });
  it("does not retry reads or send a key with them", async () => {
    const { hail, fetch, keys } = sends(500, 201);
    await expect(hail.fetchMessage(threadId, id)).rejects.toMatchObject({
      status: 500,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(keys).toEqual([null]);
  });
});

describe("streaming", () => {
  async function* chunks<T>(...values: T[]) {
    for (const value of values) yield value;
  }
  function recording() {
    const bodies: string[] = [];
    const hail = adapter({
      fetch: async (_url: URL, init: RequestInit) => {
        const body = JSON.parse(String(init.body)).body as string;
        bodies.push(body);
        return Response.json({ ...sms, body });
      },
    });
    return { hail, bodies };
  }
  it("sends a streamed reply as one SMS, without a placeholder", async () => {
    const { hail, bodies } = recording();
    const bot = new Chat({
      userName: "test",
      adapters: { hail },
      state: createMemoryState(),
    });
    bots.push(bot);
    bot.onDirectMessage(async (thread) => {
      await thread.post(chunks("Hel", "lo ", "world"));
    });
    expect((await bot.webhooks.hail(signed())).status).toBe(200);
    expect(bodies).toEqual(["Hello world"]);
    const history: string[] = [];
    for await (const message of bot.thread(threadId).messages)
      history.push(message.text);
    expect(history).toContain("Hello world");
  });
  it("keeps only text chunks", async () => {
    const { hail, bodies } = recording();
    const raw = await hail.stream(
      threadId,
      chunks<string | StreamChunk>(
        "A",
        { type: "markdown_text" as const, text: "B" },
        { type: "plan_update" as const, title: "ignored" },
        "C",
      ),
    );
    expect(raw.id).toBe(id);
    expect(bodies).toEqual(["ABC"]);
  });
  it("applies SMS limits to the whole streamed reply before sending", async () => {
    const { hail, bodies } = recording();
    await expect(hail.stream(threadId, chunks("", " "))).rejects.toThrow(
      "SMS text cannot be empty",
    );
    await expect(
      hail.stream(threadId, chunks("a".repeat(1000), "a".repeat(601))),
    ).rejects.toThrow("at most 1600");
    expect(bodies).toEqual([]);
  });
  it("sends nothing when the stream is aborted", async () => {
    const { hail, bodies } = recording();
    const controller = new AbortController();
    async function* aborted() {
      yield "partial";
      controller.abort();
      yield "more";
    }
    await expect(
      hail.stream(threadId, aborted(), { signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(bodies).toEqual([]);
  });
  it("sends nothing when the stream ends because the turn was aborted", async () => {
    const { hail, bodies } = recording();
    const controller = new AbortController();
    async function* endsOnAbort() {
      yield "partial";
      controller.abort();
    }
    await expect(
      hail.stream(threadId, endsOnAbort(), { signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(bodies).toEqual([]);
  });
  it("sends nothing when the turn is aborted while the API key resolves", async () => {
    const controller = new AbortController();
    const bodies: unknown[] = [];
    const hail = adapter({
      apiKey: async () => {
        controller.abort();
        return "test-key";
      },
      fetch: async (_url: URL, init: RequestInit) => {
        bodies.push(init.body);
        return Response.json(sms);
      },
    });
    await expect(
      hail.stream(threadId, chunks("Hello"), { signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(bodies).toEqual([]);
  });
  it("sends nothing when the turn is aborted while consent is checked", async () => {
    const controller = new AbortController();
    const bodies: unknown[] = [];
    const hail = adapter({
      recipientConsent: async () => {
        controller.abort();
        return true;
      },
      fetch: async (_url: URL, init: RequestInit) => {
        bodies.push(init.body);
        return Response.json(sms);
      },
    });
    await expect(
      hail.stream(threadId, chunks("Hello"), { signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(bodies).toEqual([]);
  });
  it("counts an emoji split across chunks once", async () => {
    const { hail, bodies } = recording();
    const emoji = "😀";
    await hail.stream(
      threadId,
      chunks("a".repeat(1599), emoji[0] as string, emoji[1] as string),
    );
    expect(bodies).toEqual(["a".repeat(1599) + emoji]);
  });
  it("stops reading a stream as soon as the reply is too long", async () => {
    const { hail, bodies } = recording();
    let pulled = 0;
    async function* endless() {
      while (true) {
        pulled++;
        yield "a".repeat(500);
      }
    }
    await expect(hail.stream(threadId, endless())).rejects.toThrow(
      "at most 1600",
    );
    expect(pulled).toBe(4);
    expect(bodies).toEqual([]);
  });
});
describe("scaffold environment", () => {
  it("uses the default API origin when the generated optional variable is empty", async () => {
    vi.stubEnv("HAIL_API_URL", "");
    const urls: string[] = [];
    await adapter({
      fetch: async (url: URL) => {
        urls.push(String(url));
        return Response.json(sms);
      },
    }).postMessage(threadId, "Hello");
    expect(urls).toEqual(["https://api.hail.so/v1/sms"]);
  });
});

describe("isolation", () => {
  it("validates IDs and prevents sending from other numbers", async () => {
    const hail = adapter();
    expect(hail.encodeThreadId({ fromNumber: from, peerNumber: peer })).toBe(
      threadId,
    );
    expect(hail.decodeThreadId(threadId)).toEqual({
      fromNumber: from,
      peerNumber: peer,
    });
    expect(hail.channelIdFromThreadId(threadId)).toBe(threadId);
    await expect(hail.openDM(peer)).resolves.toBe(threadId);
    for (const invalid of [
      `hail:${from}:bad`,
      `other:${from}:${peer}`,
      `hail:+14155550300:${peer}`,
      `${threadId}:extra`,
      `hail:${from}:${peer}\n`,
    ])
      expect(() => hail.decodeThreadId(invalid)).toThrow();
  });
  it("checks the exact phone pair on single-message reads", async () => {
    await expect(
      adapter({
        fetch: async () => Response.json({ ...sms, to_e164: "+14155550300" }),
      }).fetchMessage(threadId, id),
    ).resolves.toBeNull();
  });
  it("returns null only for 404 and propagates auth errors", async () => {
    await expect(
      adapter({
        fetch: async () => new Response(null, { status: 404 }),
      }).fetchMessage(threadId, id),
    ).resolves.toBeNull();
    await expect(
      adapter({
        fetch: async () => new Response(null, { status: 401 }),
      }).fetchMessage(threadId, id),
    ).rejects.toThrow(/401/);
  });
  it("reports unsupported operations", async () => {
    const hail = adapter();
    for (const method of [
      "editMessage",
      "deleteMessage",
      "addReaction",
      "removeReaction",
    ] as const)
      await expect(hail[method]()).rejects.toBeInstanceOf(NotImplementedError);
  });
});
