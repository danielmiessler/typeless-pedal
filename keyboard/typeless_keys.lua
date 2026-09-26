-- Right Ctrl+J on the keyboard behaves like the pedal: tap toggles Typeless
-- dictation, hold dictates until you let go (then presses Enter once pasted).
-- Typeless refuses a held shortcut ("Don't hold. Press key once"), so this
-- swallows the physical J and hands press/release to src/keyboard.ts, which
-- posts the same synthetic taps the pedal does. Those carry SYNTHETIC_MARK
-- and pass through untouched.
-- Install: symlink into ~/.hammerspoon and add require("typeless_keys") to init.lua.
local BUN = "/opt/homebrew/bin/bun"
local SCRIPT = os.getenv("HOME") .. "/Projects/typeless-pedal/src/keyboard.ts"
local KEY_J = 38
local FLAG_CTRL, FLAG_RIGHT_CTRL = 0x40000, 0x2000
local FLAG_OTHERS = 0x20000 | 0x80000 | 0x100000 -- shift, option, command
local SYNTHETIC_MARK = 0x7479706c -- must match keystroke.ts

local props = hs.eventtap.event.properties
local types = hs.eventtap.event.types
local pressedAt = nil
local tasks = {}

local function run(args)
    local t
    t = hs.task.new(BUN, function() tasks[t] = nil end, args)
    if t and t:start() then tasks[t] = true end
end

local function isShortcut(e)
    local f = e:rawFlags()
    return (f & FLAG_CTRL) ~= 0 and (f & FLAG_RIGHT_CTRL) ~= 0 and (f & FLAG_OTHERS) == 0
end

if TypelessKeys then TypelessKeys:stop() end
TypelessKeys = hs.eventtap.new({ types.keyDown, types.keyUp }, function(e)
    if e:getKeyCode() ~= KEY_J then return false end
    if e:getProperty(props.eventSourceUserData) == SYNTHETIC_MARK then return false end
    if e:getType() == types.keyDown then
        if pressedAt then return true end -- autorepeat while held
        if not isShortcut(e) then return false end
        pressedAt = hs.timer.absoluteTime()
        run({ SCRIPT, "down" })
        return true
    end
    -- keyUp: releasing J ends the press, whether or not Ctrl is still down
    if not pressedAt then return false end
    local heldMs = math.floor((hs.timer.absoluteTime() - pressedAt) / 1e6)
    pressedAt = nil
    run({ SCRIPT, "up", tostring(heldMs) })
    return true
end)
TypelessKeys:start()

-- macOS disables a tap that stalls; same watchdog pattern as SpaceWatcher.
TypelessKeysWatchdog = hs.timer.doEvery(60, function()
    if not TypelessKeys:isEnabled() then TypelessKeys:start() end
end)

return TypelessKeys
