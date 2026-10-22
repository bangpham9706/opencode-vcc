import { test } from "node:test";
import assert from "node:assert/strict";
import {
  calibrateCharsPerToken,
  estimateMessageContentChars,
  estimateMessageContentTokens,
  estimateTokensFromChars,
} from "../src/core/token-estimate";

test("estimates tokens from chars, ceiled to avoid undercounting", () => {
  assert.equal(estimateTokensFromChars(0), 0);
  assert.equal(estimateTokensFromChars(1), 1);
  assert.equal(estimateTokensFromChars(4), 1);
  assert.equal(estimateTokensFromChars(5), 2);
});

test("supports calibrated chars/token ratios", () => {
  assert.equal(estimateTokensFromChars(5, 2), 3);
  assert.equal(estimateMessageContentTokens("abcde", 2), 3);
});

test("calibrates chars/token from source chars and tokens", () => {
  assert.deepEqual(calibrateCharsPerToken(120, 40), {
    mode: "calibrated",
    charsPerToken: 3,
    sourceChars: 120,
    sourceTokens: 40,
    rawCharsPerToken: 3,
  });
});

test("clamps calibrated ratios and falls back without usable source", () => {
  assert.equal(calibrateCharsPerToken(10, 100).charsPerToken, 2);
  assert.equal(calibrateCharsPerToken(1000, 10).charsPerToken, 6);
  assert.equal(calibrateCharsPerToken(0, undefined).mode, "heuristic");
  assert.equal(calibrateCharsPerToken(0, undefined).charsPerToken, 4);
});

test("estimates content chars for text, reasoning, tool call and image parts", () => {
  assert.equal(estimateMessageContentChars("abc"), 3);
  assert.equal(
    estimateMessageContentChars([
      { type: "text", text: "abcd" },
      { type: "thinking", thinking: "ab" },
    ]),
    6,
  );
  assert.equal(estimateMessageContentChars([{ type: "toolCall", name: "read", arguments: { a: 1 } }]), 4 + '{"a":1}'.length);
  assert.equal(estimateMessageContentChars([{ type: "image" }]), 4800);
});