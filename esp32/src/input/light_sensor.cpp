#if defined(BOARD_T_DISPLAY_PRO)

#include "light_sensor.h"
#include "../../boards/board_config.h"

#include <Arduino.h>
#include <Wire.h>

static constexpr uint8_t ALS_ADDR = 0x23;
static constexpr uint8_t REG_ALS_CONTR = 0x80;
static constexpr uint8_t REG_ALS_DATA_CH1_0 = 0x88;  // CH1 low, CH1 high, CH0 low, CH0 high

static bool s_enabled = false;
static uint32_t s_lastPollMs = 0;
static int s_lastLux = -1;
static constexpr uint32_t POLL_INTERVAL_MS = 5000;

namespace Input {

bool lightInit() {
    Wire.begin(BOARD_PIN_I2C_SDA, BOARD_PIN_I2C_SCL);
    Wire.beginTransmission(ALS_ADDR);
    Wire.write(REG_ALS_CONTR);
    Wire.write(0x01);  // ALS active, gain 1x
    s_enabled = (Wire.endTransmission() == 0);
    if (!s_enabled) Serial.println("[ALS] LTR-553 not answering — auto-dim disabled");
    return s_enabled;
}

int lightPollLux(uint32_t nowMs) {
    if (!s_enabled) return -1;
    if ((uint32_t)(nowMs - s_lastPollMs) < POLL_INTERVAL_MS) return s_lastLux;
    s_lastPollMs = nowMs;

    Wire.beginTransmission(ALS_ADDR);
    Wire.write(REG_ALS_DATA_CH1_0);
    if (Wire.endTransmission(false) != 0) return s_lastLux;
    if (Wire.requestFrom(ALS_ADDR, (uint8_t)4) != 4) return s_lastLux;
    uint16_t ch1 = Wire.read() | (Wire.read() << 8);
    uint16_t ch0 = Wire.read() | (Wire.read() << 8);
    // Rough visible-light estimate — enough for a 3-band dim curve, not
    // photometry (the full LTR-553 lux formula needs ratio-dependent
    // coefficients; the bands below are wide).
    s_lastLux = (int)ch0 - (int)(ch1 / 2);
    if (s_lastLux < 0) s_lastLux = 0;
    return s_lastLux;
}

}  // namespace Input

#endif  // BOARD_T_DISPLAY_PRO
