import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import {
  Message,
  NotImplementedError,
  stringifyMarkdown,
  type Adapter,
  type AdapterPostableMessage,
  type ChatInstance,
  type FetchOptions,
  type FetchResult,
  type FormattedContent,
  type RawMessage,
  type StreamChunk,
  type StreamOptions,
  type ThreadInfo,
  type WebhookOptions,
} from "chat";
import type {
  HailAdapterConfig,
  HailCredential,
  HailSms,
  HailThreadId,
} from "./types.js";
export type {
  HailAdapterConfig,
  HailCredential,
  HailSms,
  HailThreadId,
} from "./types.js";

const SMS_MAX = 1600;
const TOO_LONG = "SMS text must be at most 1600 characters";
const PHONE = /^\+[1-9][0-9]{6,14}$/;
const SIGNATURE = /^t=([0-9]+),v1=([a-fA-F0-9]{64})$/;
const UUID =
  /^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$/;
function phone(value: unknown): value is string {
  return typeof value === "string" && PHONE.exec(value)?.[0] === value;
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isSms(value: unknown): value is HailSms {
  return (
    record(value) &&
    typeof value.id === "string" &&
    UUID.test(value.id) &&
    phone(value.from_e164) &&
    phone(value.to_e164) &&
    (value.direction === "inbound" || value.direction === "outbound") &&
    typeof value.body === "string" &&
    typeof value.requested_at === "string" &&
    Number.isFinite(Date.parse(value.requested_at))
  );
}
async function credential(
  value: HailCredential | undefined,
): Promise<string | undefined> {
  return typeof value === "function" ? await value() : value;
}

export class HailApiError extends Error {
  constructor(
    readonly status: number,
    /** Wait from Hail's Retry-After header, for example on 429. */
    readonly retryAfterMs?: number,
  ) {
    super(`Hail API request failed (${status})`);
    this.name = "HailApiError";
  }
}
function retryAfterMs(header: string | null): number | undefined {
  if (header === null) return undefined;
  if (/^[0-9]+$/.test(header.trim())) return Number(header) * 1000;
  const date = Date.parse(header);
  return Number.isFinite(date) ? Math.max(date - Date.now(), 0) : undefined;
}
// Waits before each send retry. Hail stores the result for each idempotency
// key, so a retry returns the first send instead of sending again.
const SEND_RETRY_DELAYS_MS = [1_000, 4_000];
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** SMS adapter. All conversations are scoped to the configured number and one peer. */
export class HailAdapter implements Adapter<HailThreadId, HailSms> {
  readonly name = "hail";
  readonly lockScope = "thread" as const;
  readonly persistThreadHistory = true;
  readonly userName: string;
  private chat?: ChatInstance;
  private readonly config: HailAdapterConfig;

  constructor(config: HailAdapterConfig = {}) {
    this.config = { ...config };
    this.userName = config.userName ?? "hail-bot";
  }

  private fromNumber(): string {
    const number = this.config.fromNumber ?? process.env.HAIL_FROM_NUMBER;
    if (!phone(number))
      throw new Error(
        "Set HAIL_FROM_NUMBER or fromNumber to a Hail-owned E.164 number",
      );
    return number;
  }

  async initialize(chat: ChatInstance): Promise<void> {
    this.fromNumber();
    this.chat = chat;
  }

  encodeThreadId(thread: HailThreadId): string {
    if (thread.fromNumber !== this.fromNumber() || !phone(thread.peerNumber)) {
      throw new Error("Invalid Hail phone pair");
    }
    return `hail:${thread.fromNumber}:${thread.peerNumber}`;
  }

  decodeThreadId(threadId: string): HailThreadId {
    const [name, fromNumber, peerNumber, extra] = threadId.split(":");
    if (
      name !== this.name ||
      extra !== undefined ||
      fromNumber !== this.fromNumber() ||
      !phone(peerNumber)
    ) {
      throw new Error("Invalid Hail thread ID");
    }
    return { fromNumber, peerNumber };
  }

  channelIdFromThreadId(threadId: string): string {
    this.decodeThreadId(threadId);
    return threadId;
  }

  isDM(threadId: string): boolean {
    this.decodeThreadId(threadId);
    return true;
  }

  async openDM(peerNumber: string): Promise<string> {
    return this.encodeThreadId({ fromNumber: this.fromNumber(), peerNumber });
  }

  async fetchThread(threadId: string): Promise<ThreadInfo> {
    const thread = this.decodeThreadId(threadId);
    return {
      id: threadId,
      channelId: threadId,
      channelName: thread.peerNumber,
      channelVisibility: "private",
      isDM: true,
      metadata: { ...thread },
    };
  }

  async handleWebhook(
    request: Request,
    options?: WebhookOptions,
  ): Promise<Response> {
    if (request.method !== "POST")
      return new Response(null, { status: 405, headers: { Allow: "POST" } });
    const secret = await credential(
      this.config.webhookSecret ?? process.env.HAIL_WEBHOOK_SECRET,
    );
    if (!secret)
      return new Response("Webhook secret is not configured", { status: 503 });
    const body = new Uint8Array(await request.arrayBuffer());
    const match = SIGNATURE.exec(request.headers.get("x-hail-signature") ?? "");
    if (
      !match ||
      !Number.isSafeInteger(Number(match[1])) ||
      Math.abs(Date.now() / 1000 - Number(match[1])) > 300
    ) {
      return new Response("Invalid signature", { status: 401 });
    }
    const expected = createHmac("sha256", secret)
      .update(`${match[1]}.`)
      .update(body)
      .digest();
    if (!timingSafeEqual(expected, Buffer.from(match[2], "hex")))
      return new Response("Invalid signature", { status: 401 });
    let event: unknown;
    try {
      event = JSON.parse(new TextDecoder().decode(body));
    } catch {
      return new Response("Invalid JSON", { status: 400 });
    }
    if (!record(event) || typeof event.type !== "string")
      return new Response("Invalid event", { status: 400 });
    if (event.type !== "sms.received")
      return new Response(null, { status: 200 });
    const data = event.data;
    if (
      !record(data) ||
      typeof data.id !== "string" ||
      !UUID.test(data.id) ||
      !phone(data.to) ||
      typeof event.created_at !== "string" ||
      !Number.isFinite(Date.parse(event.created_at))
    ) {
      return new Response("Invalid SMS event", { status: 400 });
    }
    // Short codes, alphanumeric senders and MMS-only texts are valid events the adapter skips.
    if (!phone(data.from) || typeof data.body !== "string")
      return new Response(null, { status: 200 });
    if (data.to !== this.fromNumber())
      return new Response(null, { status: 200 });
    if (!this.chat)
      return new Response("Adapter is not initialized", { status: 503 });
    const message = this.parseMessage({
      id: data.id,
      from_e164: data.from,
      to_e164: data.to,
      direction: "inbound",
      body: data.body,
      requested_at: event.created_at,
      status: "received",
    });
    const task = this.chat.processMessage(
      this,
      message.threadId,
      message,
      options,
    );
    // Chat registers the task with waitUntil; the webhook must not await it too.
    if (!options?.waitUntil) await task;
    return new Response(null, { status: 200 });
  }

  parseMessage(raw: HailSms): Message<HailSms> {
    if (!isSms(raw)) throw new Error("Invalid Hail SMS response");
    const inbound = raw.direction === "inbound";
    const threadId = this.encodeThreadId({
      fromNumber: inbound ? raw.to_e164 : raw.from_e164,
      peerNumber: inbound ? raw.from_e164 : raw.to_e164,
    });
    return new Message({
      id: raw.id,
      threadId,
      text: raw.body,
      // SMS is literal text. Do not interpret Markdown typed by the sender.
      formatted: {
        type: "root",
        children: [
          { type: "paragraph", children: [{ type: "text", value: raw.body }] },
        ],
      },
      raw,
      attachments: [],
      isMention: inbound,
      author: {
        userId: raw.from_e164,
        userName: inbound ? raw.from_e164 : this.userName,
        fullName: inbound ? raw.from_e164 : this.userName,
        isBot: !inbound,
        isMe: !inbound,
      },
      metadata: { dateSent: new Date(raw.requested_at), edited: false },
    });
  }

  renderFormatted(content: FormattedContent): string {
    return stringifyMarkdown(content).trim();
  }

  private text(message: AdapterPostableMessage): string {
    if (typeof message === "string") return message;
    if (
      ("files" in message && message.files?.length) ||
      ("attachments" in message &&
        Array.isArray(message.attachments) &&
        message.attachments.length)
    ) {
      throw new Error("Hail SMS does not support files or attachments");
    }
    if ("markdown" in message) return message.markdown;
    if ("raw" in message) return message.raw;
    if ("ast" in message) return this.renderFormatted(message.ast);
    throw new NotImplementedError(
      "Hail SMS supports text messages",
      "postMessage",
    );
  }

  private async api(
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const apiKey = await credential(
      this.config.apiKey ?? process.env.HAIL_API_KEY,
    );
    // Last chance to cancel before a chargeable request is made.
    signal?.throwIfAborted();
    if (!apiKey)
      throw new Error("An API key is required: set HAIL_API_KEY or apiKey");
    const origin = new URL(
      this.config.apiUrl ?? (process.env.HAIL_API_URL || "https://api.hail.so"),
    );
    if (
      !["https:", "http:"].includes(origin.protocol) ||
      origin.username ||
      origin.password ||
      origin.search ||
      origin.hash ||
      origin.pathname !== "/"
    ) {
      throw new Error(
        "apiUrl must be an HTTP(S) origin without a path, credentials, query, or fragment",
      );
    }
    // Only sends (POST) carry a key and retry. Reads fail on the first error.
    const idempotencyKey = body === undefined ? undefined : randomUUID();
    const retries = idempotencyKey ? SEND_RETRY_DELAYS_MS : [];
    // The caller's signal is not checked again: once a send may have reached
    // Hail, retries only find out what happened to it.
    for (let attempt = 0; ; attempt++) {
      let response: Response;
      try {
        response = await (this.config.fetch ?? globalThis.fetch)(
          new URL(path, origin),
          {
            method: body === undefined ? "GET" : "POST",
            redirect: "error",
            signal: AbortSignal.timeout(30_000),
            headers: {
              Authorization: `Bearer ${apiKey}`,
              ...(idempotencyKey
                ? {
                    "Content-Type": "application/json",
                    "Idempotency-Key": idempotencyKey,
                  }
                : {}),
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          },
        );
      } catch (error) {
        // Network error or timeout: the send may or may not have reached Hail.
        if (attempt >= retries.length) throw error;
        await sleep(retries[attempt] as number);
        continue;
      }
      if (response.ok) return await response.json();
      // 409: Hail is still handling the first attempt. 5xx: server error.
      if (
        attempt < retries.length &&
        (response.status === 409 || response.status >= 500)
      ) {
        await response.body?.cancel();
        await sleep(retries[attempt] as number);
        continue;
      }
      await response.body?.cancel();
      throw new HailApiError(
        response.status,
        retryAfterMs(response.headers.get("retry-after")),
      );
    }
  }

  postMessage(
    threadId: string,
    message: AdapterPostableMessage,
  ): Promise<RawMessage<HailSms>> {
    return this.send(threadId, message);
  }

  private async send(
    threadId: string,
    message: AdapterPostableMessage,
    signal?: AbortSignal,
  ): Promise<RawMessage<HailSms>> {
    const { fromNumber, peerNumber } = this.decodeThreadId(threadId);
    const body = this.text(message);
    if (!body.trim()) throw new Error("SMS text cannot be empty");
    if ([...body].length > SMS_MAX) throw new Error(TOO_LONG);
    const consent =
      this.config.recipientConsent ??
      process.env.HAIL_RECIPIENT_CONSENT === "true";
    if (
      (typeof consent === "function" ? await consent(peerNumber) : consent) !==
      true
    ) {
      throw new Error(
        "Explicit recipient consent is required before sending SMS",
      );
    }
    const raw = await this.api(
      "/v1/sms",
      {
        from: fromNumber,
        to: peerNumber,
        body,
        recipient_consent: true,
        message_type: "informational",
      },
      signal,
    );
    if (
      !isSms(raw) ||
      raw.from_e164 !== fromNumber ||
      raw.to_e164 !== peerNumber ||
      raw.direction !== "outbound" ||
      raw.status === "failed" ||
      raw.status === "undelivered"
    ) {
      throw new Error("Unexpected Hail SMS send response");
    }
    return { id: raw.id, threadId, raw };
  }

  /**
   * SMS cannot be edited, so a streamed reply is collected and sent as one message.
   * This replaces Chat SDK's post-then-edit fallback, which would send a placeholder SMS.
   */
  async stream(
    threadId: string,
    textStream: AsyncIterable<string | StreamChunk>,
    options?: StreamOptions,
  ): Promise<RawMessage<HailSms>> {
    // Fail on a bad thread ID before reading (and paying for) the stream.
    this.decodeThreadId(threadId);
    const signal = options?.signal;
    let text = "";
    for await (const chunk of textStream) {
      signal?.throwIfAborted();
      if (typeof chunk === "string") text += chunk;
      else if (chunk.type === "markdown_text") text += chunk.text;
      // UTF-16 length is never below the code point count, so the full
      // count runs only near the limit. Over it, stop reading.
      if (text.length > SMS_MAX && [...text].length > SMS_MAX)
        throw new Error(TOO_LONG);
    }
    // Chat SDK ends the stream quietly on abort, so check again here.
    signal?.throwIfAborted();
    return this.send(threadId, { markdown: text }, signal);
  }

  async fetchMessage(
    threadId: string,
    messageId: string,
  ): Promise<Message<HailSms> | null> {
    this.decodeThreadId(threadId);
    if (!UUID.test(messageId)) throw new Error("Invalid Hail message ID");
    let raw: unknown;
    try {
      raw = await this.api(`/v1/sms/${encodeURIComponent(messageId)}`);
    } catch (error) {
      if (error instanceof HailApiError && error.status === 404) return null;
      throw error;
    }
    if (!isSms(raw)) throw new Error("Invalid Hail SMS response");
    const { fromNumber, peerNumber } = this.decodeThreadId(threadId);
    if (
      raw.direction === "inbound"
        ? raw.to_e164 !== fromNumber || raw.from_e164 !== peerNumber
        : raw.from_e164 !== fromNumber || raw.to_e164 !== peerNumber
    )
      return null;
    return this.parseMessage(raw);
  }

  /** Return no native history so Chat SDK uses its persisted thread-history fallback. */
  async fetchMessages(
    threadId: string,
    _options?: FetchOptions,
  ): Promise<FetchResult<HailSms>> {
    this.decodeThreadId(threadId);
    return { messages: [] };
  }
  async editMessage(): Promise<RawMessage<HailSms>> {
    throw new NotImplementedError(
      "SMS messages cannot be edited",
      "editMessage",
    );
  }
  async deleteMessage(): Promise<void> {
    throw new NotImplementedError(
      "SMS messages cannot be deleted",
      "deleteMessage",
    );
  }
  async addReaction(): Promise<void> {
    throw new NotImplementedError("SMS has no reactions", "addReaction");
  }
  async removeReaction(): Promise<void> {
    throw new NotImplementedError("SMS has no reactions", "removeReaction");
  }
  async startTyping(): Promise<void> {
    /* SMS has no typing indicator. */
  }
}

export function createHailAdapter(config: HailAdapterConfig = {}): HailAdapter {
  return new HailAdapter(config);
}
