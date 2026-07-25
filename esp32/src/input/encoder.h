#pragma once

#include <cstdint>

// Rotary encoder (quadrature) + center key driver for the T-Embed knob.
// ISR-driven decode (a detented encoder spun fast produces ~1ms transitions —
// far too quick for the 30fps UI poll), consumed per-frame from the UI task.

namespace Input {

enum class KeyEvent : uint8_t { NONE = 0, SHORT_PRESS, LONG_PRESS };

// Attach interrupts on pinA/pinB and configure the key pin. Call once.
void encoderInit(int pinA, int pinB, int pinKey);

// Detents turned since the last call (positive = clockwise). Call per frame.
int encoderReadDelta();

// Poll the center key. Returns SHORT_PRESS on release before the long
// threshold, LONG_PRESS once while held past it (fires a single time).
KeyEvent encoderPollKey(uint32_t nowMs);

}  // namespace Input
