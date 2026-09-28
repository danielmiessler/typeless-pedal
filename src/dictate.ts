// Tap-or-hold dictation, shared by the Stream Deck pedal and the keyboard shortcut.
//   Quick tap  -> toggles dictation (tap to start, tap to stop).
//   Hold       -> starts on press, stops on release.
// Typeless rejects a held shortcut ("Don't hold. Press key once"), so the hold
// is emulated here: the press sends one tap, and a release after HOLD_MS sends
// another. Stateless on purpose: nothing to drift if Typeless stops on its own.
// After a hold ends, we wait for Typeless to finish that dictation and press
// Return, so a held burst is sent as soon as it's pasted. Taps never send.
import { appendFileSync } from "node:fs";
import { Database } from "bun:sqlite";
import { pressEnter, toggleDictation } from "./keystroke.ts";
import { pauseForDictation } from "./pause.ts";

export const HOLD_MS = 400;
const ENTER_AFTER_HOLD = true;
const PASTE_TIMEOUT_MS = 20_000;
const TYPELESS_DB = `${process.env.HOME}/Library/Application Support/Typeless/typeless.db`;
const LOG = `${process.env.HOME}/Library/Logs/TypelessPedal.log`;

export const log = (msg: string) => {
  try { appendFileSync(LOG, `${new Date().toISOString()} ${msg}\n`); } catch {}
};

// Typeless writes one history_v2 row per dictation when recording starts and marks
// it "completed" once the text is pasted. Anything else (cancelled, no speech,
// schema change) means no Enter.
// Only a row that started during this hold counts: a later dictation completing
// must not trigger this hold's Enter.
async function waitForPaste(startedAt: number, endedAt: number): Promise<boolean> {
  const since = new Date(startedAt - 500).toISOString();
  const until = new Date(endedAt).toISOString();
  const deadline = Date.now() + PASTE_TIMEOUT_MS;
  let lastError: unknown = null;
  try {
    const db = new Database(TYPELESS_DB, { readonly: true });
    const q = db.query("select status from history_v2 where created_at >= ? and created_at <= ? order by created_at desc limit 1");
    try {
      while (Date.now() < deadline) {
        // Typeless locks the database while it writes the result; retry until the deadline.
        try {
          const row = q.get(since, until) as { status: string | null } | null;
          if (row?.status === "completed") return true;
          if (row?.status) return false; // dismissed, cancelled, failed
        } catch (e) { lastError = e; }
        await Bun.sleep(100);
      }
    } finally { db.close(); }
  } catch (e) { lastError = e; }
  if (lastError) log(`paste check error: ${lastError}`);
  return false;
}

// Socket the retired TypelessMute.app listened on (src/mute.ts keeps its code).
export const MUTE_SOCKET = `${process.env.HOME}/Library/Application Support/TypelessPedal/mute.sock`;

export async function press(source: string) {
  // Not awaited: its checks run now, before the start tap, and the media key after.
  pauseForDictation(log, source).catch((e) => log(`pause error: ${e}`));
  await toggleDictation();
  log(`${source} down: toggle`);
}

export async function release(source: string, heldMs: number) {
  if (heldMs < HOLD_MS) {
    log(`${source} up after ${heldMs}ms: tap, nothing on release`);
    return;
  }
  const releasedAt = Date.now();
  await toggleDictation();
  log(`${source} up after ${heldMs}ms: hold ends, toggle`);
  if (!ENTER_AFTER_HOLD) return;
  if (await waitForPaste(releasedAt - heldMs, releasedAt)) {
    await Bun.sleep(150);
    await pressEnter();
    log(`${source} pasted: enter`);
  } else {
    log(`${source} no completed dictation: no enter`);
  }
}
