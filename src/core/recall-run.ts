import type { SummaryMessage, SummaryPart } from "../types";
import type { RecallData, RecallView } from "../recall/source";
import { searchEntriesDetailed, getTouchedFiles, type SearchHit } from "./search-entries";
import { formatRecallOutput, formatTouchedOutput, TOUCHED_PAGE_SIZE } from "./format-recall";
import { expandEntryFrom } from "./drill-down";
import type { RecallScope } from "./recall-scope";
import type { RecallRequest } from "./recall-request";

export const SEARCH_PAGE_SIZE = 5;
export const RANGE_PAGE_SIZE = 20;
export const RECENT_COUNT = 25;

export const invalidExpandIndices = (requested: number[], available: Set<number>): number[] =>
  requested.filter((i) => !Number.isInteger(i) || !available.has(i));

/** Surface-specific wording: the tool says page:N, the command says /vcc-recall ... page:N. */
export interface RecallPagingHints {
  outOfRange(query: string, scope: RecallScope, totalPages: number, truncated: boolean): string;
  nextPage(query: string, scope: RecallScope, page: number): string;
  /** Next step after a search page, pointing at its first hit. The command has none. */
  aroundHit?(index: number, scope: RecallScope): string;
  /**
   * Leave the current turn out of search: the agent has it in context, and its
   * question would otherwise match itself. Only the tool sets this; a
   * /vcc-recall command adds no user message, so the last one there belongs to
   * a finished turn.
   */
  skipCurrentTurn?: boolean;
}

const IGNORED_REASON: Record<RecallRequest["action"]["kind"], string> = {
  drill: "a #N:path query runs alone",
  touched: "mode:'touched' runs alone",
  expand: "expand runs alone; send the rest in a separate call",
  range: "range runs alone; send the rest in a separate call",
  search: "",
  recent: "page applies to query or range results",
};

/** One line naming params the action did not use, so nothing is dropped silently. */
export const ignoredNote = (request: RecallRequest): string =>
  (request.dropped?.length ? `Ignored: ${request.dropped.join(", ")}.\n\n` : "") +
  (request.ignored?.length
    ? `Ignored: ${request.ignored.join(", ")} (${IGNORED_REASON[request.action.kind]}).\n\n`
    : "");

export const runRecall = async (request: RecallRequest, view: RecallView, hints: RecallPagingHints): Promise<string> =>
  ignoredNote(request) + (await runAction(request, view, hints));

const runAction = async (request: RecallRequest, view: RecallView, hints: RecallPagingHints): Promise<string> => {
  const { action } = request;
  const scopeAll = view.scope === "all";

  switch (action.kind) {
    case "drill": {
      // expandEntryFrom reports file content from the entry; scope only
      // decides whether the entry is off-path (never, in a linear session).
      const t = action.target;
      const { rendered, messages } = await view.load(true);
      return expandEntryFrom(rendered, messages, t.index, t.pathPattern, t.full, t.offset, t.limit);
    }

    case "touched":
      return runTouched(action.page, view);

    case "expand":
      return runExpand(action.indices, view);

    case "range":
      return runRange(action.range, action.page, view);

    case "search":
      return runSearch(action.query, action.page, view, hints, hints.skipCurrentTurn ? await view.currentTurn() : undefined);

    case "recent": {
      const { rendered } = await view.load(false);
      return (scopeAll ? "Scope: all\n\n" : "") + formatRecallOutput(rendered.slice(-RECENT_COUNT), action.query);
    }
  }
};

/** Tool output shown with an expanded call, clipped so one expand cannot flood the context. */
export const PAIRED_RESULT_CHARS = 4000;

const toolCallIds = (msg: SummaryMessage | undefined): string[] =>
  msg && typeof msg.content !== "string"
    ? msg.content.flatMap((p) => (p.type === "tool-call" && p.callId ? [p.callId] : []))
    : [];

const toolCallParts = (msg: SummaryMessage): Extract<SummaryPart, { type: "tool-call" }>[] =>
  typeof msg.content === "string" ? [] : msg.content.filter((p): p is Extract<SummaryPart, { type: "tool-call" }> => p.type === "tool-call");

const toolResultParts = (msg: SummaryMessage): Extract<SummaryPart, { type: "tool-result" }>[] =>
  typeof msg.content === "string" ? [] : msg.content.filter((p): p is Extract<SummaryPart, { type: "tool-result" }> => p.type === "tool-result");

/**
 * Full text of the requested entries. An expanded tool call brings its tool
 * results along (matched by callId, clipped to PAIRED_RESULT_CHARS), so the
 * agent does not have to know the result sits at a later #N.
 */
const runExpand = async (indices: number[], view: RecallView): Promise<string> => {
  const { rendered, messages } = await view.load(true);
  const lookup = (i: number) => {
    const pos = rendered.findIndex((m) => m.index === i);
    return pos >= 0 ? { entry: rendered[pos], raw: messages[pos], pos } : undefined;
  };

  const found = indices.map((i) => ({ i, hit: Number.isInteger(i) ? lookup(i) : undefined }));
  const invalid = found.filter((f) => !f.hit).map((f) => f.i);
  if (invalid.length > 0) return `Cannot expand indices outside session history: ${invalid.join(", ")}`;

  const requested = new Set(indices);
  const out: SearchHit[] = [];
  for (const { hit } of found) {
    const { entry, raw, pos } = hit!;
    out.push(entry);
    const ids = new Set(toolCallIds(raw));
    if (ids.size === 0) continue;
    for (let j = pos + 1; j < rendered.length && ids.size > 0; j++) {
      const r = messages[j];
      // A call's results come before the next assistant message; past it, a
      // reused id (after an interrupted call) belongs to a later call.
      if (toolCallParts(r).length > 0) break;
      for (const part of toolResultParts(r)) {
        if (!part.callId || !ids.has(part.callId)) continue;
        ids.delete(part.callId);
        const res = rendered[j];
        if (requested.has(res.index)) continue;
        const summary = res.summary.length > PAIRED_RESULT_CHARS
          ? `${res.summary.slice(0, PAIRED_RESULT_CHARS)}\n...[result of #${entry.index} clipped at ${PAIRED_RESULT_CHARS} of ${res.summary.length} chars; expand:[${res.index}] for all of it]`
          : res.summary;
        out.push({ ...res, summary });
      }
    }
  }

  const header = `Expanded ${indices.map((i) => `#${i}`).join(", ")}`;
  return (view.scope === "all" ? "Scope: all\n\n" : "") + formatRecallOutput(out, undefined, header);
};

/**
 * Entries #from..#to in order, RANGE_PAGE_SIZE per page, same per-entry clip
 * as search and recent. Indices are the global #N space shared with summaries,
 * so a ref copied from a summary lands on its message.
 */
const runRange = async (range: unknown[], page: number, view: RecallView): Promise<string> => {
  const [from, to] = range;
  if (range.length !== 2 || !Number.isInteger(from) || !Number.isInteger(to) || (from as number) < 0 || (from as number) > (to as number)) {
    return `Invalid range ${JSON.stringify(range)}: use range:[from, to] with two #N indices, from <= to.`;
  }
  const lo = from as number;
  let hi = to as number;
  const scopeAll = view.scope === "all";
  const { rendered } = await view.load(false);
  const entries = rendered.filter((m) => m.index >= lo && m.index <= hi);

  if (entries.length === 0) {
    const last = rendered[rendered.length - 1];
    return `No messages #${lo}..#${hi} in session history${last ? ` (last entry is #${last.index})` : ""}.`;
  }

  // A range past the end is read up to the last entry, and the header says so.
  const lastIndex = rendered[rendered.length - 1].index;
  const clamped = hi > lastIndex;
  if (clamped) hi = lastIndex;

  const totalPages = Math.ceil(entries.length / RANGE_PAGE_SIZE);
  const counts = `${entries.length} messages${scopeAll ? ", scope: all" : ""}${clamped ? `, #${hi} is the last entry` : ""}`;
  if (page > totalPages) {
    return `Page ${page} is outside the available range 1-${totalPages} (#${lo}..#${hi}: ${counts}). Use a page between 1 and ${totalPages}.`;
  }
  const start = (page - 1) * RANGE_PAGE_SIZE;
  const header = totalPages > 1
    ? `Range #${lo}..#${hi}, page ${page}/${totalPages} (${counts})`
    : `Range #${lo}..#${hi} (${counts})`;
  const footer = page < totalPages
    ? `\n--- Use range:[${lo}, ${hi}] page:${page + 1}${scopeAll ? " scope:'all'" : ""} for the next ${RANGE_PAGE_SIZE} ---`
    : "";
  return formatRecallOutput(entries.slice(start, start + RANGE_PAGE_SIZE), undefined, header) + footer;
};

/**
 * Search with the current turn left out of the corpus, not just out of the
 * results: filtering afterwards let turn entries win the regex path (so the
 * term fallback never ran), set the relative floor, and fill the hit cap,
 * which hid earlier matches.
 */
const searchBefore = (data: RecallData, query: string, skip: Set<number> | undefined) => {
  const { rendered, messages } = data;
  if (!skip?.size) return searchEntriesDetailed(rendered, messages, query);
  const keep = rendered.map((m) => !skip.has(m.index));
  return searchEntriesDetailed(rendered.filter((_, i) => keep[i]), messages.filter((_, i) => keep[i]), query);
};

const runSearch = async (query: string, page: number, view: RecallView, hints: RecallPagingHints, skip?: Set<number>): Promise<string> => {
  const data = await view.load(false);
  const { hits, totalBeforeCap, truncated } = searchBefore(data, query, skip);
  if (hits.length === 0 && skip?.size) {
    const inTurn = searchEntriesDetailed(data.rendered, data.messages, query).hits
      .filter((h) => skip.has(h.index)).length;
    if (inTurn > 0) {
      return `No earlier matches for "${query}"; its ${inTurn} match${inTurn === 1 ? " is" : "es are"} in the current turn, which is already in your context.`;
    }
  }
  // Single source of truth for page count: hits.length, the same array
  // that's actually paginated below (already floor-filtered and capped).
  const totalPages = Math.ceil(hits.length / SEARCH_PAGE_SIZE);
  const scopeSuffix = view.scope === "all" ? " (scope: all)" : "";
  // The hard cap can discard genuine matches; hits.length alone would then
  // understate the real total. Say so explicitly. Neutral wording ("showing",
  // not "showing top"): regex-path hits are chronological with no relevance
  // score, so "top" would falsely imply a ranking only the BM25 path has.
  const truncationNote = truncated
    ? ` — showing ${hits.length} of ${totalBeforeCap} matches, refine your query for more precise results`
    : "";

  // The hard cap creates a fixed reachable page range (1..totalPages). A page
  // beyond it isn't "no matches": say which pages exist instead of falling
  // through to formatRecallOutput's zero-hit message, which would be false.
  if (hits.length > 0 && page > totalPages) {
    return `Page ${page} is outside the available range 1-${totalPages} ` +
      `(${hits.length} matches${scopeSuffix}${truncationNote}). ` +
      hints.outOfRange(query, view.scope, totalPages, truncated);
  }

  const start = (page - 1) * SEARCH_PAGE_SIZE;
  const pageHits = hits.slice(start, start + SEARCH_PAGE_SIZE);
  const header = totalPages > 1
    ? `Page ${page}/${totalPages} (${hits.length} total matches${scopeSuffix}${truncationNote})`
    : `${hits.length} matches${scopeSuffix}${truncationNote}`;
  const around = pageHits.length > 0 && hints.aroundHit ? hints.aroundHit(pageHits[0].index, view.scope) : "";
  const footer = page < totalPages ? hints.nextPage(query, view.scope, page + 1) : "";
  return formatRecallOutput(pageHits, query, header) + around + footer;
};

const WRITES_FILE = /write|edit|patch/i;

/** Files worked on, plus a ready #N:path call for the first file on the page that was written. */
const runTouched = async (page: number | undefined, view: RecallView): Promise<string> => {
  const { rendered, messages } = await view.load(false);
  const touched = getTouchedFiles(messages, rendered);
  const text = formatTouchedOutput(touched, page);
  const start = (Math.max(1, page ?? 1) - 1) * TOUCHED_PAGE_SIZE;
  for (const tf of touched.slice(start, start + TOUCHED_PAGE_SIZE)) {
    const write = [...tf.entries].reverse().find((e) => WRITES_FILE.test(e.toolName));
    if (!write) continue;
    const name = tf.path.replace(/\\/g, "/").split("/").pop();
    return `${text}\n--- File content at an entry: query:'#${write.index}:${name}' ---`;
  }
  return text;
};