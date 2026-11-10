import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHailAdapter } from "../dist/index.js";
import { createLiveProbe } from "./live-sms-probe.mjs";
import { itemsFromPages, pollUntil } from "./live-sms-utils.mjs";

class LiveTestError extends Error {}

// This entry point intentionally does not run in CI or in the regular test suite.
if (process.env.HAIL_E2E_CONFIRM !== "send-one-sms") {
  throw new LiveTestError(
    "Set HAIL_E2E_CONFIRM=send-one-sms only for an authorized live exchange",
  );
}
const phone = /^\+[1-9][0-9]{6,14}$/;
const from = process.env.HAIL_FROM_NUMBER;
const peer = process.env.HAIL_E2E_PEER_NUMBER;
if (!phone.test(from ?? "") || !phone.test(peer ?? "") || from === peer) {
  throw new LiveTestError(
    "Set distinct HAIL_FROM_NUMBER and HAIL_E2E_PEER_NUMBER in E.164 format",
  );
}
const publicUrl = new URL(process.env.HAIL_E2E_PUBLIC_URL ?? "");
if (
  publicUrl.protocol !== "https:" ||
  publicUrl.pathname !== "/" ||
  publicUrl.username ||
  publicUrl.password ||
  publicUrl.search ||
  publicUrl.hash
) {
  throw new LiveTestError(
    "HAIL_E2E_PUBLIC_URL must be your test tunnel's HTTPS origin",
  );
}
const port = Number(process.env.HAIL_E2E_PORT ?? 8787);
if (!Number.isInteger(port) || port < 1024 || port > 65535)
  throw new LiveTestError("Invalid test port");
let credentials = {};
if (!process.env.HAIL_API_KEY) {
  try {
    credentials = JSON.parse(
      readFileSync(join(homedir(), ".hail/credentials.json"), "utf8"),
    );
  } catch {
    throw new LiveTestError(
      "Set HAIL_API_KEY or authenticate the Hail CLI first",
    );
  }
}
const apiKey = process.env.HAIL_API_KEY || credentials.api_key;
if (!apiKey) throw new LiveTestError("A Hail API key is required");
const apiOrigin = new URL(
  process.env.HAIL_API_URL || credentials.api_url || "https://api.hail.so",
);
if (
  !["https:", "http:"].includes(apiOrigin.protocol) ||
  apiOrigin.pathname !== "/" ||
  apiOrigin.username ||
  apiOrigin.password ||
  apiOrigin.search ||
  apiOrigin.hash
)
  throw new LiveTestError("HAIL_API_URL must be an API origin");
const nonce = randomBytes(8).toString("hex");
const target = new URL(`/webhooks/hail/${nonce}`, publicUrl);
const reportPath = resolve(
  process.env.HAIL_E2E_REPORT ||
    join(tmpdir(), `chat-sdk-adapter-live-sms-${nonce}.json`),
);
const report = {
  nonce,
  startedAt: new Date().toISOString(),
  fromSuffix: from.slice(-4),
  peerSuffix: peer.slice(-4),
  passed: false,
};
const abort = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () => abort.abort());
async function api(path, method = "GET", data) {
  const response = await fetch(new URL(path, apiOrigin), {
    method,
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
    headers: {
      Authorization: `Bearer ${apiKey}`,
      ...(data === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  });
  if (!response.ok)
    throw new LiveTestError(
      `Hail test API request failed (${response.status})`,
    );
  return response.status === 204 ? undefined : await response.json();
}
let probe,
  server,
  subscriptionId,
  createAttempted = false;
const until = (check, milliseconds) =>
  pollUntil(check, milliseconds, { signal: abort.signal });

try {
  const identity = await api("/v1/whoami");
  if (!identity.organization_id || identity.auth_kind === "shared")
    throw new LiveTestError("Use an organization-scoped Hail credential");
  let number;
  for await (const item of itemsFromPages(api, "/v1/numbers?limit=200")) {
    if (item.e164 === from) {
      number = item;
      break;
    }
  }
  if (
    !number ||
    number.provisioning_state !== "active" ||
    !number.capabilities?.includes("sms")
  )
    throw new LiveTestError(
      "The selected number must be active and SMS-capable in this workspace",
    );
  if (number.sms_agent_id)
    throw new LiveTestError(
      "The selected number has a text agent; use a dedicated test number or explicitly arrange temporary detachment first",
    );
  server = createServer(async (req, res) => {
    try {
      if (req.method !== "POST" || req.url !== target.pathname) {
        res.writeHead(404);
        res.end();
        return;
      }
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 65_536) {
          res.writeHead(413);
          res.end();
          return;
        }
        chunks.push(chunk);
      }
      if (!probe) {
        res.writeHead(503);
        res.end();
        return;
      }
      const request = new Request(target, {
        method: "POST",
        headers: req.headers,
        body: Buffer.concat(chunks),
      });
      const response = await probe.handleWebhook(request);
      res.writeHead(response.status);
      res.end(await response.text());
    } catch {
      res.writeHead(500);
      res.end();
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  createAttempted = true;
  const subscription = await api("/v1/webhooks", "POST", {
    target_url: String(target),
    event_types: [
      "sms.received",
      "sms.delivered",
      "sms.failed",
      "sms.undelivered",
    ],
  });
  subscriptionId = subscription.id;
  report.subscriptionId = subscriptionId;
  if (!subscriptionId || !subscription.secret)
    throw new LiveTestError(
      "Webhook subscription did not return its ID and signing secret",
    );
  const adapter = createHailAdapter({
    apiKey,
    apiUrl: String(apiOrigin),
    fromNumber: from,
    webhookSecret: subscription.secret,
    recipientConsent: (to) => to === peer,
  });
  probe = createLiveProbe({ adapter, peerNumber: peer, nonce });
  const rejected = await fetch(target, {
    method: "POST",
    body: "{}",
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  if (rejected.status !== 401)
    throw new LiveTestError(
      "The public test endpoint did not reject an unsigned request",
    );
  report.unsignedRequestRejected = true;
  console.log(
    `READY: send exactly "HAIL-E2E ${nonce}" from your approved phone to ${from}.`,
  );
  console.log(
    `Expected handset reply: "HAIL-E2E OK ${nonce}". No other messages trigger a reply.`,
  );
  await until(async () => {
    const state = probe.snapshot();
    if (state.error) throw new LiveTestError(state.error);
    return state.outboundId;
  }, 10 * 60_000);
  const state = probe.snapshot();
  report.inboundId = state.inboundId;
  report.outboundId = state.outboundId;
  const inbound = await api(`/v1/sms/${encodeURIComponent(state.inboundId)}`);
  if (
    inbound.direction !== "inbound" ||
    inbound.from_e164 !== peer ||
    inbound.to_e164 !== from ||
    inbound.body !== `HAIL-E2E ${nonce}`
  )
    throw new LiveTestError(
      "Inbound API record did not match the approved test challenge",
    );
  report.inboundApiVerified = true;
  await until(async () => {
    const outbound = await api(
      `/v1/sms/${encodeURIComponent(state.outboundId)}`,
    );
    if (
      outbound.from_e164 !== from ||
      outbound.to_e164 !== peer ||
      outbound.direction !== "outbound" ||
      outbound.body !== `HAIL-E2E OK ${nonce}`
    )
      throw new LiveTestError(
        "Outbound API record did not match the expected reply",
      );
    report.outboundStatus = outbound.status;
    if (["failed", "undelivered"].includes(outbound.status))
      throw new LiveTestError(`Carrier reported ${outbound.status}`);
    return outbound.status === "delivered";
  }, 2 * 60_000);
  report.carrierDeliveryConfirmed = true;
  await until(async () => {
    for await (const item of itemsFromPages(
      api,
      `/v1/webhooks/${encodeURIComponent(subscriptionId)}/deliveries?limit=200`,
    )) {
      if (
        item.event_id === state.inboundId &&
        item.event_type === "sms.received" &&
        item.status === "succeeded" &&
        item.response_status === 200
      )
        return true;
    }
    return false;
  }, 30_000);
  report.signedWebhookDeliveryVerified = true;
  report.passed = true;
} catch (error) {
  // Do not include response bodies, credentials, webhook payloads, or full phone numbers.
  report.error =
    error instanceof LiveTestError
      ? error.message
      : error?.name === "AbortError"
        ? "Live test interrupted"
        : error?.name === "LiveTestTimeout"
          ? "Live test timed out"
          : "Live test failed; no private error details were recorded";
  process.exitCode = 1;
} finally {
  if (server?.listening)
    await new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections();
    });
  if (probe) await probe.shutdown();
  if (createAttempted) {
    try {
      const ids = subscriptionId ? [subscriptionId] : [];
      if (!subscriptionId) {
        for await (const item of itemsFromPages(
          api,
          "/v1/webhooks?limit=200",
        )) {
          if (item.target_url === String(target)) ids.push(item.id);
        }
      }
      for (const id of ids)
        await api(`/v1/webhooks/${encodeURIComponent(id)}`, "DELETE");
      report.webhookRemoved = true;
    } catch {
      report.webhookRemoved = false;
      report.passed = false;
      process.exitCode = 1;
    }
  }
  if (abort.signal.aborted) {
    report.passed = false;
    report.error = "Live test interrupted";
    process.exitCode = 1;
  }
  report.finishedAt = new Date().toISOString();
  writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n", {
    mode: 0o600,
  });
  console.log(JSON.stringify(report, null, 2));
  console.log(`Report: ${reportPath}`);
}
