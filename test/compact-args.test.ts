import { test } from "node:test";
import assert from "node:assert/strict";
import { parseKeepAndPrompt } from "../src/core/compact-args";

test("empty args compact with no keep and no follow-up", () => {
  assert.deepEqual(parseKeepAndPrompt(""), { followUpPrompt: "", keepUserTurns: null, keepUserTurnsExplicit: false });
  assert.deepEqual(parseKeepAndPrompt(undefined), { followUpPrompt: "", keepUserTurns: null, keepUserTurnsExplicit: false });
});

test("leading keep:N is parsed and stripped from the follow-up", () => {
  assert.deepEqual(parseKeepAndPrompt("keep:3 do the thing"), {
    followUpPrompt: "do the thing",
    keepUserTurns: 3,
    keepUserTurnsExplicit: true,
  });
  assert.deepEqual(parseKeepAndPrompt("keep:3"), { followUpPrompt: "", keepUserTurns: 3, keepUserTurnsExplicit: true });
});

test("trailing keep:N is parsed and stripped from the follow-up", () => {
  assert.deepEqual(parseKeepAndPrompt("do the thing keep:2"), {
    followUpPrompt: "do the thing",
    keepUserTurns: 2,
    keepUserTurnsExplicit: true,
  });
});

test("a plain prompt has no keep", () => {
  assert.deepEqual(parseKeepAndPrompt("summarize what we did"), {
    followUpPrompt: "summarize what we did",
    keepUserTurns: null,
    keepUserTurnsExplicit: false,
  });
});