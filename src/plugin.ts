// Stream Deck plugin: one pedal, two Typeless dictation modes (see dictate.ts).
import { log, press, release } from "./dictate.ts";

// Stream Deck launches the plugin with: -port P -pluginUUID U -registerEvent E -info JSON
const arg = (name: string) => process.argv[process.argv.indexOf(name) + 1];
const port = arg("-port"), uuid = arg("-pluginUUID"), registerEvent = arg("-registerEvent");

const pressedAt = new Map<string, number>();
const dropped = new Set<string>();
const ws = new WebSocket(`ws://127.0.0.1:${port}`);
ws.onopen = () => {
  ws.send(JSON.stringify({ event: registerEvent, uuid }));
  log("registered");
};
ws.onmessage = async (m) => {
  const msg = JSON.parse(String(m.data));
  if (msg.event === "keyDown") {
    pressedAt.set(msg.context, Date.now());
    await press("pedal");
  } else if (msg.event === "willAppear" || msg.event === "willDisappear") {
    // Shows whether the action is on the page a pedal is currently showing.
    log(`pedal action ${msg.event === "willAppear" ? "shown" : "hidden"} on device ${msg.device}`);
  } else if (msg.event === "deviceDidDisconnect") {
    dropped.add(msg.device);
    log(`pedal device ${msg.device} disconnected`);
  } else if (msg.event === "deviceDidConnect" && dropped.has(msg.device)) {
    // After a USB drop and reconnect, Stream Deck does not reattach the action to a
    // running plugin, so presses stop arriving. Exiting makes Stream Deck relaunch
    // the plugin, and the fresh one gets the action again.
    log(`pedal device ${msg.device} reconnected: restarting plugin`);
    setTimeout(() => process.exit(0), 500);
  } else if (msg.event === "keyUp") {
    const held = Date.now() - (pressedAt.get(msg.context) ?? Date.now());
    pressedAt.delete(msg.context);
    await release("pedal", held);
  }
};
ws.onclose = () => { log("socket closed"); process.exit(0); };
