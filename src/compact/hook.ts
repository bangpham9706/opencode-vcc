/**
 * The compaction hook: opencode-vcc's replacement for OpenCode's LLM
 * summarizer.
 *
 * OpenCode calls the hook with the conversation it is about to compact and, if
 * the hook sets `event.result`, skips its own model call and uses the supplied
 * summary. `event.result.metadata.keepID` names the first message kept verbatim
 * — OpenCode's counterpart of pi-vcc's `firstKeptEntryId` (verified in
 * packages/core/src/session/compaction.ts: a hook result short-circuits before
 * the runner's own keepID is applied, and history.ts rebuilds the kept tail
 * from `metadata.keepID`).
 *
 * The port keeps pi-vcc's decisions: smart keep-tail, token-budget tail cut,
 * compact-all fallback, ranked brief budget, and the `[section]` summary shape.
 * Differences from pi-vcc, all forced by the host: no `willRetry`/`overflow`
 * distinction at the hook (treated alike), no follow-up auto-continue (OpenCode
 * resumes its own run), and callback-based notifications are dropped.
 */
import type { SummaryMessage } from "../types";
import { textOf } from "../core/content";
import { isCompactionCheckpoint, summaryOfCheckpoint } from "../core/normalize";
import { compileRanked } from "../core/summarize";
import { estimateTokensFromChars } from "../core/token-estimate";
import {
  applyTailBudget,
  buildOwnCut,
  calibrateFromMessages,
  resolveSmartKeepUserTurns,
  toSummarizerInput,
  type CutItem,
} from "./cut";
import {
  estimateMessageChars,
  hasNativeCompaction,
  toSummaryMessages,
  type OcLLMMessage,
} from "../oc/adapter";
import type { SnapStore } from "../oc/snapstore";
import type { VccSettings } from "../oc/settings";
import type { PendingVcc } from "../oc/pending";
import { takePendingFrom } from "../oc/pending";
import { writeDebug } from "../oc/debug";

// Ranked brief budget, as pi-vcc shipped it (hooks/before-compact.ts).
const RANKED_BRIEF_BUDGET_TOKENS = 1100;
const RANKED_BRIEF_CEILING_TOKENS = 2000;
const RANKED_BRIEF_TOKENS_PER_BLOCK = 15;

/** The structural slice of OpenCode's SessionCompaction this hook uses. */
export interface CompactionEvent {
  sessionID: string;
  model?: { providerID?: string; id?: string };
  messages: OcLLMMessage[];
  result?: {
    summary: string;
    metadata?: Record<string, unknown>;
  };
}

export interface CompactionOutcome {
  /** True when opencode-vcc produced the summary; false when it stepped aside. */
  handled: boolean;
  reason:
    | "ok"
    | "skipped_same_provider"
    | "skipped_override_disabled"
    | "skipped_native"
    | "nothing_to_compact";
  summary?: string;
  sections?: string[];
  stats?: {
    summarized: number;
    kept: number;
    keptTokensEst: number;
    keptUserTurns: number;
    totalUserTurns: number;
    smartKeepAdjusted: boolean;
    budgetCut?: string;
    compactAll: boolean;
  };
}

const isCheckpointMessage = (msg: SummaryMessage): boolean =>
  msg.role === "user" && isCompactionCheckpoint(textOf(msg));

/**
 * Build the handler bound to the plugin's settings, index store and the
 * `/vcc` pending map. Returns an outcome for tests; the event is mutated
 * in place, which is what OpenCode reads.
 */
export const createCompactionHandler =
  (settings: VccSettings, store: SnapStore, pending: Map<string, PendingVcc>) =>
  async (event: CompactionEvent): Promise<CompactionOutcome> => {
    // A `/vcc` request is consumed here: it applies to this compaction only.
    const pendingState = takePendingFrom(pending, event.sessionID);
    const isVcc = pendingState !== undefined;

    // A provider-native window is encrypted state, not text this compactor can
    // replace; step aside so the provider's own summary stands. Explicit /vcc
    // is skipped too — a text summary would discard the encrypted window.
    if (settings.skipNativeCompactionModels && hasNativeCompaction(event.messages)) {
      return { handled: false, reason: "skipped_native" };
    }

    const provider = event.model?.providerID ?? "";
    if (!isVcc && provider && settings.skipForProviders.some((p) => p.toLowerCase() === provider.toLowerCase())) {
      return { handled: false, reason: "skipped_same_provider" };
    }
    if (!isVcc && !settings.overrideDefaultCompaction) {
      return { handled: false, reason: "skipped_override_disabled" };
    }

    const messages = toSummaryMessages(event.messages);
    const items: CutItem[] = messages.map((message) => ({
      id: message.id,
      message,
      checkpoint: isCheckpointMessage(message),
    }));

    const previousSummary = items
      .filter((it) => it.checkpoint)
      .map((it) => summaryOfCheckpoint(textOf(it.message)))
      .find((s): s is string => typeof s === "string");

    // Calibration: OpenCode's hook exposes no measured token count, so the
    // heuristic (4 chars/token) applies. `calibrateFromMessages` stays the
    // single source of truth, ready for a token-bearing host.
    const charsPerToken = calibrateFromMessages(messages, () => undefined).charsPerToken;

    const explicit = pendingState?.keepUserTurnsExplicit ?? false;
    const smart = resolveSmartKeepUserTurns({
      live: items,
      requestedKeepUserTurns: explicit ? pendingState!.keepUserTurns : null,
      explicit,
      smartKeepTail: settings.smartKeepTail,
      charsPerToken,
    });

    let cut = buildOwnCut(items, smart.keepUserTurns);
    // Default path only: rescue autonomous / oversized-tail sessions with a
    // token-budget cut. An explicit keep:N is respected absolutely.
    if (cut.ok && !explicit) cut = applyTailBudget(items, cut, { charsPerToken });
    if (!cut.ok) {
      writeDebug(settings, { cancelled: true, reason: cut.reason, liveCount: items.length });
      return { handled: false, reason: "nothing_to_compact" };
    }

    const selected = cut.selected;
    const inputMessages = toSummarizerInput(selected);

    // Index the dropped messages once, session-globally, so emitted (#N) refs
    // resolve in recall. Checkpoints are not counted (they are compaction
    // entries, not messages) and emit no ref.
    const pairs = selected
      .filter((it) => !it.checkpoint && it.id.length > 0)
      .map((it) => ({ id: it.id, message: it.message }));
    const idxMap = await store.ensureIndexed(event.sessionID, pairs);
    const sourceIndices = selected.map((it) => (it.checkpoint ? undefined : idxMap.get(it.id)));

    const summary = compileRanked({
      messages: inputMessages,
      sourceIndices,
      previousSummary,
      trackCommands: settings.trackCommands,
      ranking: {
        maxBriefChars: Math.round(RANKED_BRIEF_BUDGET_TOKENS * charsPerToken),
        maxBriefCharsCeiling: Math.round(RANKED_BRIEF_CEILING_TOKENS * charsPerToken),
        briefCharsPerBlock: Math.round(RANKED_BRIEF_TOKENS_PER_BLOCK * charsPerToken),
      },
    });

    if (!summary) {
      writeDebug(settings, { cancelled: true, reason: "empty_summary" });
      return { handled: false, reason: "nothing_to_compact" };
    }

    const sections = [...summary.matchAll(/^\[(.+?)\]/gm)].map((m) => m[1]);
    const kept = cut.compactAll ? [] : items.slice(selected.length);
    const keptChars = kept.reduce((sum, it) => sum + estimateMessageChars(it.message), 0);
    const keptTokensEst = estimateTokensFromChars(keptChars, charsPerToken);

    const metadata: Record<string, unknown> = {
      compactor: "opencode-vcc",
      version: 2,
      sections,
      sourceMessageCount: inputMessages.length,
      previousSummaryUsed: previousSummary !== undefined,
    };
    if (cut.firstKeptId) {
      // Keep the tail from this message; history.ts rebuilds it verbatim.
      metadata.keepID = cut.firstKeptId;
    } else {
      // Compact-all: no keepID, and pin the stored recent part to nothing so
      // no tail survives.
      metadata.recent = "";
    }

    event.result = { summary, metadata };

    const stats = {
      summarized: inputMessages.length,
      kept: kept.length,
      keptTokensEst,
      keptUserTurns: cut.keptUserTurns,
      totalUserTurns: cut.totalUserTurns,
      smartKeepAdjusted: smart.smartAdjusted,
      budgetCut: cut.budgetCut,
      compactAll: cut.compactAll,
    };

    await store.putCompaction(event.sessionID, String(Date.now()), {
      time: Date.now(),
      reason: isVcc ? "manual" : "auto",
      sections,
      summarized: stats.summarized,
      kept: stats.kept,
      keptTokensEst,
    });

    writeDebug(settings, {
      usedOwnCut: true,
      isVcc,
      keepID: cut.firstKeptId || null,
      compactAll: cut.compactAll,
      budgetCut: cut.budgetCut,
      smartKeepAdjusted: smart.smartAdjusted,
      charsPerToken,
      stats,
      summaryLength: summary.length,
      sections,
    });

    return { handled: true, reason: "ok", summary, sections, stats };
  };