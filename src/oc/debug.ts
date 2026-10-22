/**
 * The debug sink. With `debug: true` the plugin writes what it did to
 * `<tmp>/opencode-vcc-debug.json`: which tools it registered, and for every
 * compaction the cut, the sections and the token calibration.
 *
 * The file is merged, not overwritten: the setup writes the registration
 * info once, each compaction adds its own key.
 */
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import type { VccSettings } from "./settings";

export const DEBUG_FILE = join(tmpdir(), "opencode-vcc-debug.json");

export const writeDebug = (settings: VccSettings, data: Record<string, unknown>): void => {
  if (!settings.debug) return;
  try {
    let existing: Record<string, unknown> = {};
    try {
      const raw = JSON.parse(readFileSync(DEBUG_FILE, "utf8"));
      if (raw && typeof raw === "object" && !Array.isArray(raw)) existing = raw as Record<string, unknown>;
    } catch {
      // No file yet, or it is not readable as JSON: start from scratch.
    }
    writeFileSync(DEBUG_FILE, JSON.stringify({ ...existing, ...data }, null, 2));
  } catch {
    // Debug output must never break the plugin.
  }
};
