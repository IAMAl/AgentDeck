#pragma once

#include <cstdint>

// CST226SE touch (via SensorLib) reduced to strip gestures: the Focus Strip
// needs "tap anywhere" and "hold anywhere", not coordinates.

namespace Input {

enum class TouchGesture : uint8_t { NONE = 0, TAP, HOLD };

bool touchInit();
TouchGesture touchPoll(uint32_t nowMs);

}  // namespace Input
