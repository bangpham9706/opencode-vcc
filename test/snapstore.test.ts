import { test } from "node:test";
import assert from "node:assert/strict";
import { SnapStore } from "../src/oc/snapstore";
import { memoryStorage } from "./support/fixtures";
import { assistant, user } from "./support/fixtures";

const msgs = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `m${i}`, message: user(`m${i}`, `t${i}`) }));

test("ensureIndexed assigns stable session-global indices from 0", async () => {
  const store = new SnapStore(memoryStorage());
  const map = await store.ensureIndexed("s1", msgs(3));
  assert.deepEqual([...map.entries()], [["m0", 0], ["m1", 1], ["m2", 2]]);
  assert.equal(await store.getNextIndex("s1"), 3);
});

test("ensureIndexed is idempotent and keeps original indices", async () => {
  const store = new SnapStore(memoryStorage());
  await store.ensureIndexed("s1", msgs(2));
  const map = await store.ensureIndexed("s1", [{ id: "m1", message: user("m1") }, { id: "m9", message: assistant("m9") }]);
  assert.equal(map.get("m1"), 1);
  assert.equal(map.get("m9"), 2);
});

test("indexing skips empty ids", async () => {
  const store = new SnapStore(memoryStorage());
  const map = await store.ensureIndexed("s1", [{ id: "", message: user("") }, { id: "m1", message: user("m1") }]);
  assert.equal(map.has(""), false);
  assert.equal(map.get("m1"), 0);
});

test("indices continue across separate indexMessages calls", async () => {
  const store = new SnapStore(memoryStorage());
  await store.indexMessages("s1", msgs(2));
  const added = await store.indexMessages("s1", [{ id: "m5", message: user("m5") }]);
  assert.equal(added[0].idx, 2);
});

test("listEntries returns entries in #N order", async () => {
  const store = new SnapStore(memoryStorage());
  await store.ensureIndexed("s1", msgs(3));
  const entries = await store.listEntries("s1");
  assert.deepEqual(entries.map((e) => e.idx), [0, 1, 2]);
  assert.deepEqual(entries.map((e) => e.id), ["m0", "m1", "m2"]);
});

test("compaction records round-trip and sort by time", async () => {
  const store = new SnapStore(memoryStorage());
  await store.putCompaction("s1", "b", { time: 20, reason: "auto", sections: ["Session Goal"], summarized: 3, kept: 1, keptTokensEst: 10 });
  await store.putCompaction("s1", "a", { time: 10, reason: "manual", sections: [], summarized: 1, kept: 0, keptTokensEst: 0 });
  const list = await store.listCompactions("s1");
  assert.deepEqual(list.map((c) => c.reason), ["manual", "auto"]);
});

test("sessions are isolated", async () => {
  const store = new SnapStore(memoryStorage());
  await store.ensureIndexed("s1", msgs(2));
  await store.ensureIndexed("s2", msgs(1));
  assert.equal(await store.getNextIndex("s1"), 2);
  assert.equal(await store.getNextIndex("s2"), 1);
});