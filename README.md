# typeless-pedal

A Stream Deck plugin and a Hammerspoon shortcut that give [Typeless](https://www.typeless.com) dictation two modes, on a foot pedal and on Right Ctrl+J:

- **Tap** starts dictation. Tap again to stop. Good for long, hands-free rambles.
- **Hold** starts dictation, and letting go stops it and presses Enter once Typeless has pasted the text. Good for quick bursts you want sent.

Typeless only supports tap-to-toggle. If you hold its shortcut, it stops recording and tells you "Don't hold. Press key once." This plugin fakes the hold: pressing the pedal sends one tap, and releasing it after 0.4 seconds or more sends a second tap.

## The keyboard shortcut

`keyboard/typeless_keys.lua` gives Right Ctrl+J the same tap-or-hold behavior. Hammerspoon catches the physical keys, swallows them, and calls `src/keyboard.ts`, which runs the same logic as the pedal.

This only works if Typeless is not bound to Right Ctrl+J itself, because Typeless grabs its own shortcut before Hammerspoon can see it. So Typeless is bound to **Right Ctrl + F19**, a combo no keyboard sends, and both the pedal and the keyboard post that.

```bash
ln -sf "$PWD/keyboard/typeless_keys.lua" ~/.hammerspoon/typeless_keys.lua
echo 'require("typeless_keys")' >> ~/.hammerspoon/init.lua
```

## Why not Stream Deck's Hotkey action?

Stream Deck's built-in Hotkey action sends Ctrl+key as a key with a Control flag set, without ever pressing the Control key itself. Typeless tells Left Control and Right Control apart, so it ignores that keystroke. This plugin posts the Right Control key down and up around the key, which Typeless accepts.

## Requirements

- macOS, Stream Deck app 6.4 or later, [Bun](https://bun.sh)
- Typeless with its **Dictate** shortcut set to **Right Ctrl + F19**. For a different key, change `KEY_LETTER` in `src/keystroke.ts` (it's a macOS virtual key code).
- Stream Deck needs Accessibility permission in System Settings → Privacy & Security. The Hotkey action needs this too, so you probably granted it already.

## Install

```bash
git clone https://github.com/danielmiessler/typeless-pedal
cd typeless-pedal
bun install.ts
```

Restart Stream Deck, then drag **Dictate (tap or hold)** from the LifeOS category onto a pedal or key.

## Muting while you dictate

Typeless's "Mute audio when dictating" setting mutes the system output device. Some outputs have no mute or volume control, such as virtual and pro-audio devices (Merging's MT VAD, for one), and there it silently does nothing. So `install.ts` also builds `~/Applications/TypelessMute.app`, a background app started at login, which watches Typeless and, while it is recording, mutes every app's audio with a CoreAudio process tap. That works on any output device. A tap only mutes for an app macOS lets record system audio, which is why this is its own app: allow it when macOS asks. The mute follows Typeless's actual recording, not key presses, and it follows the Typeless setting: turn that off and this stops muting too. Needs macOS 14.2 or later. `open -n -g ~/Applications/TypelessMute.app --args --test 3000` mutes everything for three seconds, to check it by ear.

## Tuning

- `HOLD_MS` in `src/dictate.ts` (default 400) is the press length that counts as a hold.
- `ENTER_AFTER_HOLD` in `src/dictate.ts` (default true) turns the auto-Enter off. The plugin reads Typeless's local history database to know when the paste is done, and skips Enter if the dictation was cancelled or had no speech.

- Presses are logged to `~/Library/Logs/TypelessPedal.log`.

## One quirk

The plugin doesn't track whether Typeless is recording, so it can't get out of sync if Typeless stops on its own. The cost is that when you tap to stop a toggle-mode dictation, the press has to be short. Hold it and let go, and you'll start a new dictation.

## License

MIT
