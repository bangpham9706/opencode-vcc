import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeToolParams, parseToolRequest } from "../src/core/recall-request";
import { ignoredNote } from "../src/core/recall-run";

test("does not report filler defaults as ignored", () => {
  const r = parseToolRequest({ query: "auth", page: 1, expand: [], mode: "hybrid", scope: "lineage" });
  assert.equal(r.action.kind, "search");
  assert.equal(r.ignored, undefined);
  assert.equal(ignoredNote(r), "");
});

test("expand wins over query and page, naming the dropped params", () => {
  const r = parseToolRequest({ query: "auth", expand: [4], page: 2 });
  assert.deepEqual(r.action, { kind: "expand", indices: [4] });
  assert.deepEqual(r.ignored, ["query", "page"]);
  assert.equal(ignoredNote(r), "Ignored: query, page (expand runs alone; send the rest in a separate call).\n\n");
});

test("range keeps page and names the query", () => {
  const r = parseToolRequest({ range: [10, 50], page: 2, query: "auth" });
  assert.deepEqual(r.action, { kind: "range", range: [10, 50], page: 2 });
  assert.deepEqual(r.ignored, ["query"]);
});

test("touched mode wins, and a query is named as ignored", () => {
  const r = parseToolRequest({ mode: "touched", query: "auth" });
  assert.equal(r.action.kind, "touched");
  assert.deepEqual(r.ignored, ["query"]);
});

test("#N:path is a drill-down that runs alone", () => {
  const r = parseToolRequest({ query: "#12:auth.ts", page: 3, mode: "touched" });
  assert.equal(r.action.kind, "drill");
  assert.deepEqual(ignoredNote(r), "Ignored: page, mode (a #N:path query runs alone).\n\n");
});

test("no params reads the most recent entries", () => {
  const r = parseToolRequest({});
  assert.equal(r.action.kind, "recent");
  assert.equal(r.ignored, undefined);
});

test("normalizeToolParams repairs string indices, lists and reversed ranges", () => {
  assert.deepEqual(normalizeToolParams({ page: "2" }).page, 2);
  assert.deepEqual(normalizeToolParams({ expand: "#4" }).expand, [4]);
  assert.deepEqual(normalizeToolParams({ expand: "12 15" }).expand, [12, 15]);
  assert.deepEqual(normalizeToolParams({ range: "10-20" }).range, [10, 20]);
  assert.deepEqual(normalizeToolParams({ range: [50, 10] }).range, [10, 50]);
  assert.deepEqual(normalizeToolParams({ range: 7 }).range, [7, 7]);
});

test("normalizeToolParams moves a scope value out of mode", () => {
  const p = normalizeToolParams({ mode: "ALL" });
  assert.equal(p.scope, "all");
  assert.equal(p.mode, undefined);
});

test("normalizeToolParams drops unknown and unrepairable params, naming them", () => {
  const p = normalizeToolParams({ page: "later", banana: 1 });
  const dropped = p._vccDropped as string[];
  assert.equal(p.page, undefined);
  assert.equal(p.banana, undefined);
  assert.ok(dropped.some((d) => d.startsWith("page ")));
  assert.ok(dropped.some((d) => d.startsWith("banana ")));
});

test("parseToolRequest surfaces dropped params in ignoredNote", () => {
  const r = parseToolRequest(normalizeToolParams({ query: "auth", page: "later" }) as never);
  assert.ok(ignoredNote(r).startsWith("Ignored: page"));
});