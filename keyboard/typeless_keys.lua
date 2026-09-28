-- Right Ctrl+J on the keyboard behaves like the pedal: tap toggles Typeless
-- dictation, hold dictates until you let go (then presses Enter once pasted).
-- Typeless refuses a held shortcut ("Don't hold. Press key once"), so this
-- swallows the physical J and hands press/release to src/keyboard.ts, which
-- posts the same synthetic taps the pedal does. That script stays running and
-- reads events from stdin, because the start tap has to land within ~225ms of
-- the press. Posted events carry SYNTHETIC_MARK and pass through untouched.
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

local SOCKET = os.getenv("HOME") .. "/Library/Application Support/TypelessPedal/keyboard.sock"

local function startListener()
    if TypelessKeysTask and TypelessKeysTask:isRunning() then return end
    TypelessKeysTask = hs.task.new(BUN, function(code)
        print("typeless_keys: listener exited " .. tostring(code))
        TypelessKeysConn = nil
    end, { SCRIPT })
    TypelessKeysTask:start()
end

-- One persistent connection; reconnect if the listener restarted.
local function send(line)
    startListener()
    if not (TypelessKeysConn and TypelessKeysConn:connected()) then
        TypelessKeysConn = hs.socket.new()
        TypelessKeysConn:connect(SOCKET)
    end
    TypelessKeysConn:write(line .. "\n")
end

-- One tap of the shortcut from other Hammerspoon code (the new-session pedal
-- in init.lua starts dictation this way). A tap toggles and never sends Enter.
function TypelessToggle()
    send("down")
    send("up 0")
end

local function isShortcut(e)
    local f = e:rawFlags()
    return (f & FLAG_CTRL) ~= 0 and (f & FLAG_RIGHT_CTRL) ~= 0 and (f & FLAG_OTHERS) == 0
end

if TypelessKeys then TypelessKeys:stop() end
if TypelessKeysTask then TypelessKeysTask:terminate(); TypelessKeysTask = nil end
startListener()
hs.timer.doAfter(1, function() -- connect ahead of the first press
    TypelessKeysConn = hs.socket.new()
    TypelessKeysConn:connect(SOCKET)
end)

TypelessKeys =hs.eventtap.new({ types.keyDown, types.keyUp }, function(e)
    if e:getKeyCode() ~= KEY_J then return false end
    if e:getProperty(props.eventSourceUserData) == SYNTHETIC_MARK then return false end
    if e:getType() == types.keyDown then
        local repeating = e:getProperty(props.keyboardEventAutorepeat) ~= 0
        if pressedAt and repeating then return true end
        -- A fresh (non-repeat) press while "held" means a key-up was lost; start over.
        if not isShortcut(e) then pressedAt = nil; return false end
        pressedAt = hs.timer.absoluteTime()
        send("down")
        return true
    end
    -- keyUp: releasing J ends the press, whether or not Ctrl is still down
    if not pressedAt then return false end
    local heldMs = math.floor((hs.timer.absoluteTime() - pressedAt) / 1e6)
    pressedAt = nil
    send("up " .. heldMs)
    return true
end)
TypelessKeys:start()

-- macOS disables a tap that stalls; same watchdog pattern as SpaceWatcher.
TypelessKeysWatchdog = hs.timer.doEvery(60, function()
    if not TypelessKeys:isEnabled() then TypelessKeys:start() end
    startListener()
end)

return TypelessKeys
