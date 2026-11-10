import { setTimeout as delay } from "node:timers/promises";

export async function* itemsFromPages(api, path) {
  const url = new URL(path, "https://pagination.invalid");
  const seen = new Set();
  while (true) {
    const page = await api(`${url.pathname}${url.search}`);
    if (!Array.isArray(page.items))
      throw new Error("Invalid paginated response");
    yield* page.items;
    const cursor = page.next_cursor;
    if (cursor === null || cursor === undefined || cursor === "") return;
    if (typeof cursor !== "string" || seen.has(cursor))
      throw new Error("Invalid or repeated pagination cursor");
    seen.add(cursor);
    url.searchParams.set("cursor", cursor);
  }
}

export async function pollUntil(
  check,
  milliseconds,
  { signal, intervalMs = 500 },
) {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    const value = await check();
    signal.throwIfAborted();
    if (value) return value;
    await delay(intervalMs, undefined, { signal });
  }
  const error = new Error("Live test timed out");
  error.name = "LiveTestTimeout";
  throw error;
}
