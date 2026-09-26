// Builds the plugin binary, signs it, and installs it into Stream Deck.
// Usage: bun install.ts
import { $ } from "bun";
import { homedir } from "node:os";

const NAME = "com.lifeos.typelesspedal.sdPlugin";
const dest = `${homedir()}/Library/Application Support/com.elgato.StreamDeck/Plugins/${NAME}`;

await $`mkdir -p ${dest}/bin`;
await $`bun build --compile ./src/plugin.ts --outfile ${dest}/bin/plugin`;
// macOS kills an unsigned compiled binary on launch; an ad-hoc signature is enough.
await $`codesign --force -s - ${dest}/bin/plugin`;
await $`cp -R plugin/${NAME}/. ${dest}/`;

console.log(`Installed to ${dest}`);
console.log(`Restart Stream Deck, then drag "Dictate (tap or hold)" onto a pedal or key.`);
