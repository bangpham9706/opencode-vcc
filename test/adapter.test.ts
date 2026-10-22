import { test } from "node:test";
import assert from "node:assert/strict";
import {
  estimateMessageChars,
  hasNativeCompaction,
  sessionMessagesToSummary,
  toSummaryMessages,
  toolResultToText,
  type OcLLMMessage,
} from "../src/oc/adapter";
import { parseShellUserText } from "../src/core/normalize";

test("toSummaryMessages maps ids, roles and content parts", () => {
  const input: OcLLMMessage[] = [
    { id: "m1", role: "user", content: [{ type: "text", text: "hello" }] },
    { id: "m2", role: "assistant", content: [
      { type: "reasoning", text: "think" },
      { type: "text", text: "answer" },
      { type: "tool-call", id: "tc1", name: "read", input: { path: "a.ts" } },
      { type: "tool-result", id: "tc1", name: "read", result: { type: "text", value: "file body" } },
    ] },
  ];
  const out = toSummaryMessages(input);
  assert.equal(out[0].id, "m1");
  assert.deepEqual(out[0].content, [{ type: "text", text: "hello" }]);
  assert.deepEqual(out[1].content, [
    { type: "reasoning", text: "think" },
    { type: "text", text: "answer" },
    { type: "tool-call", callId: "tc1", name: "read", input: { path: "a.ts" } },
    { type: "tool-result", callId: "tc1", name: "read", status: "completed", text: "file body" },
  ]);
});

test("a message with an unusable id gets an empty id", () => {
  const out = toSummaryMessages([{ role: "user", content: "x" }]);
  assert.equal(out[0].id, "");
});

test("hasNativeCompaction detects a compaction part", () => {
  assert.equal(hasNativeCompaction([{ role: "user", content: [{ type: "text", text: "x" }] }]), false);
  assert.equal(hasNativeCompaction([{ role: "assistant", content: [{ type: "compaction", encrypted: "x" }] }]), true);
});

test("toolResultToText flattens json and content results", () => {
  assert.equal(toolResultToText({ type: "json", value: { a: 1 } }), '{"a":1}');
  assert.equal(toolResultToText({ type: "text", value: "hi" }), "hi");
  assert.equal(
    toolResultToText({ type: "content", value: [{ type: "text", text: "a" }, { type: "file", mime: "text/plain", name: "x.txt" }] as never }),
    "a\n[Attached text/plain: x.txt]",
  );
});

test("estimateMessageChars counts each part", () => {
  assert.equal(estimateMessageChars({ id: "m", role: "user", content: "abc" }), 3);
  assert.equal(
    estimateMessageChars({ id: "m", role: "assistant", content: [{ type: "text", text: "ab" }, { type: "tool-call", callId: "c", name: "read", input: { p: 1 } }] }),
    2 + 4 + '{"p":1}'.length,
  );
});

test("sessionMessagesToSummary translates the durable stream", () => {
  const out = sessionMessagesToSummary([
    { id: "u1", type: "user", text: "do it" },
    { id: "s1", type: "system", text: "be nice" },
    { id: "sh1", type: "shell", command: "ls -la", output: { output: "a\nb" } },
    { id: "c1", type: "compaction", status: "running", summary: "ignored" },
    { id: "c2", type: "compaction", status: "completed", summary: "we did things" },
    { id: "a1", type: "assistant", content: [
      { type: "text", text: "done" },
      { type: "tool", id: "tc1", name: "read", state: { status: "completed", input: { path: "a.ts" }, content: [{ type: "text", text: "body" }] } },
    ] },
    { id: "x1", type: "model-switched" },
  ]);

  assert.deepEqual(out.map((m) => m.role), ["user", "system", "user", "user", "assistant"]);
  const shell = out[2];
  assert.equal(typeof shell.content, "string");
  assert.deepEqual(parseShellUserText(shell.content as string), { command: "ls -la", output: "a\nb" });
  assert.ok((out[3].content as string).includes("<conversation-checkpoint>"));
  assert.ok((out[3].content as string).includes("we did things"));
  assert.deepEqual(out[4].content, [
    { type: "text", text: "done" },
    { type: "tool-call", callId: "tc1", name: "read", input: { path: "a.ts" } },
    { type: "tool-result", callId: "tc1", name: "read", status: "completed", text: "body" },
  ]);
});