// Pauses whatever media is playing while you dictate, and resumes it afterwards,
// when Typeless's "Mute audio when dictating" setting is on.
// Muting is not an option on outputs with no mute control: the only way is a
// CoreAudio tap, and switching one makes every audio app (Typeless included)
// reinitialise, which stutters the machine and makes Typeless drop key presses.
// Pausing uses the media Play/Pause key and only reads CoreAudio state.
import { existsSync } from "node:fs";
import { playingMediaApp, typelessRecording, muteSettingOn } from "./audio.ts";

// Hammerspoon's CLI posts the media key. Stream Deck starts the plugin with a bare
// PATH, so the CLI is looked up at its install locations (Apple silicon, then Intel).
// It needs require("hs.ipc") in ~/.hammerspoon/init.lua.
const HS = ["/opt/homebrew/bin/hs", "/usr/local/bin/hs"].find((p) => existsSync(p)) ?? "hs";
const POLL_MS = 200;
const RECORDING_GAP_MS = 600; // Typeless's mic can drop briefly; a longer gap ends it
const NO_RECORDING_MS = 5000; // a press that starts nothing resumes after this

let paused = false;

async function playPauseKey() {
  await Bun.$`${HS} -c ${'hs.eventtap.event.newSystemKeyEvent("PLAY", true):post(); hs.eventtap.event.newSystemKeyEvent("PLAY", false):post()'}`.quiet().nothrow();
}

// Called on a press, before the start tap. Does nothing on a stop press (Typeless
// already recording), when nothing is playing, or when the setting is off.
export async function pauseForDictation(log: (msg: string) => void, source: string) {
  if (paused || !muteSettingOn() || typelessRecording()) return;
  const app = playingMediaApp();
  if (!app) return;
  paused = true;
  await playPauseKey();
  log(`${source} paused ${app}`);
  const pausedAt = Date.now();
  let sawRecording = false, lastRecordingAt = 0;
  const timer = setInterval(async () => {
    if (typelessRecording()) { sawRecording = true; lastRecordingAt = Date.now(); return; }
    const done = sawRecording ? Date.now() - lastRecordingAt > RECORDING_GAP_MS : Date.now() - pausedAt > NO_RECORDING_MS;
    if (!done) return;
    clearInterval(timer);
    await playPauseKey();
    paused = false;
    log(`${source} resumed ${app}`);
  }, POLL_MS);
}
