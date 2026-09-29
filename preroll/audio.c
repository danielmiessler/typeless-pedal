// Real-time half of TypelessPreroll: capture the mic into a ring buffer, play the ring
// to the loopback device, and answer read-only questions about Typeless's input.
// The audio callbacks run on CoreAudio's real-time threads, so they live here in C:
// no allocation, no locks, only atomics.
#include "audio.h"
#include <AudioToolbox/AudioToolbox.h>
#include <CoreAudio/CoreAudio.h>
#include <libproc.h>
#include <mach/mach_time.h>
#include <stdatomic.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

extern void goAudioChanged(void);

static float *ring;
static uint64_t ringLen;
static _Atomic uint64_t writePos, readPos, firstAudioAt;
static _Atomic int flowing;
static AudioUnit inUnit, outUnit;
static AudioDeviceID inDev, outDev;
static AudioBufferList *inList;
static UInt32 inMax = 8192;
static Float64 rate;

static AudioObjectPropertyAddress addr(AudioObjectPropertySelector s, AudioObjectPropertyScope sc) {
  AudioObjectPropertyAddress a = {s, sc, kAudioObjectPropertyElementMain};
  return a;
}

static OSStatus onInput(void *ref, AudioUnitRenderActionFlags *flags, const AudioTimeStamp *ts,
                        UInt32 bus, UInt32 frames, AudioBufferList *unused) {
  if (frames > inMax) return noErr;
  inList->mBuffers[0].mDataByteSize = frames * sizeof(float);
  OSStatus st = AudioUnitRender(inUnit, flags, ts, 1, frames, inList);
  if (st) return st;
  uint64_t w = atomic_load(&writePos);
  const float *src = inList->mBuffers[0].mData;
  for (UInt32 i = 0; i < frames; i++) ring[(w + i) % ringLen] = src[i];
  atomic_store(&writePos, w + frames);
  uint64_t none = 0;
  atomic_compare_exchange_strong(&firstAudioAt, &none, mach_absolute_time());
  return noErr;
}

static OSStatus onOutput(void *ref, AudioUnitRenderActionFlags *flags, const AudioTimeStamp *ts,
                         UInt32 bus, UInt32 frames, AudioBufferList *io) {
  float *out = io->mBuffers[0].mData;
  UInt32 ch = io->mBuffers[0].mNumberChannels;
  uint64_t r = atomic_load(&readPos), w = atomic_load(&writePos);
  if (w - r > ringLen) r = w - ringLen;  // fell a whole ring behind: skip ahead
  int flow = atomic_load(&flowing);
  for (UInt32 i = 0; i < frames; i++) {
    float s = 0;
    if (flow && r < w) s = ring[r++ % ringLen];
    for (UInt32 c = 0; c < ch; c++) out[i * ch + c] = s;
  }
  atomic_store(&readPos, r);
  return noErr;
}

static OSStatus onChange(AudioObjectID o, UInt32 n, const AudioObjectPropertyAddress *a, void *c) {
  goAudioChanged();
  return noErr;
}

static int getName(AudioObjectID o, AudioObjectPropertySelector sel, char *buf, int len) {
  AudioObjectPropertyAddress a = addr(sel, kAudioObjectPropertyScopeGlobal);
  CFStringRef s = NULL;
  UInt32 sz = sizeof s;
  buf[0] = 0;
  if (AudioObjectGetPropertyData(o, &a, 0, NULL, &sz, &s) || !s) return -1;
  CFStringGetCString(s, buf, len, kCFStringEncodingUTF8);
  CFRelease(s);
  return 0;
}

int deviceName(unsigned int dev, char *buf, int len) { return getName(dev, kAudioObjectPropertyName, buf, len); }
int deviceUID(unsigned int dev, char *buf, int len) { return getName(dev, kAudioDevicePropertyDeviceUID, buf, len); }

unsigned int defaultInput(void) {
  AudioObjectPropertyAddress a = addr(kAudioHardwarePropertyDefaultInputDevice, kAudioObjectPropertyScopeGlobal);
  AudioDeviceID d = 0;
  UInt32 sz = sizeof d;
  AudioObjectGetPropertyData(kAudioObjectSystemObject, &a, 0, NULL, &sz, &d);
  return d;
}

unsigned int deviceForUID(const char *uid) {
  CFStringRef s = CFStringCreateWithCString(NULL, uid, kCFStringEncodingUTF8);
  AudioObjectPropertyAddress a = addr(kAudioHardwarePropertyTranslateUIDToDevice, kAudioObjectPropertyScopeGlobal);
  AudioDeviceID d = 0;
  UInt32 sz = sizeof d;
  OSStatus st = AudioObjectGetPropertyData(kAudioObjectSystemObject, &a, sizeof s, &s, &sz, &d);
  CFRelease(s);
  return st ? 0 : d;
}

static AudioUnit newHAL(void) {
  AudioComponentDescription d = {kAudioUnitType_Output, kAudioUnitSubType_HALOutput, kAudioUnitManufacturer_Apple, 0, 0};
  AudioUnit u = NULL;
  AudioComponent comp = AudioComponentFindNext(NULL, &d);
  if (!comp || AudioComponentInstanceNew(comp, &u)) return NULL;
  return u;
}

static void disposeUnits(void) {
  if (inUnit) { AudioOutputUnitStop(inUnit); AudioUnitUninitialize(inUnit); AudioComponentInstanceDispose(inUnit); inUnit = NULL; }
  if (outUnit) { AudioOutputUnitStop(outUnit); AudioUnitUninitialize(outUnit); AudioComponentInstanceDispose(outUnit); outUnit = NULL; }
  inDev = outDev = 0;
}

// Builds (or keeps) the capture unit on mic and the playback unit on loopback.
// Returns 0, or a negative step number that failed.
int prepare(unsigned int mic, unsigned int loopback) {
  if (inUnit && outUnit && mic == inDev && loopback == outDev) return 0;
  disposeUnits();
  if (!inList) {
    inList = malloc(sizeof(AudioBufferList));
    inList->mNumberBuffers = 1;
    inList->mBuffers[0].mNumberChannels = 1;
    inList->mBuffers[0].mData = malloc(inMax * sizeof(float));
  }
  UInt32 one = 1, zero = 0;
  if (!(inUnit = newHAL())) return -1;
  AudioUnitSetProperty(inUnit, kAudioOutputUnitProperty_EnableIO, kAudioUnitScope_Input, 1, &one, sizeof one);
  AudioUnitSetProperty(inUnit, kAudioOutputUnitProperty_EnableIO, kAudioUnitScope_Output, 0, &zero, sizeof zero);
  AudioDeviceID m = mic;
  if (AudioUnitSetProperty(inUnit, kAudioOutputUnitProperty_CurrentDevice, kAudioUnitScope_Global, 0, &m, sizeof m)) return -2;
  AudioStreamBasicDescription dev;
  UInt32 sz = sizeof dev;
  if (AudioUnitGetProperty(inUnit, kAudioUnitProperty_StreamFormat, kAudioUnitScope_Input, 1, &dev, &sz)) return -3;
  rate = dev.mSampleRate;
  AudioStreamBasicDescription f = {0};
  f.mSampleRate = rate;
  f.mFormatID = kAudioFormatLinearPCM;
  f.mFormatFlags = kAudioFormatFlagIsFloat | kAudioFormatFlagIsPacked;
  f.mFramesPerPacket = 1;
  f.mChannelsPerFrame = 1;
  f.mBitsPerChannel = 32;
  f.mBytesPerFrame = f.mBytesPerPacket = 4;
  if (AudioUnitSetProperty(inUnit, kAudioUnitProperty_StreamFormat, kAudioUnitScope_Output, 1, &f, sizeof f)) return -4;
  AudioUnitSetProperty(inUnit, kAudioUnitProperty_MaximumFramesPerSlice, kAudioUnitScope_Global, 0, &inMax, sizeof inMax);
  AURenderCallbackStruct icb = {onInput, NULL};
  if (AudioUnitSetProperty(inUnit, kAudioOutputUnitProperty_SetInputCallback, kAudioUnitScope_Global, 0, &icb, sizeof icb)) return -5;
  if (AudioUnitInitialize(inUnit)) return -6;

  if (!(outUnit = newHAL())) return -7;
  AudioDeviceID l = loopback;
  if (AudioUnitSetProperty(outUnit, kAudioOutputUnitProperty_CurrentDevice, kAudioUnitScope_Global, 0, &l, sizeof l)) return -8;
  f.mChannelsPerFrame = 2;  // same mono sample on both channels
  f.mBytesPerFrame = f.mBytesPerPacket = 8;
  if (AudioUnitSetProperty(outUnit, kAudioUnitProperty_StreamFormat, kAudioUnitScope_Input, 0, &f, sizeof f)) return -9;
  AURenderCallbackStruct ocb = {onOutput, NULL};
  if (AudioUnitSetProperty(outUnit, kAudioUnitProperty_SetRenderCallback, kAudioUnitScope_Input, 0, &ocb, sizeof ocb)) return -10;
  if (AudioUnitInitialize(outUnit)) return -11;

  uint64_t want = (uint64_t)(rate * 120);  // two minutes of backlog room
  if (ringLen != want) { free(ring); ring = calloc(want, sizeof(float)); ringLen = want; }
  inDev = mic;
  outDev = loopback;
  return 0;
}

// Starts capture first (it is the part racing the speaker), then playback.
int startUnits(int flow) {
  atomic_store(&writePos, 0);
  atomic_store(&readPos, 0);
  atomic_store(&firstAudioAt, 0);
  atomic_store(&flowing, flow);
  if (AudioOutputUnitStart(inUnit)) return -1;
  if (AudioOutputUnitStart(outUnit)) { AudioOutputUnitStop(inUnit); return -2; }
  return 0;
}

void stopUnits(void) {
  if (inUnit) AudioOutputUnitStop(inUnit);
  if (outUnit) AudioOutputUnitStop(outUnit);
  atomic_store(&flowing, 0);
}

void setFlowing(int on) { atomic_store(&flowing, on); }
unsigned long long written(void) { return atomic_load(&writePos); }
unsigned long long played(void) { return atomic_load(&readPos); }
double sampleRate(void) { return rate; }

// Nanoseconds on the uptime clock when the first captured buffer arrived; 0 before.
unsigned long long firstAudioNs(void) {
  uint64_t t = atomic_load(&firstAudioAt);
  if (!t) return 0;
  mach_timebase_info_data_t tb;
  mach_timebase_info(&tb);
  return t * tb.numer / tb.denom;
}

unsigned long long uptimeNs(void) { return clock_gettime_nsec_np(CLOCK_UPTIME_RAW); }

static int isTypeless(AudioObjectID o) {
  AudioObjectPropertyAddress a = addr(kAudioProcessPropertyPID, kAudioObjectPropertyScopeGlobal);
  pid_t pid = 0;
  UInt32 sz = sizeof pid;
  if (AudioObjectGetPropertyData(o, &a, 0, NULL, &sz, &pid) || !pid) return 0;
  char path[PROC_PIDPATHINFO_MAXSIZE];
  if (proc_pidpath(pid, path, sizeof path) <= 0) return 0;
  return strstr(path, "/Typeless.app/") != NULL;
}

static AudioObjectID watched[128];
static int nWatched;

// Lists CoreAudio's process objects, subscribing to input-running changes on
// Typeless's. Returns 1 if any Typeless process has input running.
int typelessReading(void) {
  AudioObjectPropertyAddress la = addr(kAudioHardwarePropertyProcessObjectList, kAudioObjectPropertyScopeGlobal);
  UInt32 sz = 0;
  if (AudioObjectGetPropertyDataSize(kAudioObjectSystemObject, &la, 0, NULL, &sz) || !sz) return 0;
  AudioObjectID objs[512];
  if (sz > sizeof objs) sz = sizeof objs;
  if (AudioObjectGetPropertyData(kAudioObjectSystemObject, &la, 0, NULL, &sz, objs)) return 0;
  int reading = 0;
  AudioObjectPropertyAddress ra = addr(kAudioProcessPropertyIsRunningInput, kAudioObjectPropertyScopeGlobal);
  for (UInt32 i = 0; i < sz / sizeof(AudioObjectID); i++) {
    if (!isTypeless(objs[i])) continue;
    int known = 0;
    for (int j = 0; j < nWatched; j++) if (watched[j] == objs[i]) known = 1;
    if (!known && nWatched < 128) {
      AudioObjectAddPropertyListener(objs[i], &ra, onChange, NULL);
      watched[nWatched++] = objs[i];
    }
    UInt32 on = 0, osz = sizeof on;
    if (!AudioObjectGetPropertyData(objs[i], &ra, 0, NULL, &osz, &on) && on) reading = 1;
  }
  return reading;
}

// Deliver HAL notifications on the HAL's own thread (no run loop here), and hear
// about processes coming and going.
void watchSystem(void) {
  AudioObjectPropertyAddress rl = addr(kAudioHardwarePropertyRunLoop, kAudioObjectPropertyScopeGlobal);
  CFRunLoopRef none = NULL;
  AudioObjectSetPropertyData(kAudioObjectSystemObject, &rl, 0, NULL, sizeof none, &none);
  AudioObjectPropertyAddress la = addr(kAudioHardwarePropertyProcessObjectList, kAudioObjectPropertyScopeGlobal);
  AudioObjectAddPropertyListener(kAudioObjectSystemObject, &la, onChange, NULL);
}
