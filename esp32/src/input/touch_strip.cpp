#if defined(BOARD_T_DISPLAY_PRO)

#include "touch_strip.h"
#include "../../boards/board_config.h"

#include <Arduino.h>
#include <Wire.h>
#include <TouchDrvCSTXXX.hpp>

#ifndef CST226SE_SLAVE_ADDRESS
#define CST226SE_SLAVE_ADDRESS 0x5A
#endif

static TouchDrvCSTXXX s_touch;
static bool s_enabled = false;

static constexpr uint32_t TAP_MAX_MS = 450;
static constexpr uint32_t HOLD_MS = 700;
static constexpr int16_t SWIPE_MIN_PX = 55;

namespace Input {

bool touchInit() {
    s_touch.setPins(BOARD_PIN_TOUCH_RST, BOARD_PIN_TOUCH_INT);
    // The controller needs settle time after its reset pulse — retry the
    // probe instead of silently shipping a touchless strip.
    for (int attempt = 0; attempt < 3 && !s_enabled; attempt++) {
        if (attempt > 0) delay(150);
        s_enabled = s_touch.begin(Wire, CST226SE_SLAVE_ADDRESS,
                                  BOARD_PIN_I2C_SDA, BOARD_PIN_I2C_SCL);
    }
    if (!s_enabled) Serial.println("[Touch] CST226SE not answering — touch disabled");
    else Serial.println("[Touch] CST226SE ready");
    return s_enabled;
}

bool touchReady() {
    return s_enabled;
}

TouchEvent touchPoll(uint32_t nowMs) {
    TouchEvent event = {TouchGesture::NONE, 0, 0};
    if (!s_enabled) return event;

    static bool prevDown = false;
    static uint32_t downSince = 0;
    static bool holdFired = false;
    static int16_t startX = 0, startY = 0, lastX = 0, lastY = 0;

    // Vendor-style read: full point array (some CSTXXX firmwares report 0
    // touched when asked for fewer slots than the chip supports).
    int16_t xs[5] = {0}, ys[5] = {0};
    uint8_t supported = s_touch.getSupportTouchPoint();
    if (supported == 0 || supported > 5) supported = 1;
    bool down = s_touch.getPoint(xs, ys, supported) > 0;

    if (down && !prevDown) {
        prevDown = true;
        downSince = nowMs;
        holdFired = false;
        startX = lastX = xs[0];
        startY = lastY = ys[0];
        return event;
    }
    if (down && prevDown) {
        lastX = xs[0];
        lastY = ys[0];
        if (!holdFired && (uint32_t)(nowMs - downSince) >= HOLD_MS) {
            holdFired = true;
            event = {TouchGesture::HOLD, lastX, lastY};
            return event;
        }
        return event;
    }
    if (!down && prevDown) {
        prevDown = false;
        uint32_t held = nowMs - downSince;
        int16_t dx = lastX - startX;
        int16_t dy = lastY - startY;
        event.x = lastX;
        event.y = lastY;
        if (!holdFired && abs(dx) >= SWIPE_MIN_PX && abs(dx) > abs(dy)) {
            event.gesture = dx < 0 ? TouchGesture::SWIPE_LEFT : TouchGesture::SWIPE_RIGHT;
            return event;
        }
        if (!holdFired && held >= 30 && held < TAP_MAX_MS) {
            event.gesture = TouchGesture::TAP;
            return event;
        }
    }
    return event;
}

}  // namespace Input

#endif  // BOARD_T_DISPLAY_PRO
