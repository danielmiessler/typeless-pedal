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

// An earlier version muted audio through a background app, TypelessMute.app. It was
// retired (switching a CoreAudio mute makes every audio app reinitialise); remove it
// if this Mac still has it.
const OLD_MUTE_ID = "com.lifeos.typelessmute";
await $`launchctl bootout gui/${process.getuid!()}/${OLD_MUTE_ID}`.nothrow().quiet();
for (const old of [
  `${homedir()}/Library/LaunchAgents/${OLD_MUTE_ID}.plist`,
  `${homedir()}/Library/LaunchAgents/${OLD_MUTE_ID}.plist.disabled`,
  `${homedir()}/Applications/TypelessMute.app`,
  `${homedir()}/Library/Application Support/TypelessPedal/mute.sock`,
]) await $`rm -rf ${old}`.nothrow().quiet();

// TypelessPreroll records the mic from the press and plays it to Typeless through
// BlackHole (see preroll/main.go). macOS grants microphone access to an app, not to a
// bare binary, so it ships as a background app with that usage string, started at login.
const PREROLL_ID = "com.lifeos.typelesspreroll";
const app = `${homedir()}/Applications/TypelessPreroll.app`;
const exe = `${app}/Contents/MacOS/TypelessPreroll`;
const agent = `${homedir()}/Library/LaunchAgents/${PREROLL_ID}.plist`;
const domain = `gui/${process.getuid!()}`;

// macOS remembers the microphone grant per signing identity. An ad-hoc signature
// changes with every build, so each rebuild would ask again. Sign with a real
// certificate (TYPELESS_SIGN_IDENTITY, else the first "Apple Development" one) and
// skip the rebuild when nothing changed.
const identities = await $`security find-identity -v -p codesigning`.nothrow().text();
const identity = process.env.TYPELESS_SIGN_IDENTITY
  ?? identities.match(/"(Apple Development: [^"]+)"/)?.[1]
  ?? "-";
const sources = ["./preroll/main.go", "./preroll/audio.c", "./preroll/audio.h", "./install.ts"];
const builtAt = (await Bun.file(exe).exists()) ? Bun.file(exe).lastModified : 0;
const signedBy = (await $`codesign -dvv ${app}`.nothrow().quiet()).stderr.toString().match(/Authority=(.+)/)?.[1] ?? "-";
const current = builtAt > 0 && sources.every((s) => Bun.file(s).lastModified < builtAt) && signedBy === identity;

await $`launchctl bootout ${domain}/${PREROLL_ID}`.nothrow().quiet();
await $`mkdir -p ${app}/Contents/MacOS ${homedir()}/Library/LaunchAgents`;
if (current) console.log(`TypelessPreroll.app is current; not rebuilding, so its microphone grant stays.`);
else {
  await $`go build -o ${exe} .`.cwd("./preroll");
  await Bun.write(`${app}/Contents/Info.plist`, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleIdentifier</key><string>${PREROLL_ID}</string>
  <key>CFBundleName</key><string>TypelessPreroll</string>
  <key>CFBundleExecutable</key><string>TypelessPreroll</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSUIElement</key><true/>
  <key>NSMicrophoneUsageDescription</key><string>TypelessPreroll records from the moment you press dictate, so Typeless gets your first word.</string>
</dict></plist>
`);
  await $`codesign --force -s ${identity} --identifier ${PREROLL_ID} ${app}`;
  if (identity === "-") console.log(`No signing certificate found: TypelessPreroll.app is signed ad hoc, so macOS asks for the microphone again after each rebuild.`);
}
await Bun.write(agent, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${PREROLL_ID}</string>
  <key>ProgramArguments</key><array><string>${exe}</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Interactive</string>
</dict></plist>
`);
await $`launchctl bootstrap ${domain} ${agent}`;
console.log(`Installed ${app}, started at login (${agent}).`);

console.log(`Restart Stream Deck, then drag "Dictate (tap or hold)" onto a pedal or key.`);
console.log(`For the preroll bridge: install BlackHole 2ch (brew install --cask blackhole-2ch), set Typeless's microphone to "BlackHole 2ch", and allow TypelessPreroll the microphone when macOS asks.`);
