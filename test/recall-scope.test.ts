import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeRecallMode, normalizeRecallScope, parseRecallScope } from "../src/core/recall-scope";

test("normalizeRecallScope defaults to lineage, accepts all case-insensitively", () => {
  assert.equal(normalizeRecallScope(undefined), "lineage");
  assert.equal(normalizeRecallScope("ALL"), "all");
  assert.equal(normalizeRecallScope("all"), "all");
  assert.equal(normalizeRecallScope("nonsense"), "lineage");
});

test("normalizeRecallMode only accepts touched, else hybrid", () => {
  assert.equal(normalizeRecallMode("touched"), "touched");
  assert.equal(normalizeRecallMode("TOUCHED"), "touched");
  assert.equal(normalizeRecallMode("file"), "hybrid");
  assert.equal(normalizeRecallMode(undefined), "hybrid");
});

test("parseRecallScope extracts scope:all and removes it from the query", () => {
  assert.deepEqual(parseRecallScope("redis cache scope:all"), { scope: "all", text: "redis cache" });
  assert.deepEqual(parseRecallScope("redis cache"), { scope: "lineage", text: "redis cache" });
});