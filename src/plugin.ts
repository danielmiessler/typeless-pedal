// Stream Deck plugin: one pedal, two Typeless dictation modes.
//   Quick tap  -> toggles dictation (tap to start, tap to stop).
//   Hold       -> starts on press, stops on release.
// Typeless rejects a held shortcut ("Don't hold. Press key once"), so the hold
// is emulated here: the press sends one tap, and a release after HOLD_MS sends
// another. Stateless on purpose: nothing to drift if Typeless stops on its own.
import { appendFileSync } from "node:fs";
import { toggleDictation } from "./keystroke.ts";

const HOLD_MS = 400;
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
    } else {
      log(`up after ${held}ms: tap, nothing on release`);
    }
  }
};
ws.onclose = () => { log("socket closed"); process.exit(0); };
