# typeless-pedal

A Stream Deck plugin that gives [Typeless](https://www.typeless.com) dictation two modes on one foot pedal (or key):

- **Tap** starts dictation. Tap again to stop. Good for long, hands-free rambles.
- **Hold** starts dictation, and letting go stops it. Good for quick bursts.

Typeless only supports tap-to-toggle. If you hold its shortcut, it stops recording and tells you "Don't hold. Press key once." This plugin fakes the hold: pressing the pedal sends one tap, and releasing it after 0.4 seconds or more sends a second tap.

## Why not Stream Deck's Hotkey action?

Stream Deck's built-in Hotkey action sends Ctrl+J as a letter with a Control flag set, without ever pressing the Control key itself. Typeless tells Left Control and Right Control apart, so it ignores that keystroke, and your terminal gets a newline instead. This plugin posts the Right Control key down and up around the J, which Typeless accepts.

## Requirements

- macOS, Stream Deck app 6.4 or later, [Bun](https://bun.sh)
- Typeless with its **Dictate** shortcut set to **Right Ctrl + J**. For a different letter, change `KEY_LETTER` in `src/keystroke.ts` (it's a macOS virtual key code).
- Stream Deck needs Accessibility permission in System Settings → Privacy & Security. The Hotkey action needs this too, so you probably granted it already.

## Install

```bash
git clone https://github.com/danielmiessler/typeless-pedal
cd typeless-pedal
bun install.ts
```

Restart Stream Deck, then drag **Dictate (tap or hold)** from the LifeOS category onto a pedal or key.

## Tuning

- `HOLD_MS` in `src/plugin.ts` (default 400) is the press length that counts as a hold.
- Presses are logged to `~/Library/Logs/TypelessPedal.log`.

## One quirk

The plugin doesn't track whether Typeless is recording, so it can't get out of sync if Typeless stops on its own. The cost is that when you tap to stop a toggle-mode dictation, the press has to be short. Hold it and let go, and you'll start a new dictation.

## License

MIT
