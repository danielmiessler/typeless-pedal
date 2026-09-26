// Stream Deck plugin: one pedal, two Typeless dictation modes (see dictate.ts).
import { log, press, release } from "./dictate.ts";

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
    await press("pedal");
  } else if (msg.event === "keyUp") {
    const held = Date.now() - (pressedAt.get(msg.context) ?? Date.now());
    pressedAt.delete(msg.context);
    await release("pedal", held);
  }
};
ws.onclose = () => { log("socket closed"); process.exit(0); };
