// Tap-or-hold dictation, shared by the Stream Deck pedal and the keyboard shortcut.
//   Quick tap  -> toggles dictation (tap to start, tap to stop).
//   Hold       -> starts on press, stops on release.
// Typeless rejects a held shortcut ("Don't hold. Press key once"), so the hold
// is emulated here: the press sends one tap, and a release after HOLD_MS sends
// another. Nothing is tracked: whether a press starts or stops a dictation is read
// from CoreAudio (is Typeless's input running?), so nothing drifts if Typeless stops
// on its own. A press that stops a dictation does nothing on release.
// The app is Typeless or Wispr Flow (src/engine.ts). Wispr is driven through its
// start-hands-free and stop-hands-free deep links, which map onto the same two taps.
// After a hold ends, we wait for Typeless to finish that dictation and press
// Return, so a held burst is sent as soon as it's pasted. Taps never send.
import { appendFileSync } from "node:fs";
import { Database } from "bun:sqlite";
import { pressEnter, toggleDictation, uptimeNs } from "./keystroke.ts";
import { appRecording } from "./audio.ts";
import { engine, type Engine } from "./engine.ts";
import * as preroll from "./preroll.ts";
import type { Drained } from "./preroll.ts";

export const HOLD_MS = 400;
const ENTER_AFTER_HOLD = true;
const PASTE_TIMEOUT_MS = 20_000;
const TYPELESS_DB = `${process.env.HOME}/Library/Application Support/Typeless/typeless.db`;
const WISPR_DB = `${process.env.HOME}/Library/Application Support/Wispr Flow/flow.sqlite`;
// Wispr writes a History row per dictation; its timestamp format is "2026-10-01 21:27:13.245 +00:00".
// "formatted" or "raw_transcript" means text was produced and pasted; dismissed, empty,
// error and no_audio mean nothing to send. Null or "processing" is still running.
const wisprTime = (ms: number) => new Date(ms).toISOString().replace("T", " ").replace("Z", " +00:00");
const WISPR_PASTED = new Set(["formatted", "raw_transcript"]);
const WISPR_RUNNING = new Set(["processing"]);
const LOG = `${process.env.HOME}/Library/Logs/TypelessPedal.log`;

export const log = (msg: string) => {
  try { appendFileSync(LOG, `${new Date().toISOString()} ${msg}\n`); } catch {}
};

// Typeless writes one history_v2 row per dictation when recording starts and marks
// it "completed" once the text is pasted. Anything else (cancelled, no speech,
// schema change) means no Enter.
// Only a row that started during this hold counts: a later dictation completing
// must not trigger this hold's Enter.
async function waitForPaste(e: Engine, startedAt: number, endedAt: number): Promise<boolean> {
  const wispr = e.name === "wispr";
  // Wispr may stamp the row when recording ends, a moment after the stop tap.
  const since = wispr ? wisprTime(startedAt - 500) : new Date(startedAt - 500).toISOString();
  const until = wispr ? wisprTime(endedAt + 3000) : new Date(endedAt).toISOString();
  const deadline = Date.now() + PASTE_TIMEOUT_MS;
  let lastError: unknown = null;
  try {
    const db = new Database(wispr ? WISPR_DB : TYPELESS_DB, { readonly: true });
    const q = wispr
      ? db.query("select status from History where timestamp >= ? and timestamp <= ? order by timestamp desc limit 1")
      : db.query("select status from history_v2 where created_at >= ? and created_at <= ? order by created_at desc limit 1");
    try {
      while (Date.now() < deadline) {
        // Typeless locks the database while it writes the result; retry until the deadline.
        try {
          const row = q.get(since, until) as { status: string | null } | null;
          if (wispr) {
            if (row?.status && WISPR_PASTED.has(row.status)) return true;
            if (row?.status && !WISPR_RUNNING.has(row.status)) return false;
          } else {
            if (row?.status === "completed") return true;
            if (row?.status) return false; // dismissed, cancelled, failed
          }
        } catch (e) { lastError = e; }
        await Bun.sleep(100);
      }
    } finally { db.close(); }
  } catch (e) { lastError = e; }
  if (lastError) log(`paste check error: ${lastError}`);
  return false;
}

// Starts or stops the engine's dictation. Returns when the signal went out.
async function signal(e: Engine, stop: boolean): Promise<bigint> {
  const url = stop ? e.stopUrl : e.startUrl;
  if (!url) return toggleDictation(e.key);
  const at = uptimeNs();
  // Awaited so a quick stop cannot overtake its start.
  await Bun.spawn(["/usr/bin/open", "-g", url], { stdout: "ignore", stderr: "ignore" }).exited;
  return at;
}

const ms = (ns: bigint) => (Number(ns) / 1e6).toFixed(1);

// Typeless opens the mic well after the tap. Timing it on every start press keeps the
// real delay visible: speech before "mic live" is not in the recording. A stop tap
// finds the mic already running and logs nothing.
async function watchMic(source: string, downAt: bigint, e: Engine) {
  if (appRecording(e.appPath)) return;
  const deadline = downAt + 3_000_000_000n;
  while (uptimeNs() < deadline) {
    await Bun.sleep(2);
    if (appRecording(e.appPath)) return log(`${source} ${e.name} mic live ${ms(uptimeNs() - downAt)}ms after the tap`);
  }
  log(`${source} ${e.name} mic not live 3s after the tap`);
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
  const e = engine();
  const stopping = appRecording(e.appPath);
  pressStopped.set(source, stopping);
  if (stopping) await drainBeforeStop(source);
  else preroll.arm().then((r) => { if (r === null) log(`${source} preroll helper not answering`); });
  const downAt = await signal(e, stopping);
  log(`${source} down: ${e.name} toggle (${stopping ? "stop" : "start"}), tapped ${ms(downAt - pressedAt)}ms after the press`);
  if (!stopping) watchMic(source, downAt, e).catch((e) => log(`mic watch error: ${e}`));
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
  const e = engine();
  const releasedAt = Date.now();
  const drained = await drainBeforeStop(source);
  // The app never started (its start tap was lost): a tap now would start one.
  if (drained && !drained.typelessRead && !appRecording(e.appPath)) {
    log(`${source} up after ${heldMs}ms: ${e.label} never started, nothing to stop`);
    return;
  }
  await signal(e, true);
  log(`${source} up after ${heldMs}ms: hold ends, toggle`);
  if (!ENTER_AFTER_HOLD) return;
  if (await waitForPaste(e, releasedAt - heldMs, releasedAt)) {
    await Bun.sleep(150);
    await pressEnter();
    log(`${source} pasted: enter`);
  } else {
    log(`${source} no completed dictation: no enter`);
  }
}
