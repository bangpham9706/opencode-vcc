/**
 * opencode-vcc settings. pi-vcc read a JSON file from Pi's agent dir; the
 * OpenCode port reads the plugin's `options` from opencode.json(c):
 *
 *   { "plugins": [{ "package": "opencode-vcc", "options": { "debug": true } }] }
 *
 * Every value is validated and coerced, defaulting to the pi-vcc defaults.
 */
import type { PluginOptions } from "@opencode/plugin";

export interface VccSettings {
  /**
   * When true (default), opencode-vcc handles every compaction: `/compact`,
   * automatic (threshold/overflow), and `/vcc`. When false it only handles
   * `/vcc`, and OpenCode's own LLM summarizer keeps everything else.
   */
  overrideDefaultCompaction: boolean;
  /**
   * When true (default), boost the default kept tail when the keep:1 tail is
   * small: if its estimate is <= MIN_SMART_TAIL_TOKENS (5k), grow keep to the
   * largest N whose tail stays <= MAX_SMART_TAIL_TOKENS (25k). An explicit
   * `keep:N` is always respected.
   */
  smartKeepTail: boolean;
  /** Write a debug snapshot to the OpenCode temp dir on each compaction. */
  debug: boolean;
  /** Provider ids for which opencode-vcc steps aside (case-insensitive). */
  skipForProviders: string[];
  /**
   * Models whose provider uses native compaction are skipped by default: the
   * window is encrypted provider state, not text this compactor can replace.
   * Set false to try anyway. Explicit `/vcc` can still be skipped; the provider
   * decides whether a text summary is acceptable.
   */
  skipNativeCompactionModels: boolean;
  /**
   * Commands whose invocations are kept in a "[Tracked Commands]" section,
   * e.g. `["ssh", "kubectl"]`, `["gh pr"]`. Empty by default (off).
   */
  trackCommands: string[];
}

export const DEFAULT_SETTINGS: VccSettings = {
  overrideDefaultCompaction: true,
  smartKeepTail: true,
  debug: false,
  skipForProviders: [],
  skipNativeCompactionModels: true,
  trackCommands: [],
};

const coerceStringArray = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

export const loadSettings = (options: PluginOptions | undefined): VccSettings => {
  const src = (options ?? {}) as Record<string, unknown>;
  const merged: VccSettings = {
    overrideDefaultCompaction: typeof src.overrideDefaultCompaction === "boolean"
      ? src.overrideDefaultCompaction
      : DEFAULT_SETTINGS.overrideDefaultCompaction,
    smartKeepTail: typeof src.smartKeepTail === "boolean" ? src.smartKeepTail : DEFAULT_SETTINGS.smartKeepTail,
    debug: typeof src.debug === "boolean" ? src.debug : DEFAULT_SETTINGS.debug,
    skipNativeCompactionModels: typeof src.skipNativeCompactionModels === "boolean"
      ? src.skipNativeCompactionModels
      : DEFAULT_SETTINGS.skipNativeCompactionModels,
    skipForProviders: coerceStringArray(src.skipForProviders),
    trackCommands: [
      ...new Set(coerceStringArray(src.trackCommands).map((s) => s.trim()).filter(Boolean)),
    ],
  };
  return merged;
};