import { test } from "node:test";
import assert from "node:assert/strict";
import { openRecallView } from "../src/recall/source";
import { SnapStore } from "../src/oc/snapstore";
import { invalidExpandIndices, runRecall, type RecallPagingHints } from "../src/core/recall-run";
import { parseToolRequest } from "../src/core/recall-request";
import { memoryStorage } from "./support/fixtures";
import { assistant, assistantTool, user } from "./support/fixtures";
import type { SummaryMessage } from "../src/types";

const HINTS: RecallPagingHints = {
  outOfRange: (_q, _s, n) => `Use a page between 1 and ${n}.`,
  nextPage: (_q, _s, p) => `\n--- page:${p} ---`,
};

const view = async (live: SummaryMessage[]) =>
  openRecallView({
    sessionID: "s1",
    store: new SnapStore(memoryStorage()),
    live,
    scope: "lineage",
  });

const basic: SummaryMessage[] = [
  user("u0", "We need a redis cache for sessions"),
  assistant("a0", "Sure, I will add redis"),
  user("u1", "Also add a metrics dashboard"),
  assistant("a1", "Metrics use prometheus"),
];

test("recent entries list the whole window with #N refs", async () => {
  const out = await runRecall(parseToolRequest({}), await view(basic), HINTS);
  assert.ok(out.includes("Session history (4 entries):"));
  assert.ok(out.includes("#0 [user]"));
});

test("range reads #from..#to in order", async () => {
  const out = await runRecall(parseToolRequest({ range: [0, 2] }), await view(basic), HINTS);
  assert.ok(out.includes("Range #0..#2"));
  assert.ok(out.includes("#0"));
  assert.ok(out.includes("#2"));
});

test("expand returns full entries with an expanded header", async () => {
  const out = await runRecall(parseToolRequest({ expand: [1] }), await view(basic), HINTS);
  assert.ok(out.includes("Expanded #1"));
  assert.ok(out.includes("#1 [assistant]"));
});

test("search ranks hits and reports the count", async () => {
  const out = await runRecall(parseToolRequest({ query: "redis" }), await view(basic), HINTS);
  assert.ok(out.includes("redis"));
  assert.ok(out.includes("#0"));
});

test("#N:path drills into a file written by a tool call", async () => {
  const live: SummaryMessage[] = [
    user("u0", "hi"),
    assistantTool("a1", "write", { path: "src/a.ts", content: "line one\nline two" }),
  ];
  const out = await runRecall(parseToolRequest({ query: "#1:a.ts" }), await view(live), HINTS);
  assert.ok(out.includes("File: src/a.ts"));
  assert.ok(out.includes("line one"));
});

test("mode:touched aggregates files with entry indices", async () => {
  const live: SummaryMessage[] = [assistantTool("a0", "write", { path: "src/a.ts", content: "x" })];
  const out = await runRecall(parseToolRequest({ mode: "touched" }), await view(live), HINTS);
  assert.ok(out.startsWith("1 files touched"));
  assert.ok(out.includes("src/a.ts"));
  assert.ok(out.includes("#0 (write)"));
});

test("range past the end clamps to the last entry", async () => {
  const out = await runRecall(parseToolRequest({ range: [2, 99] }), await view(basic), HINTS);
  assert.ok(out.includes("#3 is the last entry"));
});

test("invalidExpandIndices names unavailable or non-integer indices", () => {
  assert.deepEqual(invalidExpandIndices([1, 2, 9], new Set([1, 2, 3])), [9]);
  assert.deepEqual(invalidExpandIndices([1.5], new Set([1])), [1.5]);
});