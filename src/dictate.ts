// Tap-or-hold dictation, shared by the Stream Deck pedal and the keyboard shortcut.
//   Quick tap  -> toggles dictation (tap to start, tap to stop).
//   Hold       -> starts on press, stops on release.
// Typeless rejects a held shortcut ("Don't hold. Press key once"), so the hold
// is emulated here: the press sends one tap, and a release after HOLD_MS sends
// another. Nothing is tracked: whether a press starts or stops a dictation is read
// from CoreAudio (is Typeless's input running?), so nothing drifts if Typeless stops
// on its own. A press that stops a dictation does nothing on release.
// After a hold ends, we wait for Typeless to finish that dictation and press
// Return, so a held burst is sent as soon as it's pasted. Taps never send.
import { appendFileSync } from "node:fs";
import { Database } from "bun:sqlite";
import { pressEnter, toggleDictation, uptimeNs } from "./keystroke.ts";
import { typelessRecording } from "./audio.ts";
import * as preroll from "./preroll.ts";
import type { Drained } from "./preroll.ts";

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

const ms = (ns: bigint) => (Number(ns) / 1e6).toFixed(1);

// Typeless opens the mic well after the tap. Timing it on every start press keeps the
// real delay visible: speech before "mic live" is not in the recording. A stop tap
// finds the mic already running and logs nothing.
async function watchMic(source: string, downAt: bigint) {
  if (typelessRecording()) return;
  const deadline = downAt + 3_000_000_000n;
  while (uptimeNs() < deadline) {
    await Bun.sleep(2);
    if (typelessRecording()) return log(`${source} mic live ${ms(uptimeNs() - downAt)}ms after the tap`);
  }
  log(`${source} mic not live 3s after the tap`);
}

// With the preroll bridge, Typeless hears the dictation a little behind real time, so a
// stop tap first waits until everything said so far has been played to it.
async function drainBeforeStop(source: string): Promise<Drained | null> {
  const d = await preroll.drain();
  if (d) log(`${source} drained ${d.waitedMs}ms before the stop`);
  return d;
}

// Whether each source's current press stopped a dictation; its release then does nothing.
const pressStopped = new Map<string, boolean>();

// pressedAt is when the press happened, on the uptime clock (the keyboard passes the
// key event's own timestamp), so the log shows how long our side took to tap.
export async function press(source: string, pressedAt = uptimeNs()) {
  const stopping = typelessRecording();
  pressStopped.set(source, stopping);
  if (stopping) await drainBeforeStop(source);
  else preroll.arm().then((r) => { if (r === null) log(`${source} preroll helper not answering`); });
  const downAt = await toggleDictation();
  log(`${source} down: toggle (${stopping ? "stop" : "start"}), tapped ${ms(downAt - pressedAt)}ms after the press`);
  if (!stopping) watchMic(source, downAt).catch((e) => log(`mic watch error: ${e}`));
}

export async function release(source: string, heldMs: number) {
  if (heldMs < HOLD_MS) {
    log(`${source} up after ${heldMs}ms: tap, nothing on release`);
    return;
  }
  if (pressStopped.get(source)) {
    log(`${source} up after ${heldMs}ms: that press stopped a dictation, nothing on release`);
    return;
  }
  const releasedAt = Date.now();
  const drained = await drainBeforeStop(source);
  // Typeless never started (its start tap was lost): a tap now would start one.
  if (drained && !drained.typelessRead && !typelessRecording()) {
    log(`${source} up after ${heldMs}ms: Typeless never started, nothing to stop`);
    return;
  }
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
