import { createHmac } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { createHailAdapter } from "../src/index.ts";
import { createLiveProbe } from "../scripts/live-sms-probe.mjs";

const from = "+14155550100",
  peer = "+46701234567",
  nonce = "test123456";
const secret = "whs_test";
const inboundId = "fd658fd6-50ea-4248-acb1-3023bd51da0c";
const outboundId = "fd658fd6-50ea-4248-acb1-3023bd51da0d";
const probes = [];
afterEach(async () => {
  await Promise.all(probes.splice(0).map((p) => p.shutdown()));
});
function request({
  sender = peer,
  body = `HAIL-E2E ${nonce}`,
  id = inboundId,
  type = "sms.received",
  key = secret,
} = {}) {
  const payload = JSON.stringify({
    id: "delivery",
    type,
    created_at: new Date().toISOString(),
    data: { id, from: sender, to: from, body },
  });
  const t = Math.floor(Date.now() / 1000);
  const mac = createHmac("sha256", key).update(`${t}.${payload}`).digest("hex");
  return new Request("http://localhost/webhook", {
    method: "POST",
    body: payload,
    headers: { "X-Hail-Signature": `t=${t},v1=${mac}` },
  });
}
function probe(
  fetch = vi.fn(async () =>
    Response.json({
      id: outboundId,
      from_e164: from,
      to_e164: peer,
      direction: "outbound",
      body: `HAIL-E2E OK ${nonce}`,
      status: "sent",
      requested_at: new Date().toISOString(),
    }),
  ),
) {
  const adapter = createHailAdapter({
    fromNumber: from,
    apiKey: "test",
    webhookSecret: secret,
    recipientConsent: (to) => to === peer,
    fetch,
  });
  const value = createLiveProbe({ adapter, peerNumber: peer, nonce });
  probes.push(value);
  return { value, fetch };
}
it("sends no SMS for another peer or an incorrect challenge", async () => {
  const { value, fetch } = probe();
  await value.handleWebhook(request({ sender: "+46707654321" }));
  await value.handleWebhook(request({ body: "ordinary customer message" }));
  await value.drain();
  expect(fetch).not.toHaveBeenCalled();
});
it("sends exactly one reply through the real Chat handler for the approved peer and challenge", async () => {
  const { value, fetch } = probe();
  expect((await value.handleWebhook(request())).status).toBe(200);
  await value.drain();
  await value.handleWebhook(
    request({ id: "fd658fd6-50ea-4248-acb1-3023bd51da0e" }),
  );
  await value.drain();
  expect(fetch).toHaveBeenCalledTimes(1);
  const [url, init] = fetch.mock.calls[0];
  expect(String(url)).toBe("https://api.hail.so/v1/sms");
  expect(JSON.parse(init.body)).toEqual({
    from,
    to: peer,
    body: `HAIL-E2E OK ${nonce}`,
    recipient_consent: true,
    message_type: "informational",
  });
  expect(value.snapshot()).toMatchObject({
    inboundId,
    outboundId,
    sendStarted: true,
  });
});
it("does not accept a forged delivery receipt", async () => {
  const { value } = probe();
  await value.handleWebhook(request());
  await value.drain();
  expect(
    (
      await value.handleWebhook(
        request({ type: "sms.delivered", id: outboundId, key: "wrong" }),
      )
    ).status,
  ).toBe(401);
  expect(value.snapshot().deliveryConfirmed).toBe(false);
  await value.handleWebhook(request({ type: "sms.delivered", id: inboundId }));
  expect(value.snapshot().deliveryConfirmed).toBe(false);
  await value.handleWebhook(request({ type: "sms.delivered", id: outboundId }));
  expect(value.snapshot().deliveryConfirmed).toBe(true);
});
it("records send failures and does not retry a potentially chargeable send", async () => {
  const { value, fetch } = probe(
    vi.fn(
      async () => new Response("private provider response", { status: 429 }),
    ),
  );
  await value.handleWebhook(request());
  await value.drain();
  await value.handleWebhook(
    request({ id: "fd658fd6-50ea-4248-acb1-3023bd51da0e" }),
  );
  await value.drain();
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(value.snapshot()).toMatchObject({
    sendStarted: true,
    error: "Hail API request failed (429)",
  });
  expect(JSON.stringify(value.snapshot())).not.toContain("private provider");
});
