import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyTailBudget,
  buildOwnCut,
  findBudgetCutIndex,
  resolveSmartKeepUserTurns,
  toSummarizerInput,
} from "../src/compact/cut";
import { assistant, checkpoint, cutItems, user } from "./support/fixtures";
import type { SummaryMessage } from "../src/types";

const convo = (turns: number) =>
  cutItems(
    Array.from({ length: turns }, (_, i) => [user(`u${i}`, `question ${i}`), assistant(`a${i}`, `answer ${i}`)]).flat(),
  );

test("buildOwnCut keep:1 keeps the last user turn and summarizes the prefix", () => {
  const cut = buildOwnCut(convo(3), 1);
  assert.ok(cut.ok);
  assert.equal(cut.compactAll, false);
  assert.equal(cut.firstKeptId, "u2");
  assert.equal(cut.keptUserTurns, 1);
  assert.equal(cut.totalUserTurns, 3);
  assert.deepEqual(cut.selected.map((i) => i.id), ["u0", "a0", "u1", "a1"]);
});

test("buildOwnCut keep:2 keeps two user turns", () => {
  const cut = buildOwnCut(convo(3), 2);
  assert.ok(cut.ok);
  assert.equal(cut.firstKeptId, "u1");
  assert.deepEqual(cut.selected.map((i) => i.id), ["u0", "a0"]);
});

test("keep beyond the available turns falls back to compact-all", () => {
  const cut = buildOwnCut(convo(3), 3);
  assert.ok(cut.ok);
  assert.equal(cut.compactAll, true);
  assert.equal(cut.keepFallbackToCompactAll, true);
  assert.equal(cut.selected.length, 6);
});

test("keep:0 is an explicit compact-all, not a fallback", () => {
  const cut = buildOwnCut(convo(3), 0);
  assert.ok(cut.ok);
  assert.equal(cut.compactAll, true);
  assert.equal(cut.keepFallbackToCompactAll, false);
});

test("fewer than three messages cannot be cut", () => {
  const cut = buildOwnCut(cutItems([user("u0"), assistant("a0")]), 1);
  assert.equal(cut.ok, false);
});

test("a previous checkpoint is not a user turn and contributes only its recent context", () => {
  const items = [
    { id: "c0", message: checkpoint("c0", "old summary", "kept tail text"), checkpoint: true },
    ...convo(2),
  ];
  const cut = buildOwnCut(items, 1);
  assert.ok(cut.ok);
  // checkpoint, u0, a0 summarized; last turn (u1, a1) kept.
  assert.equal(cut.firstKeptId, "u1");
  const input = toSummarizerInput(cut.selected);
  assert.equal(input[0].id, "c0");
  assert.equal(input[0].content, "kept tail text");
});

test("findBudgetCutIndex walks back until the token budget is crossed", () => {
  const items = convo(4).map((it, i) => ({ ...it, message: { ...it.message, content: typeof it.message.content === "string" ? "x".repeat(40 * (i + 1)) : it.message.content } }));
  const idx = findBudgetCutIndex(items, 5, 4);
  assert.ok(idx > 0 && idx < items.length);
  assert.notEqual(items[idx].message.role, "tool");
});

test("applyTailBudget re-cuts an oversized tail", () => {
  const big = (id: string, role: "user" | "assistant", len: number) => ({
    id,
    message: { id, role, content: "x".repeat(len) } as SummaryMessage,
    checkpoint: false,
  });
  const items = [
    big("u0", "user", 100), big("a0", "assistant", 100),
    big("u1", "user", 100), big("a1", "assistant", 100),
    big("u2", "user", 100), big("a2", "assistant", 100),
    big("u3", "user", 14000), big("a3", "assistant", 14000),
  ];
  const cut = buildOwnCut(items, 1);
  assert.ok(cut.ok);
  const budgeted = applyTailBudget(items, cut, { maxTokens: 50, oversizedFactor: 1.2, charsPerToken: 4 });
  assert.ok(budgeted.ok);
  assert.equal(budgeted.budgetCut, "oversized_tail");
  assert.ok(budgeted.selected.length > cut.selected.length);
  assert.ok(budgeted.selected.length < items.length);
});

test("applyTailBudget leaves an explicit keep:0 compact-all untouched", () => {
  const items = convo(4);
  const cut = buildOwnCut(items, 0);
  const budgeted = applyTailBudget(items, cut, { maxTokens: 1 });
  assert.ok(budgeted.ok && budgeted.compactAll);
  assert.equal(budgeted.budgetCut, undefined);
});

test("resolveSmartKeepUserTurns grows a small tail toward the max", () => {
  const items = convo(4);
  const res = resolveSmartKeepUserTurns({
    live: items,
    requestedKeepUserTurns: null,
    explicit: false,
    smartKeepTail: true,
    minTokens: 1000,
    maxTokens: 1_000_000,
    charsPerToken: 4,
  });
  assert.ok(res.keepUserTurns > 1);
  assert.equal(res.smartAdjusted, true);
});

test("resolveSmartKeepUserTurns never adjusts when explicit", () => {
  const items = convo(4);
  const res = resolveSmartKeepUserTurns({
    live: items,
    requestedKeepUserTurns: 1,
    explicit: true,
    smartKeepTail: true,
    minTokens: 1000,
    maxTokens: 1_000_000,
  });
  assert.equal(res.keepUserTurns, 1);
  assert.equal(res.smartAdjusted, false);
});