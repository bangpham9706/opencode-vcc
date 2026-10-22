import { test } from "node:test";
import assert from "node:assert/strict";
import { createCompactionHandler, type CompactionEvent } from "../src/compact/hook";
import { SnapStore } from "../src/oc/snapstore";
import { DEFAULT_SETTINGS, type VccSettings } from "../src/oc/settings";
import type { PendingVcc } from "../src/oc/pending";
import { memoryStorage } from "./support/fixtures";
import type { OcLLMMessage } from "../src/oc/adapter";

const conversation = (turns: number): OcLLMMessage[] =>
  Array.from({ length: turns }, (_, i) => [
    { id: `m${i * 2}`, role: "user", content: [{ type: "text", text: `Question ${i}: please add a redis cache to the API` }] },
    { id: `m${i * 2 + 1}`, role: "assistant", content: [{ type: "text", text: `Answer ${i}: the redis cache is wired up` }] },
  ]).flat();

const setup = (over: Partial<VccSettings> = {}, pending = new Map<string, PendingVcc>()) => {
  const settings = { ...DEFAULT_SETTINGS, ...over };
  const storage = memoryStorage();
  const store = new SnapStore(storage);
  const handler = createCompactionHandler(settings, store, pending);
  return { handler, store, pending };
};

const request = (keepUserTurns: number): PendingVcc => ({
  keepUserTurns,
  keepUserTurnsExplicit: true,
  followUpPrompt: "",
  at: Date.now(),
});

test("automatic compaction sets a summary and a keepID for the kept tail", async () => {
  const { handler, store } = setup({ smartKeepTail: false });
  const event: CompactionEvent = { sessionID: "s1", model: { providerID: "openai" }, messages: conversation(3) };
  const out = await handler(event);
  assert.equal(out.handled, true);
  assert.ok(event.result);
  assert.ok((event.result!.summary.length ?? 0) > 20);
  assert.equal(event.result!.metadata?.keepID, "m4");
  assert.equal((await store.listEntries("s1")).length, 4);
  assert.equal((await store.listCompactions("s1")).length, 1);
});

test("an explicit /vcc keep:3 compacts everything with no keepID", async () => {
  const pending = new Map<string, PendingVcc>();
  pending.set("s1", request(3));
  const { handler, store } = setup({}, pending);
  const event: CompactionEvent = { sessionID: "s1", messages: conversation(3) };
  const out = await handler(event);
  assert.equal(out.handled, true);
  assert.equal(event.result!.metadata?.keepID, undefined);
  assert.equal(event.result!.metadata?.recent, "");
  assert.equal((await store.listEntries("s1")).length, 6);
  assert.equal(pending.has("s1"), false);
});

test("the pending /vcc request is consumed only for its own session", async () => {
  const pending = new Map<string, PendingVcc>();
  pending.set("other", request(1));
  const { handler } = setup({ smartKeepTail: false }, pending);
  await handler({ sessionID: "s1", messages: conversation(3) });
  assert.equal(pending.has("other"), true);
});

test("skipForProviders steps aside for a matching provider", async () => {
  const { handler } = setup({ skipForProviders: ["anthropic"] });
  const event: CompactionEvent = { sessionID: "s1", model: { providerID: "Anthropic" }, messages: conversation(3) };
  const out = await handler(event);
  assert.equal(out.handled, false);
  assert.equal(out.reason, "skipped_same_provider");
  assert.equal(event.result, undefined);
});

test("overrideDefaultCompaction false steps aside for automatic compaction", async () => {
  const { handler } = setup({ overrideDefaultCompaction: false });
  const out = await handler({ sessionID: "s1", messages: conversation(3) });
  assert.equal(out.reason, "skipped_override_disabled");
});

test("a provider-native window is skipped", async () => {
  const { handler } = setup();
  const messages = conversation(3);
  messages[1] = { id: "m1", role: "assistant", content: [{ type: "compaction", encrypted: "xxx" }] };
  const out = await handler({ sessionID: "s1", messages });
  assert.equal(out.reason, "skipped_native");
});

test("too little history yields nothing to compact", async () => {
  const { handler } = setup();
  const out = await handler({ sessionID: "s1", messages: conversation(1) });
  assert.equal(out.handled, false);
  assert.equal(out.reason, "nothing_to_compact");
});

test("a previous checkpoint feeds the merged summary and is not indexed", async () => {
  const { handler, store } = setup({ smartKeepTail: false });
  const messages: OcLLMMessage[] = [
    {
      id: "c1",
      role: "user",
      content: [{
        type: "text",
        text: [
          "<conversation-checkpoint>",
          "<summary>[Session Goal]\n- Set up the database.\n\n---\n\n#0 [user] hi</summary>",
          "</conversation-checkpoint>",
        ].join("\n"),
      }],
    },
    ...conversation(3),
  ];
  const event: CompactionEvent = { sessionID: "s1", messages };
  const out = await handler(event);
  assert.equal(out.handled, true);
  assert.ok(out.summary!.includes("Set up the database"));
  // checkpoint is not one of the indexed entries
  assert.equal((await store.listEntries("s1")).length, 4);
});