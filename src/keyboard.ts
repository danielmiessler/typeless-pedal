// Keyboard entry point, called by the Hammerspoon adapter (keyboard/typeless-keys.lua),
// which swallows the physical shortcut so Typeless never sees it held.
// Usage: bun src/keyboard.ts down
//        bun src/keyboard.ts up <heldMs>
import { press, release } from "./dictate.ts";

const [cmd, ms] = process.argv.slice(2);
if (cmd === "down") await press("keyboard");
else if (cmd === "up") await release("keyboard", Number(ms) || 0);
else {
  console.error("usage: keyboard.ts down | up <heldMs>");
  process.exit(2);
}
