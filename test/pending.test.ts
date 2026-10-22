import { test } from "node:test";
import assert from "node:assert/strict";
import { PENDING_TTL_MS, setPendingVcc, takePendingFrom, takePendingVcc } from "../src/oc/pending";

test("takePendingFrom returns a fresh request and removes it", () => {
  const pending = new Map([
    ["s1", { keepUserTurns: 2, keepUserTurnsExplicit: true, followUpPrompt: "go", at: 1_000 }],
  ]);
  const taken = takePendingFrom(pending, "s1", 1_000);
  assert.equal(taken?.keepUserTurns, 2);
  assert.equal(taken?.followUpPrompt, "go");
  assert.equal(pending.has("s1"), false);
  assert.equal(takePendingFrom(pending, "s1", 1_000), undefined);
});

test("a stale request is dropped instead of applying to a later compaction", () => {
  const pending = new Map([
    ["s1", { keepUserTurns: 2, keepUserTurnsExplicit: true, followUpPrompt: "", at: 1_000 }],
  ]);
  const now = 1_000 + PENDING_TTL_MS + 1;
  assert.equal(takePendingFrom(pending, "s1", now), undefined);
  assert.equal(pending.has("s1"), false);
});

test("a request inside the TTL is still applied", () => {
  const pending = new Map([
    ["s1", { keepUserTurns: 2, keepUserTurnsExplicit: true, followUpPrompt: "", at: 1_000 }],
  ]);
  assert.ok(takePendingFrom(pending, "s1", 1_000 + PENDING_TTL_MS));
});

test("takePendingVcc uses the module-level map", () => {
  setPendingVcc("s-module", { keepUserTurns: 3, keepUserTurnsExplicit: true, followUpPrompt: "" });
  const taken = takePendingVcc("s-module");
  assert.equal(taken?.keepUserTurns, 3);
  assert.equal(takePendingVcc("s-module"), undefined);
});