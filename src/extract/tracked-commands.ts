import type { NormalizedBlock } from "../types";
import { capItems } from "../core/format";

/** Maximum characters kept per captured entry (a truncated one-liner, not a
 * parsed structure -- deliberately shallow, see module docstring below). */
const MAX_ENTRY_CHARS = 80;

/** Single-pass quote-aware scan: returns the index of every UNQUOTED
 * shell separator (`;`, `&`, `|`, newline). Quote state tracks ' and "
 * plus backslash escapes; separators inside quotes are not boundaries.
 * Deliberately stops there -- $( ) and backticks are not handled, keeping
 * this a 20-line tokenizer rather than a shell parser. */
const unquotedSeparators = (cmd: string): number[] => {
  const seps: number[] = [];
  let quote: string | null = null;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (quote) {
      // Backslash escapes inside "..." only; inside '...' it is literal.
      if (c === "\\" && quote === '"') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === "\\") i++; // `it\'s` is not an opening quote
    else if (c === "'" || c === '"') quote = c;
    // A comment runs to the newline; its apostrophes (`# don't`) are not quotes.
    else if (c === "#" && (i === 0 || /[\s;&|(]/.test(cmd[i - 1]))) {
      while (i + 1 < cmd.length && cmd[i + 1] !== "\n") i++;
    }
    // `2>&1`, `<&3`, `&>file` are redirections, not separators.
    else if (c === "&" && (cmd[i - 1] === ">" || cmd[i - 1] === "<" || cmd[i + 1] === ">")) continue;
    else if (c === ";" || c === "&" || c === "|" || c === "\n") seps.push(i);
  }
  return seps;
};

/** Cut `text` at the next UNQUOTED separator. Quotes are kept as written:
 * the cut never lands inside a quote, so they stay balanced. No truncation
 * here -- dedup must see the full string (two distinct invocations sharing
 * an 80-char prefix must not collapse); render-time truncation lives in
 * formatTrackedCommands. */
const captureEntry = (text: string): string => {
  const seps = unquotedSeparators(text);
  const cut = seps.length ? text.slice(0, seps[0]) : text;
  return cut.trim();
};

/** Prefixes that hide the real command name: `VAR=val` assignments and a
 * tiny, decades-stable wrapper list (sudo/env/nohup/time/command) — NOT a
 * growing per-CLI taxonomy. They are skipped only to find the name; the
 * entry keeps them (see findTopLevelInvocations). */
const WRAPPERS = new Set(["sudo", "env", "nohup", "time", "command"]);
const WRAPPER_VALUE_FLAGS: Record<string, RegExp> = {
  sudo: /^-[ugpCDRT]$/, // -u user -g group -p prompt -C fd -D dir -R? -T
  env: /^-[uS]$/,       // -u name, -S split-string
};

/** Next token from pos on the same line: a newline is a separator, so a
 * lone `VAR=x` line must not borrow the command on the next one. */
const tokenAt = (cmd: string, pos: number): [string, number] => {
  while (pos < cmd.length && (cmd[pos] === " " || cmd[pos] === "\t")) pos++;
  const t = cmd.slice(pos).match(/^\S+/)?.[0] ?? "";
  return [t, pos];
};

/** Skip VAR=val prefixes and wrapper-command invocations starting at pos;
 * returns the position where the real command begins. */
const skipToCommand = (cmd: string, pos: number): number => {
  for (;;) {
    const [tok, at] = tokenAt(cmd, pos);
    if (!tok) return at;
    if (/^[A-Za-z_]\w*=/.test(tok)) { pos = at + tok.length; continue; }
    if (!WRAPPERS.has(tok)) return at;
    pos = at + tok.length;
    for (;;) {
      const [flag, fat] = tokenAt(cmd, pos);
      if (!flag.startsWith("-")) break;
      pos = fat + flag.length;
      if (WRAPPER_VALUE_FLAGS[tok]?.test(flag)) {
        const [value, vat] = tokenAt(cmd, pos); // consume the flag's value
        pos = vat + value.length;
      }
    }
  }
};

/** Positions where an invocation of `name` begins: position 0 or right
 * after an UNQUOTED separator, so `echo "a; docker restart"` is not an
 * invocation. Requires whitespace (or end of string) right after `name`, so
 * `ssh-keygen`/`docker-compose` don't match `ssh`/`docker`. Returns the
 * START of the segment (before any VAR=/wrapper prefixes), not the name
 * itself, so the recorded entry stays faithful to what actually ran
 * (`sudo -u root kubectl get pods` is recorded whole). */
const findTopLevelInvocations = (cmd: string, name: string): number[] => {
  const bounds = [0, ...unquotedSeparators(cmd).map((i) => i + 1)];
  const starts: number[] = [];
  for (const bound of bounds) {
    const pos = skipToCommand(cmd, bound);
    if (!cmd.startsWith(name, pos)) continue;
    const after = cmd[pos + name.length];
    if (after === undefined || /\s/.test(after)) starts.push(bound);
  }
  return starts;
};

/** ssh flags that take NO argument; every other leading `-flag` consumes
 * the next token. Without this, `ssh -T host 'cmd'` misreads `host` as
 * -T's value and the remote command is never found. Clusters (`-tt`, `-NT`)
 * count as boolean when every letter is one. */
const SSH_BOOL_FLAG = /^-[46ACfGgKkMNTtVvXxYynaq]+$/;

/** Locate the SSH target by TOKEN POSITION (via matchAll's own `.index`,
 * never a substring re-search, which would misfire on e.g.
 * `ssh -i key-prod prod ...` finding "prod" inside "key-prod") and return
 * everything after it, trimmed. */
const sshRemoteCommand = (afterSsh: string): string | undefined => {
  const tokens = [...afterSsh.matchAll(/\S+/g)];
  let i = 0;
  while (i < tokens.length && tokens[i][0].startsWith("-")) {
    i += SSH_BOOL_FLAG.test(tokens[i][0]) ? 1 : 2;
  }
  const target = tokens[i];
  if (!target) return undefined;
  const rest = afterSsh.slice(target.index! + target[0].length).trim();
  return rest || undefined;
};

export interface TrackedCommandActivity {
  /** Command name (as configured in settings.trackCommands) -> entries seen. */
  byCommand: Map<string, Set<string>>;
}

/**
 * Scans bash tool-call commands for invocations of any command name in
 * `trackCommands`, capturing a one-line snapshot per match --
 * deliberately shallow (no per-command argument parsing) so this never
 * needs updating as any given CLI's flags evolve, unlike a design that
 * tries to extract structured fields (e.g. "the kubectl namespace" or "the
 * docker container name") for each tool separately.
 *
 * When "ssh" is one of the tracked names, also scans inside its own
 * remote-command argument (quoted or not) for other tracked names --
 * running a command over SSH is as common as running it locally, and a
 * top-level-only scan would otherwise miss it.
 *
 * Only matches literal command text, never tool_result output.
 */
export const extractTrackedCommands = (
  blocks: NormalizedBlock[],
  trackCommands: readonly string[],
): TrackedCommandActivity => {
  const byCommand = new Map<string, Set<string>>();
  if (trackCommands.length === 0) return { byCommand };
  for (const name of trackCommands) byCommand.set(name, new Set());

  const trackSsh = trackCommands.includes("ssh");

  for (const b of blocks) {
    if (b.kind !== "tool_call" || b.name !== "bash") continue;
    const cmd = typeof b.args.command === "string" ? b.args.command : "";
    if (!cmd) continue;

    for (const name of trackCommands) {
      for (const startAt of findTopLevelInvocations(cmd, name)) {
        const item = captureEntry(cmd.slice(startAt).trim());
        if (!item) continue;
        const set = byCommand.get(name)!;
        // re-running the same command refreshes it to the tail — the cap
        // then keeps the N most-recently-USED, not first-seen.
        if (set.has(item)) set.delete(item);
        set.add(item);
      }
    }

    if (trackSsh) {
      for (const bound of findTopLevelInvocations(cmd, "ssh")) {
        // bounds are segment starts (incl. wrappers); the ssh token itself
        // sits at skipToCommand — slice past it for the remote parser.
        const seg = cmd.slice(bound);
        const remote = sshRemoteCommand(seg.slice(skipToCommand(seg, 0) + 3));
        if (!remote) continue;
        // The remote string's quotes were the LOCAL shell's syntax, not
        // the remote command's — a leftover stray ' would open a phantom
        // quote in the rescanner and swallow the rest of the line. Strip
        // them all; boundary detection stays shallow regardless.
        const unquoted = remote.replace(/['"]/g, "");
        for (const name of trackCommands) {
          if (name === "ssh") continue;
          for (const startAt2 of findTopLevelInvocations(unquoted, name)) {
            const item = captureEntry(unquoted.slice(startAt2).trim());
            if (!item) continue;
            const set = byCommand.get(name)!;
            if (set.has(item)) set.delete(item);
            set.add(item);
          }
        }
      }
    }
  }

  return { byCommand };
};

/** Line format of `[Tracked Commands]`, shared with the merge in
 * core/summarize.ts: `- <name>: <entry> | <entry> ...`, newest
 * COMMANDS_PER_NAME kept. " | " rather than "," since an entry (e.g.
 * `kubectl get pods,svc`) can legitimately contain a comma. */
export const COMMAND_SEPARATOR = " | ";
export const COMMANDS_PER_NAME = 10;

/** Render form: one line (a quoted multi-line argument such as
 * `python3 -c '...'` would otherwise break the line format), with an inner
 * separator escaped as ` \| ` so the merge, which splits on
 * COMMAND_SEPARATOR, keeps the entry whole. Then truncated. */
const renderEntry = (entry: string): string => {
  const line = entry.replace(/\s+/g, " ").replaceAll(COMMAND_SEPARATOR, " \\| ");
  return line.length > MAX_ENTRY_CHARS ? `${line.slice(0, MAX_ENTRY_CHARS)}…` : line;
};

/** Formats TrackedCommandActivity into `[Tracked Commands]` body lines, one per
 * tracked command name that had at least one match. Keeps the NEWEST
 * entries: a ledger of what was run recently must not freeze at its first
 * ten while everything later drowns in a permanent "(+N more)". */
export const formatTrackedCommands = (act: TrackedCommandActivity): string[] => {
  const lines: string[] = [];
  for (const [name, entries] of act.byCommand) {
    if (entries.size > 0) {
      lines.push(`${name}: ${capItems([...entries].map(renderEntry), COMMANDS_PER_NAME, COMMAND_SEPARATOR, "tail")}`);
    }
  }
  return lines;
};
