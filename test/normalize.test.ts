import { test } from "node:test";
import assert from "node:assert/strict";
import { normalize, parseShellUserText, isCompactionCheckpoint, summaryOfCheckpoint } from "../src/core/normalize";
import { assistant, assistantTool, checkpoint, shell, toolResult, user } from "./support/fixtures";

test("user text becomes a user block", () => {
  assert.deepEqual(normalize([user("u1", "hello world")]), [
    { kind: "user", text: "hello world", sourceIndex: 0 },
  ]);
});

test("system messages produce no blocks", () => {
  assert.deepEqual(normalize([{ id: "s", role: "system", content: "sys" }]), []);
});

test("an OpenCode user shell message becomes a bash block", () => {
  const blocks = normalize([shell("sh1", "ls -la", "a\nb")]);
  assert.deepEqual(blocks, [
    { kind: "bash", command: "ls -la", output: "a\nb", exitCode: undefined, sourceIndex: 0 },
  ]);
});

test("parseShellUserText parses command and output across the blank line", () => {
  assert.deepEqual(parseShellUserText(shell("x", "echo hi", "hi").content as string), { command: "echo hi", output: "hi" });
  assert.equal(parseShellUserText("just text"), null);
});

test("a previous compaction checkpoint is kept as user context", () => {
  const blocks = normalize([checkpoint("c1", "we did things")]);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].kind, "user");
  assert.ok((blocks[0] as { text: string }).text.includes("<conversation-checkpoint>"));
  assert.equal(summaryOfCheckpoint((blocks[0] as { text: string }).text), "we did things");
});

test("isCompactionCheckpoint requires the wrapper plus a body", () => {
  assert.equal(isCompactionCheckpoint("<conversation-checkpoint><summary>x</summary></conversation-checkpoint>"), true);
  assert.equal(isCompactionCheckpoint("<conversation-checkpoint></conversation-checkpoint>"), false);
  assert.equal(isCompactionCheckpoint("plain"), false);
});

test("role tool messages become tool_result blocks", () => {
  assert.deepEqual(normalize([toolResult("t1", "read", "file body")]), [
    { kind: "tool_result", name: "read", text: "file body", sourceIndex: 0 },
  ]);
});

test("assistant tool-call and tool-result parts both become blocks", () => {
  const blocks = normalize([assistantTool("a1", "read", { path: "a.ts" }, { result: "body" })]);
  assert.deepEqual(blocks, [
    { kind: "tool_call", name: "read", args: { path: "a.ts" }, sourceIndex: 0 },
    { kind: "tool_result", name: "read", text: "body", sourceIndex: 0 },
  ]);
});

test("sourceIndices override positional indices", () => {
  const blocks = normalize([user("u1", "a"), assistant("a1", "b")], [10, 11]);
  assert.equal(blocks[0].sourceIndex, 10);
  assert.equal(blocks[1].sourceIndex, 11);
});