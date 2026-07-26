#if defined(BOARD_T_EMBED)

#include "encoder.h"
#include <Arduino.h>

// Quadrature decode via full state table: index = (prevAB << 2) | currAB,
// value = count step. Robust against contact bounce (invalid transitions
// contribute 0). One mechanical detent = 4 counts on this encoder (PEC11-ish).
static const int8_t QUAD_TABLE[16] = {
     0, -1, +1,  0,
    +1,  0,  0, -1,
    -1,  0,  0, +1,
     0, +1, -1,  0,
};

static volatile int32_t s_count = 0;
static volatile uint8_t s_prevAB = 0;
static int s_pinA = -1;
static int s_pinB = -1;
static int s_pinKey = -1;
static int32_t s_lastRead = 0;

// File-scope ISR (never inline in an isolated/req context — plain C ABI).
static void IRAM_ATTR encoderIsr() {
    uint8_t a = (uint8_t)digitalRead(s_pinA);
    uint8_t b = (uint8_t)digitalRead(s_pinB);
    uint8_t curr = (uint8_t)((a << 1) | b);
    uint8_t idx = (uint8_t)((s_prevAB << 2) | curr);
    s_count += QUAD_TABLE[idx];
    s_prevAB = curr;
}

namespace Input {

void encoderInit(int pinA, int pinB, int pinKey) {
    s_pinA = pinA;
    s_pinB = pinB;
    s_pinKey = pinKey;
    pinMode(pinA, INPUT_PULLUP);
    pinMode(pinB, INPUT_PULLUP);
    pinMode(pinKey, INPUT_PULLUP);
    s_prevAB = (uint8_t)((digitalRead(pinA) << 1) | digitalRead(pinB));
    attachInterrupt(digitalPinToInterrupt(pinA), encoderIsr, CHANGE);
    attachInterrupt(digitalPinToInterrupt(pinB), encoderIsr, CHANGE);
}

int encoderReadDelta() {
    int32_t now;
    noInterrupts();
    now = s_count;
    interrupts();
    int32_t delta = now - s_lastRead;
    int detents = (int)(delta / 4);
    // Only consume whole detents; keep the remainder for the next frame so
    // slow turns never lose steps at frame boundaries.
    s_lastRead += (int32_t)detents * 4;
    return detents;
}

// Shared with encoderKeyHeldMs so hold-to-talk and the discrete key events
// read the same press.
static bool s_keyDown = false;
static uint32_t s_keyDownSince = 0;

uint32_t encoderKeyHeldMs(uint32_t nowMs) {
    return s_keyDown ? (uint32_t)(nowMs - s_keyDownSince) : 0;
}

KeyEvent encoderPollKey(uint32_t nowMs) {
    static bool prevDown = false;
    static uint32_t downSince = 0;
    static bool longFired = false;
    constexpr uint32_t DEBOUNCE_MS = 30;
    constexpr uint32_t LONG_MS = 600;

    bool down = (digitalRead(s_pinKey) == LOW);
    s_keyDown = down;
    if (down && !prevDown) {
        prevDown = true;
        downSince = nowMs;
        s_keyDownSince = nowMs;
        longFired = false;
        return KeyEvent::NONE;
    }
    if (down && prevDown) {
        if (!longFired && (nowMs - downSince) >= LONG_MS) {
            longFired = true;
            return KeyEvent::LONG_PRESS;
        }
        return KeyEvent::NONE;
    }
    if (!down && prevDown) {
        prevDown = false;
        uint32_t held = nowMs - downSince;
        if (!longFired && held >= DEBOUNCE_MS && held < LONG_MS) {
            return KeyEvent::SHORT_PRESS;
        }
    }
    return KeyEvent::NONE;
}

}  // namespace Input

#endif  // BOARD_T_EMBED
