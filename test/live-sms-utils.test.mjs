import { expect, it } from "vitest";
import { itemsFromPages, pollUntil } from "../scripts/live-sms-utils.mjs";
it("follows opaque cursors without dropping the existing endpoint query", async () => {
  const paths = [];
  const api = async (path) => {
    paths.push(path);
    return paths.length === 1
      ? { items: [{ id: "old" }], next_cursor: "next+/=" }
      : { items: [{ id: "wanted" }], next_cursor: null };
  };
  const rows = [];
  for await (const item of itemsFromPages(api, "/v1/numbers?limit=200"))
    rows.push(item.id);
  expect(rows).toEqual(["old", "wanted"]);
  expect(paths).toEqual([
    "/v1/numbers?limit=200",
    "/v1/numbers?limit=200&cursor=next%2B%2F%3D",
  ]);
});
it("refuses repeated cursors instead of polling the same page forever", async () => {
  const api = async () => ({ items: [], next_cursor: "same" });
  await expect(
    (async () => {
      for await (const item of itemsFromPages(api, "/v1/webhooks")) void item;
    })(),
  ).rejects.toThrow(/cursor/i);
});
it("does not accept a successful check after cancellation during the request", async () => {
  const controller = new AbortController();
  await expect(
    pollUntil(
      async () => {
        controller.abort();
        return true;
      },
      100,
      { signal: controller.signal, intervalMs: 1 },
    ),
  ).rejects.toMatchObject({ name: "AbortError" });
});
it("returns a successful polling result when no cancellation occurred", async () => {
  let count = 0;
  expect(
    await pollUntil(async () => (++count === 2 ? "matched" : null), 100, {
      signal: new AbortController().signal,
      intervalMs: 1,
    }),
  ).toBe("matched");
});
