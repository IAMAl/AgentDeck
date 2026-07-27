#pragma once

#include <cstdint>

// CST226SE touch (via SensorLib). The wide strip uses coordinates for direct
// tab/action targets and horizontal motion for page swipes.

namespace Input {

enum class TouchGesture : uint8_t { NONE = 0, TAP, HOLD, SWIPE_LEFT, SWIPE_RIGHT };

struct TouchEvent {
    TouchGesture gesture;
    int16_t x;
    int16_t y;
};

bool touchInit();
bool touchReady();
TouchEvent touchPoll(uint32_t nowMs);

}  // namespace Input
