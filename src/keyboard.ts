// Keyboard entry point, run by the Hammerspoon adapter (keyboard/typeless_keys.lua),
// which swallows the physical Right Ctrl+J and sends one line per event over a
// Unix socket:
//   down
//   up <heldMs>
// It stays running because timing matters: the start tap must reach Typeless before
// J starts auto-repeating (~225ms), and spawning a fresh process per press lost that
// race about half the time.
import { chmodSync, rmSync } from "node:fs";
import { press, release, log } from "./dictate.ts";
import { releaseKeyboardShortcut } from "./keystroke.ts";

export const SOCKET = `${process.env.HOME}/Library/Application Support/TypelessPedal/keyboard.sock`;

async function handle(line: string) {
  const [cmd, ms] = line.trim().split(/\s+/);
  if (cmd === "down") {
    releaseKeyboardShortcut();
    await press("keyboard");
  } else if (cmd === "up") {
    await release("keyboard", Number(ms) || 0);
  }
}

await Bun.$`mkdir -p ${SOCKET.slice(0, SOCKET.lastIndexOf("/"))}`.quiet();
rmSync(SOCKET, { force: true });
const buffers = new WeakMap<object, string>();
Bun.listen({
  unix: SOCKET,
  socket: {
    data(sock, chunk) {
      let buf = (buffers.get(sock) ?? "") + chunk.toString();
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        // Not awaited: a release waiting on Typeless's paste must not delay the next press.
        handle(line).catch((e) => log(`keyboard error: ${e}`));
      }
      buffers.set(sock, buf);
    },
  },
});
chmodSync(SOCKET, 0o600);
log("keyboard listener started");
