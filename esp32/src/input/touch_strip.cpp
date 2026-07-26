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

TouchGesture touchPoll(uint32_t nowMs) {
    if (!s_enabled) return TouchGesture::NONE;

    static bool prevDown = false;
    static uint32_t downSince = 0;
    static bool holdFired = false;

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
        return TouchGesture::NONE;
    }
    if (down && prevDown) {
        if (!holdFired && (uint32_t)(nowMs - downSince) >= HOLD_MS) {
            holdFired = true;
            return TouchGesture::HOLD;
        }
        return TouchGesture::NONE;
    }
    if (!down && prevDown) {
        prevDown = false;
        uint32_t held = nowMs - downSince;
        if (!holdFired && held >= 30 && held < TAP_MAX_MS) return TouchGesture::TAP;
    }
    return TouchGesture::NONE;
}

}  // namespace Input

#endif  // BOARD_T_DISPLAY_PRO
