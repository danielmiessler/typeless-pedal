// Stream Deck plugin: one pedal, two Typeless dictation modes.
//   Quick tap  -> toggles dictation (tap to start, tap to stop).
//   Hold       -> starts on press, stops on release.
// Typeless rejects a held shortcut ("Don't hold. Press key once"), so the hold
// is emulated here: the press sends one tap, and a release after HOLD_MS sends
// another. Stateless on purpose: nothing to drift if Typeless stops on its own.
// After a hold ends, the plugin waits for Typeless to finish that dictation and
// presses Return, so a held burst is sent as soon as it's pasted. Taps never send.
import { appendFileSync } from "node:fs";
import { Database } from "bun:sqlite";
import { pressEnter, toggleDictation } from "./keystroke.ts";

const HOLD_MS = 400;
const ENTER_AFTER_HOLD = true;
const PASTE_TIMEOUT_MS = 20_000;
const TYPELESS_DB = `${process.env.HOME}/Library/Application Support/Typeless/typeless.db`;

// Typeless writes one history_v2 row per dictation when recording starts and marks
// it "completed" once the text is pasted. Anything else (cancelled, no speech,
// schema change) means no Enter.
async function waitForPaste(startedAt: number): Promise<boolean> {
  const since = new Date(startedAt - 500).toISOString();
  const deadline = Date.now() + PASTE_TIMEOUT_MS;
  try {
    const db = new Database(TYPELESS_DB, { readonly: true });
    const q = db.query("select status from history_v2 where created_at >= ? order by created_at desc limit 1");
    try {
      while (Date.now() < deadline) {
        const row = q.get(since) as { status: string | null } | null;
        if (row?.status === "completed") return true;
        await Bun.sleep(100);
      }
    } finally { db.close(); }
  } catch (e) { log(`paste check failed: ${e}`); }
  return false;
}
const LOG = `${process.env.HOME}/Library/Logs/TypelessPedal.log`;
const log = (msg: string) => {
  try { appendFileSync(LOG, `${new Date().toISOString()} ${msg}\n`); } catch {}
};

// Stream Deck launches the plugin with: -port P -pluginUUID U -registerEvent E -info JSON
const arg = (name: string) => process.argv[process.argv.indexOf(name) + 1];
const port = arg("-port"), uuid = arg("-pluginUUID"), registerEvent = arg("-registerEvent");

const pressedAt = new Map<string, number>();
const ws = new WebSocket(`ws://127.0.0.1:${port}`);
ws.onopen = () => {
  ws.send(JSON.stringify({ event: registerEvent, uuid }));
  log("registered");
};
ws.onmessage = async (m) => {
  const msg = JSON.parse(String(m.data));
  if (msg.event === "keyDown") {
    pressedAt.set(msg.context, Date.now());
    await toggleDictation();
    log("down: toggle");
  } else if (msg.event === "keyUp") {
    const held = Date.now() - (pressedAt.get(msg.context) ?? Date.now());
    pressedAt.delete(msg.context);
    if (held >= HOLD_MS) {
      await toggleDictation();
      log(`up after ${held}ms: hold ends, toggle`);
      if (ENTER_AFTER_HOLD) {
        if (await waitForPaste(Date.now() - held)) {
          await Bun.sleep(150);
          await pressEnter();
          log("pasted: enter");
        } else {
          log("no completed dictation: no enter");
        }
      }
    } else {
      log(`up after ${held}ms: tap, nothing on release`);
    }
  }
};
ws.onclose = () => { log("socket closed"); process.exit(0); };
