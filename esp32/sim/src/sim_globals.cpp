// Host-side definitions for firmware globals that live in main.cpp / display.cpp
// on-device (which the sim does not compile), plus the Arduino shim's Serial and
// deterministic random() backing.
#include <Arduino.h>
#include <lvgl.h>
#include <FastLED.h>
#include <WiFi.h>
#include "config.h"
#include "state/agent_state.h"

// Korean-fallback label font. On-device (display.cpp) this is a RAM copy of
// lv_font_montserrat_12 with a Noto Sans KR fallback pointer; the sim bundles
// the same Noto KR face (fw/font_noto_kr_12.c) so 한글 labels render exactly
// as the panel does instead of degrading to .notdef boxes.
// Guarded out for the non-LVGL boards (inkdeck = Adafruit GFX direct-draw,
// led8x32 = raw matrix): their build filters exclude fw/, so referencing the
// Noto face here is an undefined symbol at link.
#if !defined(BOARD_INKDECK) && !defined(BOARD_LED8X32)
extern "C" const lv_font_t font_noto_kr_12;
lv_font_t font_kr_12 = lv_font_montserrat_12;
#if defined(BOARD_IPS10)
// Larger Korean-safe faces for the IPS10 cards/detail overlay (display.h
// declares these only under BOARD_IPS10). Latin renders from Montserrat at
// size; 한글 falls back to the 16px Noto face — same chain as the device
// (display.cpp).
extern "C" const lv_font_t font_noto_kr_16;
lv_font_t font_kr_16 = lv_font_montserrat_16;
lv_font_t font_kr_20 = lv_font_montserrat_20;
#endif
static struct KrFontInit {
    KrFontInit() {
        font_kr_12.fallback = &font_noto_kr_12;
#if defined(BOARD_IPS10)
        font_kr_16.fallback = &font_noto_kr_16;
        font_kr_20.fallback = &font_noto_kr_16;
#endif
    }
} s_krFontInit;
#endif

// Firmware state singletons (defined in main.cpp on-device).
DashboardState g_state;
SemaphoreHandle_t g_stateMutex = (SemaphoreHandle_t)1;

// Runtime screen dimensions (defined in display.cpp on-device). Seeded from the
// board's SCREEN_W/SCREEN_H build flags.
int16_t g_screenW = SCREEN_W;
int16_t g_screenH = SCREEN_H;

// Arduino shim backing.
unsigned long g_sim_millis = 0;
SimSerial Serial;

// Deterministic PRNG (xorshift32) so successive runs produce identical frames.
static uint32_t s_rng = 0x1234567u;
void randomSeed(unsigned long seed) { s_rng = seed ? (uint32_t)seed : 1u; }
static uint32_t rngNext() {
  s_rng ^= s_rng << 13; s_rng ^= s_rng >> 17; s_rng ^= s_rng << 5;
  return s_rng;
}
long arduino_random(long howbig) {
  if (howbig <= 0) return 0;
  return (long)(rngNext() % (uint32_t)howbig);
}
long arduino_random(long howsmall, long howbig) {
  if (howbig <= howsmall) return howsmall;
  return howsmall + arduino_random(howbig - howsmall);
}

// ── Net / device-status shims ────────────────────────────────────────────────
// Scenes render as an online device (serial + WiFi connected). Definitions back
// the sim/shims/net/*.h declarations.
namespace Net {
bool serialConnected() { return true; }
void serialWriteJsonLine(const char*) {}
bool wifiConnected() { return true; }
const char* wifiLocalIP() { return "192.168.1.42"; }
void queueOutbound(const char*) {}
}  // namespace Net

// ── Audio shims (defined in audio/mic_capture.cpp on-device) ────────────────
// Mic-ready but never capturing: the PTT control renders in its resting state.
namespace Audio {
bool micInit() { return true; }
bool micReady() { return true; }
bool micCapturing() { return false; }
uint32_t micElapsedMs(uint32_t) { return 0; }
void micStart(const char*) {}
void micPump() {}
void micStop(bool) {}
}  // namespace Audio

// ── Display accessors (defined in display.cpp on-device) ─────────────────────
// The HUD queries orientation; the sim has no runtime rotation, so derive it
// from the compile-time screen dimensions.
namespace UI {
bool isLandscape() { return g_screenW >= g_screenH; }
void setBrightness(int) {}   // no backlight on host
}  // namespace UI

// ── TC001 matrix backing (defined in matrix_display.cpp on-device) ───────────
// The sim drives MatrixPages::render* directly, so it owns this global instead.
namespace Matrix { float smoothBrightness = 80.0f; }

// ── FastLED / WiFi shim instances ────────────────────────────────────────────
const CRGB CRGB::Black = CRGB(0, 0, 0);
SimFastLED FastLED;
SimWiFiClass WiFi;
