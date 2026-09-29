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
	loopbackUID = flag.String("loopback", "BlackHole2ch_UID", "device UID Typeless records from")
)

const (
	idle = iota
	armed   // capturing, waiting for Typeless to start reading
	flowing // Typeless is reading; the ring plays to it
)

// Extra audio played after the release before the stop tap, so the last word clears
// the loopback and Typeless's own buffering.
const drainMargin = 100 * time.Millisecond

var (
	mu       sync.Mutex
	state    = idle
	armedAt  time.Time
	lastRead bool
	changed  = make(chan struct{}, 1)
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

// Typeless must be recording from the loopback, or playing to it helps nothing.
func typelessUsesLoopback(loopbackName string) bool {
	raw, err := os.ReadFile(settings)
	if err != nil {
		return false
	}
	var s struct {
		Selected struct{ Label string } `json:"selectedMicrophoneDevice"`
	}
	return json.Unmarshal(raw, &s) == nil && strings.Contains(s.Selected.Label, loopbackName)
}

// Resolves the mic and loopback and builds the audio units. Returns "" or why not.
func ready() string {
	cuid := C.CString(*loopbackUID)
	defer C.free(unsafe.Pointer(cuid))
	loop := C.deviceForUID(cuid)
	if loop == 0 {
		return "no-loopback"
	}
	loopName := name(loop, false)
	if !typelessUsesLoopback(loopName) {
		return "not-selected"
	}
	mic := C.defaultInput()
	if mic == 0 || mic == loop || strings.Contains(name(mic, true), *loopbackUID) {
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

// start begins capture; with flow set, playback follows the live mic from the start.
func start(flow bool) string {
	if why := ready(); why != "" {
		return why
	}
	f := C.int(0)
	if flow {
		f = 1
	}
	if rc := C.startUnits(f); rc != 0 {
		return fmt.Sprintf("start-failed-%d", int(rc))
	}
	return ""
}

func stop(why string) {
	C.stopUnits()
	state = idle
	logf("stopped: %s", why)
}

func arm() string {
	mu.Lock()
	defer mu.Unlock()
	if state != idle {
		return "ok already"
	}
	t0 := C.uptimeNs()
	if why := start(false); why != "" {
		return why
	}
	state, armedAt = armed, time.Now()
	go func() { // how soon real audio arrived after the arm
		for i := 0; i < 100; i++ {
			if first := C.firstAudioNs(); first != 0 {
				logf("capturing %s after arm", ms(time.Duration(first-t0)))
				return
			}
			time.Sleep(2 * time.Millisecond)
		}
		logf("no audio 200ms after arm (Microphone permission?)")
	}()
	return "ok"
}

// drain returns once everything captured up to now, plus a margin, has been played
// to Typeless. "read=0" means Typeless never started reading this dictation.
func drain() string {
	mu.Lock()
	if state == idle {
		mu.Unlock()
		return "drained 0 read=0 idle"
	}
	rate := float64(C.sampleRate())
	target := uint64(C.written()) + uint64(rate*drainMargin.Seconds())
	begin := time.Now()
	mu.Unlock()
	deadline := begin.Add(7 * time.Second)
	for time.Now().Before(deadline) {
		mu.Lock()
		st, done := state, uint64(C.played()) >= target
		mu.Unlock()
		if st == idle {
			return fmt.Sprintf("drained %d read=0 idle", time.Since(begin).Milliseconds())
		}
		if st == flowing && done {
			return fmt.Sprintf("drained %d read=1", time.Since(begin).Milliseconds())
		}
		time.Sleep(3 * time.Millisecond)
	}
	mu.Lock()
	read := state == flowing
	mu.Unlock()
	if read {
		return fmt.Sprintf("drained %d read=1 timeout", time.Since(begin).Milliseconds())
	}
	return fmt.Sprintf("drained %d read=0 timeout", time.Since(begin).Milliseconds())
}

// onTypeless reacts to Typeless's input starting or stopping.
func onTypeless(reading bool) {
	mu.Lock()
	defer mu.Unlock()
	switch {
	case reading && state == armed:
		C.setFlowing(1)
		state = flowing
		logf("typeless reading %s after arm, playing from the press (%s behind)", ms(time.Since(armedAt)), ms(backlog()))
	case reading && state == idle:
		if why := start(true); why == "" {
			state, armedAt = flowing, time.Now()
			logf("typeless started without a press: passing the mic live")
		}
	case !reading && state == flowing:
		stop("typeless stopped reading")
	}
}

func watch() {
	C.watchSystem()
	tick := time.NewTicker(5 * time.Millisecond)
	defer tick.Stop()
	slow := 0
	for {
		select {
		case <-changed:
		case <-tick.C:
			// Notifications carry the change; polling covers any that are missed, fast
			// only while a dictation is starting.
			mu.Lock()
			st := state
			if st == armed && time.Since(armedAt) > 6*time.Second {
				stop("typeless never started reading")
			}
			mu.Unlock()
			if slow++; st != armed && slow%40 != 0 {
				continue
			}
		}
		reading := C.typelessReading() == 1
		if reading != lastRead {
			lastRead = reading
			onTypeless(reading)
		} else if reading {
			onTypeless(true) // an arm may have landed while Typeless was already reading
		}
	}
}

func status() string {
	mu.Lock()
	defer mu.Unlock()
	cuid := C.CString(*loopbackUID)
	defer C.free(unsafe.Pointer(cuid))
	loop := C.deviceForUID(cuid)
	out, _ := json.Marshal(map[string]any{
		"state":          []string{"idle", "armed", "flowing"}[state],
		"loopback":       loop != 0,
		"loopbackName":   name(loop, false),
		"typelessOnLoop": loop != 0 && typelessUsesLoopback(name(loop, false)),
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
	logf("started (loopback %s)", *loopbackUID)
	go watch()
	for {
		conn, err := ln.Accept()
		if err != nil {
			continue
		}
		go serve(conn)
	}
}
