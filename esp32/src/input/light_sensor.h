#pragma once

#include <cstdint>

// LTR-553ALS ambient-light sensor (I2C 0x23) — drives the Focus Strip's
// auto-dim. Entirely local: no protocol representation.

namespace Input {

bool lightInit();
bool lightReady();

// Self-throttled poll (~5s). Returns the latest ALS reading in rough lux,
// or -1 when the sensor is absent/not yet read.
int lightPollLux(uint32_t nowMs);

}  // namespace Input
