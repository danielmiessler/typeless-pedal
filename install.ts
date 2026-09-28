// Builds the plugin binary, signs it, and installs it into Stream Deck.
// Also builds TypelessMute.app, which mutes background audio while Typeless records,
// and starts it at login.
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

// The mute needs permission to record system audio, which macOS grants to an app,
// not to a script. So it ships as its own background app with that usage string.
const MUTE_ID = "com.lifeos.typelessmute";
const app = `${homedir()}/Applications/TypelessMute.app`;
const agent = `${homedir()}/Library/LaunchAgents/${MUTE_ID}.plist`;
const exe = `${app}/Contents/MacOS/TypelessMute`;
const domain = `gui/${process.getuid!()}`;
await $`launchctl bootout ${domain}/${MUTE_ID}`.nothrow().quiet();
await $`mkdir -p ${app}/Contents/MacOS ${homedir()}/Library/LaunchAgents`;
await $`bun build --compile ./src/mute.ts --outfile ${exe}`;
await Bun.write(`${app}/Contents/Info.plist`, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleIdentifier</key><string>${MUTE_ID}</string>
  <key>CFBundleName</key><string>TypelessMute</string>
  <key>CFBundleExecutable</key><string>TypelessMute</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSUIElement</key><true/>
  <key>NSAudioCaptureUsageDescription</key><string>TypelessMute silences other apps' audio while Typeless is dictating.</string>
</dict></plist>
`);
await $`codesign --force -s - --identifier ${MUTE_ID} ${app}`;
await Bun.write(agent, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${MUTE_ID}</string>
  <key>ProgramArguments</key><array><string>${exe}</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Interactive</string>
</dict></plist>
`);
await $`launchctl bootstrap ${domain} ${agent}`;
console.log(`Installed ${app} and started it at login (${agent})`);

console.log(`Restart Stream Deck, then drag "Dictate (tap or hold)" onto a pedal or key.`);
console.log(`The first mute asks to let TypelessMute record system audio. Allow it, or muting stays off.`);
