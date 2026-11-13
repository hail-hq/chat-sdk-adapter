import { Chat } from "chat";
import { createMemoryState } from "@chat-adapter/state-memory";

/** A one-reply probe. Only the approved peer and exact challenge can cause a send. */
export function createLiveProbe({ adapter, peerNumber, nonce }) {
  if (
    !/^\+[1-9][0-9]{6,14}$/.test(peerNumber) ||
    !/^[a-zA-Z0-9]{8,64}$/.test(nonce)
  ) {
    throw new Error("A valid peer number and test nonce are required");
  }
  const state = { sendStarted: false };
  const pending = new Set();
  const bot = new Chat({
    userName: "hail-e2e",
    adapters: { hail: adapter },
    state: createMemoryState(),
    logger: "silent",
  });
  bot.onDirectMessage(async (thread, message) => {
    if (
      message.author.userId !== peerNumber ||
      message.text !== `HAIL-E2E ${nonce}` ||
      state.sendStarted
    )
      return;
    state.sendStarted = true;
    state.inboundId = message.id;
    try {
      const sent = await thread.post(`HAIL-E2E OK ${nonce}`);
      state.outboundId = sent.id;
    } catch (error) {
      state.error =
        typeof error?.status === "number"
          ? `Hail API request failed (${error.status})`
          : "SMS send failed";
    }
  });
  return {
    snapshot: () => ({ ...state }),
    handleWebhook(request) {
      state.deliveryId ??= request.headers.get("x-hail-delivery") ?? undefined;
      return bot.webhooks.hail(request, {
        waitUntil(task) {
          pending.add(task);
          task.then(
            () => pending.delete(task),
            () => pending.delete(task),
          );
        },
      });
    },
    async drain() {
      while (pending.size) await Promise.allSettled([...pending]);
    },
    async shutdown() {
      await this.drain();
      await bot.shutdown();
    },
  };
}
