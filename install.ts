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

// macOS remembers the audio permission per signing identity. An ad-hoc signature
// changes with every build, so each rebuild would ask again. Sign with a real
// certificate (TYPELESS_MUTE_SIGN_IDENTITY, else the first "Apple Development" one)
// and the permission survives rebuilds; and skip the rebuild when nothing changed.
const identities = await $`security find-identity -v -p codesigning`.nothrow().text();
const identity = process.env.TYPELESS_MUTE_SIGN_IDENTITY
  ?? identities.match(/"(Apple Development: [^"]+)"/)?.[1]
  ?? "-";
const sources = ["./src/mute.ts", "./src/dictate.ts", "./src/keystroke.ts", "./install.ts"];
const builtAt = (await Bun.file(exe).exists()) ? Bun.file(exe).lastModified : 0;
const signedBy = (await $`codesign -dvv ${app}`.nothrow().quiet()).stderr.toString().match(/Authority=(.+)/)?.[1] ?? "-";
const current = builtAt > 0 && sources.every((s) => Bun.file(s).lastModified < builtAt) && signedBy === identity;

await $`launchctl bootout ${domain}/${MUTE_ID}`.nothrow().quiet();
await $`mkdir -p ${app}/Contents/MacOS ${homedir()}/Library/LaunchAgents`;
if (current) console.log(`TypelessMute.app is current; not rebuilding, so its audio permission stays.`);
else {
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
await $`codesign --force -s ${identity} --identifier ${MUTE_ID} ${app}`;
if (identity === "-") console.log(`No signing certificate found: TypelessMute.app is signed ad hoc, so macOS asks for audio permission again after each rebuild.`);
}
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
console.log(`The first mute after a new signature asks to let TypelessMute record system audio. Allow it once.`);
