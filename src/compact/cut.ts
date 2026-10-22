/**
 * Port of pi-vcc's cut engine (hooks/before-compact.ts) to OpenCode.
 *
 * OpenCode hands the compaction hook the live window directly — history loads
 * from the latest completed compaction, so there are no branch entries to
 * collect. The hook chooses the same things pi-vcc chose:
 *   - which prefix is summarized (everything before the kept tail), and
 *   - the first message of the kept tail, returned as `metadata.keepID`
 *     (OpenCode's counterpart of `firstKeptEntryId`).
 */
import type { SummaryMessage } from "../types";
import { normalize } from "../core/normalize";
import { recentContextOfCheckpoint } from "../core/normalize";
import { estimateMessageChars } from "../oc/adapter";
import { calibrateCharsPerToken, estimateTokensFromChars } from "../core/token-estimate";

export type BudgetCutKind = "no_anchor" | "oversized_tail";
export const OVERSIZED_TAIL_FACTOR = 2.5;
export const MIN_SMART_TAIL_TOKENS = 5_000;
export const MAX_SMART_TAIL_TOKENS = 25_000;

/** One live message plus the metadata the cut needs. */
export interface CutItem {
  id: string;
  message: SummaryMessage;
  /** The previous compaction's rendered checkpoint (a user message, not a turn). */
  checkpoint: boolean;
}

export type CutCancelReason = "no_live_messages" | "too_few_live_messages";

export type CutResult =
  | {
      ok: true;
      /** Items to summarize, in order. */
      selected: CutItem[];
      /** First kept message id, or "" when nothing is kept (compact-all). */
      firstKeptId: string;
      compactAll: boolean;
      keptUserTurns: number;
      totalUserTurns: number;
      requestedKeepUserTurns: number;
      keepFallbackToCompactAll: boolean;
      budgetCut?: BudgetCutKind;
    }
  | { ok: false; reason: CutCancelReason };

export const isUserTurn = (item: CutItem): boolean => item.message.role === "user" && !item.checkpoint;

/**
 * The summarizer input for a window. A previous checkpoint contributes only
 * its verbatim recent-context part: its summary is carried forward by the
 * section merge (previousSummary) instead of being summarized twice.
 */
export const toSummarizerInput = (items: readonly CutItem[]): SummaryMessage[] =>
  items.map((item) => {
    if (!item.checkpoint) return item.message;
    if (typeof item.message.content !== "string") return { ...item.message, content: [] };
    const recent = recentContextOfCheckpoint(item.message.content);
    return { ...item.message, content: recent ?? "" };
  });

const renders = (items: readonly CutItem[]): boolean => normalize(toSummarizerInput(items)).length > 0;

const normalizeKeepUserTurns = (keepUserTurns: number): number => {
  if (!Number.isFinite(keepUserTurns)) return 0;
  return Math.max(0, Math.floor(keepUserTurns));
};

export function buildOwnCut(live: readonly CutItem[], keepUserTurns = 1): CutResult {
  const normalizedKeep = normalizeKeepUserTurns(keepUserTurns);

  if (live.length === 0) return { ok: false, reason: "no_live_messages" };
  if (live.length <= 2) return { ok: false, reason: "too_few_live_messages" };
  if (!renders(live)) return { ok: false, reason: "no_live_messages" };

  const userIndices = live.reduce<number[]>((acc, item, i) => {
    if (isUserTurn(item)) acc.push(i);
    return acc;
  }, []);

  const compactAll = (keepFallbackToCompactAll: boolean): CutResult => ({
    ok: true,
    selected: [...live],
    firstKeptId: "",
    compactAll: true,
    keptUserTurns: 0,
    totalUserTurns: userIndices.length,
    requestedKeepUserTurns: normalizedKeep,
    keepFallbackToCompactAll,
  });

  if (normalizedKeep <= 0) return compactAll(false);

  const targetUserIdx = userIndices.length - normalizedKeep;
  const cutIdx = targetUserIdx >= 0 ? userIndices[targetUserIdx] : -1;

  // No safe user boundary (no user turn, single prompt, or keep beyond the
  // available turns): compact everything, keep no tail.
  if (cutIdx <= 0) return compactAll(true);
  if (!renders(live.slice(0, cutIdx))) return compactAll(true);

  return {
    ok: true,
    selected: live.slice(0, cutIdx),
    firstKeptId: live[cutIdx].id,
    compactAll: false,
    keptUserTurns: userIndices.length - targetUserIdx,
    totalUserTurns: userIndices.length,
    requestedKeepUserTurns: normalizedKeep,
    keepFallbackToCompactAll: false,
  };
}

const tokensOf = (item: CutItem, charsPerToken?: number): number =>
  estimateTokensFromChars(estimateMessageChars(item.message), charsPerToken);

// ── token-budget tail cut ──

export const findBudgetCutIndex = (
  live: readonly CutItem[],
  maxTokens: number,
  charsPerToken?: number,
): number => {
  let acc = 0;
  let crossed = -1;
  for (let i = live.length - 1; i >= 0; i--) {
    acc += tokensOf(live[i], charsPerToken);
    if (acc >= maxTokens) {
      crossed = i;
      break;
    }
  }
  if (crossed < 0) return -1;
  // Snap forward off a tool-result message to the next valid boundary.
  for (let j = Math.max(crossed, 1); j < live.length; j++) {
    if (live[j].message.role !== "tool") return j;
  }
  return -1;
};

export const applyTailBudget = (
  live: readonly CutItem[],
  cut: CutResult,
  opts: { maxTokens?: number; oversizedFactor?: number; charsPerToken?: number } = {},
): CutResult => {
  if (!cut.ok) return cut;
  const maxTokens = opts.maxTokens ?? MAX_SMART_TAIL_TOKENS;
  const factor = opts.oversizedFactor ?? OVERSIZED_TAIL_FACTOR;
  const budgetResult = (idx: number, budgetCut: BudgetCutKind): CutResult => ({
    ok: true,
    selected: live.slice(0, idx),
    firstKeptId: live[idx].id,
    compactAll: false,
    keptUserTurns: live.slice(idx).filter(isUserTurn).length,
    totalUserTurns: live.filter(isUserTurn).length,
    requestedKeepUserTurns: cut.requestedKeepUserTurns,
    keepFallbackToCompactAll: false,
    budgetCut,
  });

  // Case A: no user anchor → compact-all. Re-cut to a token budget unless the
  // compact-all came from explicit keep:0 (which is respected absolutely).
  if (cut.compactAll) {
    if (!cut.keepFallbackToCompactAll) return cut;
    const idx = findBudgetCutIndex(live, maxTokens, opts.charsPerToken);
    if (idx < 0 || !renders(live.slice(0, idx))) return cut;
    return budgetResult(idx, "no_anchor");
  }

  // Case B: oversized user-boundary tail.
  const tailStart = cut.selected.length;
  let tailTokens = 0;
  for (let i = tailStart; i < live.length; i++) tailTokens += tokensOf(live[i], opts.charsPerToken);
  if (tailTokens <= maxTokens * factor) return cut;
  const idx = findBudgetCutIndex(live, maxTokens, opts.charsPerToken);
  if (idx <= tailStart) return cut;
  return budgetResult(idx, "oversized_tail");
};

// ── smart keep-tail ──

export interface ResolveSmartKeepOptions {
  live: readonly CutItem[];
  /** Requested keep:N; null when the user did not specify (default path). */
  requestedKeepUserTurns: number | null;
  /** True when the user typed keep:N explicitly — always respected. */
  explicit: boolean;
  smartKeepTail: boolean;
  minTokens?: number;
  maxTokens?: number;
  charsPerToken?: number;
}

export interface ResolveSmartKeepResult {
  keepUserTurns: number;
  smartAdjusted: boolean;
  fromKeep: number;
}

/** Tail tokens for a keep:N, or null when it would trigger compact-all/cancel. */
const tailTokensForKeep = (live: readonly CutItem[], keepUserTurns: number, charsPerToken?: number): number | null => {
  const cut = buildOwnCut(live, keepUserTurns);
  if (!cut.ok || cut.compactAll) return null;
  const idx = live.findIndex((item) => item.id === cut.firstKeptId);
  if (idx < 0) return null;
  return live.slice(idx).reduce((sum, item) => sum + tokensOf(item, charsPerToken), 0);
};

export const resolveSmartKeepUserTurns = (opts: ResolveSmartKeepOptions): ResolveSmartKeepResult => {
  const minTokens = opts.minTokens ?? MIN_SMART_TAIL_TOKENS;
  const maxTokens = opts.maxTokens ?? MAX_SMART_TAIL_TOKENS;
  const baseKeep = opts.requestedKeepUserTurns ?? 1;

  if (opts.explicit || !opts.smartKeepTail) {
    return { keepUserTurns: baseKeep, smartAdjusted: false, fromKeep: baseKeep };
  }

  const baseTokens = tailTokensForKeep(opts.live, baseKeep, opts.charsPerToken);
  if (baseTokens == null || baseTokens > minTokens) {
    return { keepUserTurns: baseKeep, smartAdjusted: false, fromKeep: baseKeep };
  }

  const baseCut = buildOwnCut(opts.live, baseKeep);
  const totalUserTurns = baseCut.ok ? baseCut.totalUserTurns : 0;

  let selected = baseKeep;
  for (let k = baseKeep + 1; k <= totalUserTurns; k++) {
    const tokens = tailTokensForKeep(opts.live, k, opts.charsPerToken);
    if (tokens == null || tokens > maxTokens) break;
    selected = k;
  }

  return { keepUserTurns: selected, smartAdjusted: selected !== baseKeep, fromKeep: baseKeep };
};

// ── calibration ──

/**
 * Measure chars-per-token from the newest measured assistant message in the
 * window (OpenCode reports real token usage on assistant messages), falling
 * back to the heuristic when no reliable measurement exists.
 */
export const calibrateFromMessages = (
  messages: readonly SummaryMessage[],
  tokensOfMessage: (msg: SummaryMessage) => number | undefined,
): ReturnType<typeof calibrateCharsPerToken> => {
  let chars = 0;
  for (const msg of messages) {
    chars += estimateMessageChars(msg);
    const tokens = tokensOfMessage(msg);
    if (tokens && tokens > 0 && chars > 0) return calibrateCharsPerToken(chars, tokens);
  }
  return calibrateCharsPerToken(0, undefined);
};