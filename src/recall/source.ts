/**
 * The recall window: everything opencode-vcc can still see for a session,
 * merged from two sources.
 *
 *   - the durable store (src/oc/snapstore.ts): messages dropped by earlier
 *     compactions, each carrying its stable `#N` index;
 *   - the live session context (`ctx.session.context`): the messages still in
 *     the window, translated to canonical SummaryMessages.
 *
 * Every live message is indexed too (assigning new `#N`s in chronological
 * order and persisting them), so recall is one continuous, stable index space
 * across compactions. OpenCode sessions are linear, so scope never forks the
 * window: `widen()` is the same view and `scope:'all'` only changes wording.
 */
import type { SummaryMessage } from "../types";
import type { SnapStore } from "../oc/snapstore";
import { renderMessage, type RenderedEntry } from "../core/render-entries";
import { textOf } from "../core/content";
import { isCompactionCheckpoint } from "../core/normalize";
import type { RecallScope } from "../core/recall-scope";

export interface RecallData {
  rendered: RenderedEntry[];
  messages: SummaryMessage[];
}

/**
 * The session as one recall call sees it. Loads are cached per call and the
 * window is fixed when the view is opened.
 */
export interface RecallView {
  scope: RecallScope;
  load(full: boolean): Promise<RecallData>;
  /** The same session with scope:'all' (itself — OpenCode has no branches). */
  widen(): RecallView;
  /**
   * `#N` of the turn in progress (its last user message and everything after
   * it). Empty when there is no turn in progress or a compaction sits inside
   * it (the turn's start already left the context).
   */
  currentTurn(): Promise<Set<number>>;
}

const isCheckpoint = (msg: SummaryMessage): boolean =>
  msg.role === "user" && isCompactionCheckpoint(textOf(msg));

export interface OpenRecallViewOptions {
  sessionID: string;
  store: SnapStore;
  /** The live canonical messages for the current window, in order. */
  live: SummaryMessage[];
  scope: RecallScope;
}

export const openRecallView = async (opts: OpenRecallViewOptions): Promise<RecallView> => {
  const { sessionID, store, live, scope } = opts;

  // Assign #N to every live message that is not indexed yet, then read the
  // whole session index back (dropped history + live) in index order.
  const pairs = live
    .filter((m) => m.id.length > 0)
    .map((m) => ({ id: m.id, message: m }));
  await store.ensureIndexed(sessionID, pairs);
  const stored = await store.listEntries(sessionID);

  const messages = stored.map((e) => e.message);
  const indices = stored.map((e) => e.idx);

  const cache = new Map<boolean, RecallData>();
  let turn: Promise<Set<number>> | undefined;

  const view: RecallView = {
    scope,
    async load(full) {
      const cached = cache.get(full);
      if (cached) return cached;
      const data: RecallData = {
        rendered: messages.map((msg, i) => renderMessage(msg, indices[i], full)),
        messages,
      };
      cache.set(full, data);
      return data;
    },
    widen() {
      return view;
    },
    currentTurn() {
      return (turn ??= findCurrentTurn());
    },
  };

  async function findCurrentTurn(): Promise<Set<number>> {
    // A compaction in the live walk before any user message means the turn's
    // start already left the context — there is no turn to report.
    for (let i = live.length - 1; i >= 0; i--) {
      if (isCheckpoint(live[i])) return new Set<number>();
      if (live[i].role === "user") break;
    }
    const { rendered } = await view.load(false);
    for (let i = rendered.length - 1; i >= 0; i--) {
      if (rendered[i].role !== "user") continue;
      return i < rendered.length - 1
        ? new Set(rendered.slice(i).map((m) => m.index))
        : new Set<number>();
    }
    return new Set<number>();
  }

  return view;
};