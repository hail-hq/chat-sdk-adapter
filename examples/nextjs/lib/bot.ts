import { Chat } from "chat";
import { createMemoryState } from "@chat-adapter/state-memory";
import { createRedisState } from "@chat-adapter/state-redis";
import { createHailAdapter } from "@hail-hq/chat-sdk-adapter";

if (process.env.NODE_ENV === "production" && !process.env.REDIS_URL) {
  throw new Error("Set REDIS_URL to persist Chat SDK state in production");
}

export const hail = createHailAdapter();

export const bot = new Chat({
  userName: "mybot",
  adapters: { hail },
  state: process.env.REDIS_URL ? createRedisState() : createMemoryState(),
  concurrency: "queue",
});

bot.onDirectMessage(async (thread, message, _channel, context) => {
  // Texts that arrived while the bot was busy, oldest first.
  const texts = [...(context?.skipped ?? []), message].map((m) => m.text);
  await thread.post(`You said: ${texts.join("\n")}`);
});
