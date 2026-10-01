// TypelessPreroll records the mic from the instant of a press and plays it to Typeless
// through a loopback device (BlackHole), so Typeless's own delay before it opens its
// input costs no speech. Typeless's microphone is set to the loopback; this helper
// holds the real mic only around a dictation.
//
// The press sends "arm": capture starts at once into a ring buffer. When Typeless's
// input starts, playback begins at the ring's first sample, so Typeless hears the
// dictation from the press, a fixed delay behind. Before the stop tap, "drain" waits
// until everything through the release has been played. Typeless started any other
// way gets the live mic. Commands arrive one per line on a Unix socket.
package main

/*
#cgo LDFLAGS: -framework AudioToolbox -framework CoreAudio -framework CoreFoundation
#include <stdlib.h>
#include "audio.h"
*/
import "C"

import (
	"bufio"
	"encoding/json"
	"flag"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
	"unsafe"
)

var (
	home        = os.Getenv("HOME")
	sockPath    = filepath.Join(home, "Library/Application Support/TypelessPedal/preroll.sock")
	logPath     = filepath.Join(home, "Library/Logs/TypelessPedal.log")
	settings    = filepath.Join(home, "Library/Application Support/Typeless/app-settings.json")
	wisprConfig = filepath.Join(home, "Library/Application Support/Wispr Flow/config.json")
	engineFile  = filepath.Join(home, "Library/Application Support/TypelessPedal/engine")
	loopbackUID = flag.String("loopback", "BlackHole2ch_UID", "loopback device UID the helper plays to")
)

// Typeless records from this aggregate of the loopback. Typeless hides any input
// Chrome labels "(Virtual)", which BlackHole is; the aggregate is not.
const (
	inputUID  = "com.lifeos.typelesspreroll.input"
	inputName = "Typeless Preroll"
)

// typelessInput returns the aggregate Typeless records from, creating it if needed.
func typelessInput() C.uint {
	cuid, cname, csub := C.CString(inputUID), C.CString(inputName), C.CString(*loopbackUID)
	defer C.free(unsafe.Pointer(cuid))
	defer C.free(unsafe.Pointer(cname))
	defer C.free(unsafe.Pointer(csub))
	return C.ensureAggregate(cuid, cname, csub)
}

const (
	idle    = iota
	running // capturing; the ring plays to Typeless whenever it is steadily reading
)

const (
	// Extra audio played after the release before the stop tap, so the last word
	// clears the loopback and Typeless's own buffering.
	drainMargin = 100 * time.Millisecond
	// Before it really records, Typeless opens and closes its input about a dozen
	// times, ~20 ms each. Playback waits for a read this long so those flickers
	// don't swallow the start of the dictation.
	steadyRead = 120 * time.Millisecond
	// Typeless must stay off its input this long before the dictation counts as over.
	stoppedFor = 1500 * time.Millisecond
	// An arm Typeless never reads is abandoned after this.
	armTimeout = 6 * time.Second
)

var (
	mu           sync.Mutex
	state        = idle
	armedAt      time.Time
	readingSince time.Time // zero while Typeless is not reading
	offSince     time.Time // zero while Typeless is reading
	playing      bool      // the ring is playing to Typeless
	everRead     bool      // Typeless read steadily at some point since the arm
	changed      = make(chan struct{}, 1)
)

//export goAudioChanged
func goAudioChanged() {
	select {
	case changed <- struct{}{}:
	default:
	}
}

func logf(format string, a ...any) {
	f, err := os.OpenFile(logPath, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return
	}
	defer f.Close()
	fmt.Fprintf(f, "%s preroll %s\n", time.Now().UTC().Format("2006-01-02T15:04:05.000Z"), fmt.Sprintf(format, a...))
}

func name(dev C.uint, uid bool) string {
	buf := make([]byte, 256)
	p := (*C.char)(unsafe.Pointer(&buf[0]))
	if uid {
		C.deviceUID(dev, p, 256)
	} else {
		C.deviceName(dev, p, 256)
	}
	return C.GoString(p)
}

// The dictation app the bridge plays to: "typeless" unless engineFile says "wispr".
// The pedal code reads the same file (src/engine.ts).
func engine() string {
	raw, _ := os.ReadFile(engineFile)
	if strings.TrimSpace(string(raw)) == "wispr" {
		return "wispr"
	}
	return "typeless"
}

var readerSet string

// refreshReader points the CoreAudio watch at the current engine's processes. Caller holds mu.
func refreshReader() {
	frag := "/Typeless.app/"
	if engine() == "wispr" {
		frag = "/Wispr Flow.app/"
	}
	if frag == readerSet {
		return
	}
	c := C.CString(frag)
	C.setReader(c)
	C.free(unsafe.Pointer(c))
	readerSet = frag
	logf("reader is %s", engine())
}

// Wispr Flow stores its mic as a hashed id; the name is in its ranked device list.
func wisprUsesLoopback() bool {
	raw, err := os.ReadFile(wisprConfig)
	if err != nil {
		return false
	}
	var s struct {
		Prefs struct {
			User struct {
				Override string `json:"overrideAudioDeviceId"`
				Ranked   []struct {
					DeviceID string `json:"deviceId"`
					Name     string `json:"name"`
				} `json:"rankedAudioDevices"`
			} `json:"user"`
		} `json:"prefs"`
	}
	if json.Unmarshal(raw, &s) != nil {
		return false
	}
	for _, d := range s.Prefs.User.Ranked {
		if d.DeviceID == s.Prefs.User.Override {
			return strings.Contains(d.Name, inputName)
		}
	}
	return false
}

// The engine must be recording from the preroll input, or playing to it helps nothing.
func typelessUsesLoopback() bool {
	if engine() == "wispr" {
		return wisprUsesLoopback()
	}
	raw, err := os.ReadFile(settings)
	if err != nil {
		return false
	}
	var s struct {
		Selected struct{ Label string } `json:"selectedMicrophoneDevice"`
	}
	return json.Unmarshal(raw, &s) == nil && strings.Contains(s.Selected.Label, inputName)
}

// Resolves the mic and loopback and builds the audio units. Returns "" or why not.
func ready() string {
	refreshReader()
	cuid := C.CString(*loopbackUID)
	defer C.free(unsafe.Pointer(cuid))
	loop := C.deviceForUID(cuid)
	if loop == 0 {
		return "no-loopback"
	}
	agg := typelessInput()
	if agg == 0 {
		return "no-aggregate"
	}
	if !typelessUsesLoopback() {
		return "not-selected"
	}
	mic := C.defaultInput()
	if mic == 0 || mic == loop || mic == agg {
		return "mic-is-loopback" // capturing what we play would loop forever
	}
	if rc := C.prepare(mic, loop); rc != 0 {
		return fmt.Sprintf("setup-failed-%d", int(rc))
	}
	return ""
}

func ms(d time.Duration) string { return fmt.Sprintf("%.1fms", float64(d.Microseconds())/1000) }

func backlog() time.Duration {
	r := float64(C.sampleRate())
	if r == 0 {
		return 0
	}
	return time.Duration(float64(C.written()-C.played()) / r * float64(time.Second))
}

// begin starts capture into an empty ring. Caller holds mu.
func begin(why string) string {
	t0 := C.uptimeNs()
	if r := ready(); r != "" {
		return r
	}
	if rc := C.startUnits(0); rc != 0 {
		return fmt.Sprintf("start-failed-%d", int(rc))
	}
	state, armedAt, playing, everRead = running, time.Now(), false, false
	go func() { // how soon real audio arrived
		for i := 0; i < 100; i++ {
			if first := C.firstAudioNs(); first != 0 {
				logf("capturing %s after %s", ms(time.Duration(first-t0)), why)
				return
			}
			time.Sleep(2 * time.Millisecond)
		}
		logf("no audio 200ms after %s (Microphone permission?)", why)
	}()
	return ""
}

// end stops capture. Caller holds mu.
func end(why string) {
	C.stopUnits()
	state, playing = idle, false
	logf("stopped: %s (skipped %.0fms of silence, room floor %.1f dBFS)", why, float64(C.skippedMs()), float64(C.floorDb()))
}

func arm() string {
	mu.Lock()
	defer mu.Unlock()
	if state != idle {
		if playing {
			return "ok already" // Typeless is reading: this dictation is live
		}
		// Capture is still winding down from the last dictation: start this one here.
		C.skipToNow()
		armedAt, everRead, readingSince = time.Now(), false, time.Time{}
		return "ok rearmed"
	}
	if why := begin("arm"); why != "" {
		return why
	}
	return "ok"
}

// drain returns once everything captured up to now, plus a margin, has been played
// to Typeless. "read=0" means Typeless never read this dictation.
func drain() string {
	mu.Lock()
	if state == idle {
		mu.Unlock()
		return "drained 0 read=0 idle"
	}
	target := uint64(C.written()) + uint64(float64(C.sampleRate())*drainMargin.Seconds())
	started := time.Now()
	mu.Unlock()
	for time.Since(started) < armTimeout+time.Second {
		mu.Lock()
		st, read, done := state, everRead, uint64(C.played()) >= target
		mu.Unlock()
		if st == idle {
			return fmt.Sprintf("drained %d read=%d idle", time.Since(started).Milliseconds(), b2i(read))
		}
		if done {
			return fmt.Sprintf("drained %d read=1", time.Since(started).Milliseconds())
		}
		time.Sleep(3 * time.Millisecond)
	}
	mu.Lock()
	read := everRead
	mu.Unlock()
	return fmt.Sprintf("drained %d read=%d timeout", time.Since(started).Milliseconds(), b2i(read))
}

func b2i(b bool) int {
	if b {
		return 1
	}
	return 0
}

// step applies what Typeless's input is doing right now. Caller holds mu.
func step(reading bool, now time.Time) {
	if reading {
		offSince = time.Time{}
		if readingSince.IsZero() {
			readingSince = now
		}
		if state == idle { // Typeless started some other way: pass the mic from now
			if why := begin("typeless started without a press"); why != "" {
				return
			}
		}
		if !playing && now.Sub(readingSince) >= steadyRead {
			C.setFlowing(1)
			playing = true
			if !everRead {
				everRead = true
				logf("typeless reading %s after arm, playing from the press (%s behind)", ms(now.Sub(armedAt)), ms(backlog()))
			}
		}
		return
	}
	readingSince = time.Time{}
	if offSince.IsZero() {
		offSince = now
	}
	if playing { // a flicker or the end: hold the ring until Typeless reads again
		C.setFlowing(0)
		playing = false
	}
	switch {
	case state == running && everRead && now.Sub(offSince) >= stoppedFor:
		end("typeless stopped reading")
	case state == running && !everRead && now.Sub(armedAt) >= armTimeout:
		end("typeless never started reading")
	}
}

func watch() {
	C.watchSystem()
	tick := time.NewTicker(5 * time.Millisecond)
	defer tick.Stop()
	n := 0
	for {
		select {
		case <-changed:
		case <-tick.C:
			mu.Lock()
			st := state
			mu.Unlock()
			// Fast while a dictation runs; slow while idle, where notifications carry
			// a Typeless start and polling only backs them up.
			if n++; st == idle && n%40 != 0 {
				continue
			}
		}
		mu.Lock()
		if n%40 == 0 {
			refreshReader()
		}
		reading := C.typelessReading() == 1
		step(reading, time.Now())
		mu.Unlock()
	}
}

func status() string {
	mu.Lock()
	defer mu.Unlock()
	cuid := C.CString(*loopbackUID)
	defer C.free(unsafe.Pointer(cuid))
	loop := C.deviceForUID(cuid)
	out, _ := json.Marshal(map[string]any{
		"state":          []string{"idle", "running"}[state],
		"playing":        playing,
		"loopback":       loop != 0,
		"loopbackName":   name(loop, false),
		"typelessOnLoop": loop != 0 && typelessUsesLoopback(),
		"input":          name(typelessInput(), false),
		"mic":            name(C.defaultInput(), false),
	})
	return string(out)
}

func serve(conn net.Conn) {
	defer conn.Close()
	in := bufio.NewScanner(conn)
	for in.Scan() {
		var reply string
		switch strings.TrimSpace(in.Text()) {
		case "arm":
			reply = arm()
		case "drain":
			reply = drain()
		case "status":
			reply = status()
		default:
			reply = "unknown"
		}
		fmt.Fprintln(conn, reply)
	}
}

func main() {
	flag.Parse()
	os.MkdirAll(filepath.Dir(sockPath), 0o755)
	os.Remove(sockPath)
	ln, err := net.Listen("unix", sockPath)
	if err != nil {
		logf("cannot listen: %v", err)
		os.Exit(1)
	}
	os.Chmod(sockPath, 0o600)
	if typelessInput() == 0 {
		logf("started; no %s yet (is BlackHole installed?)", *loopbackUID)
	} else {
		logf("started; Typeless should record from %q", inputName)
	}
	mu.Lock()
	if why := ready(); why != "" { // build the audio units now, not on the first press
		logf("not ready yet: %s", why)
	}
	mu.Unlock()
	go watch()
	for {
		conn, err := ln.Accept()
		if err != nil {
			continue
		}
		go serve(conn)
	}
}
