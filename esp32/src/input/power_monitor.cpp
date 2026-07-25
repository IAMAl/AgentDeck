#if defined(BOARD_T_EMBED)

#include "power_monitor.h"
#include "../../boards/board_config.h"

#include <Arduino.h>
#include <Wire.h>
#include <esp_sleep.h>

// BQ27220 standard commands (vendor lib/BQ27220/bq27220_def.h)
static constexpr uint8_t GAUGE_ADDR = 0x55;
static constexpr uint8_t CMD_SOC = 0x2C;      // StateOfCharge, u16 %
static constexpr uint8_t CMD_CURRENT = 0x0C;  // s16 mA, negative = discharging

// BQ25896 charger: REG0B status — VBUS_STAT[7:5], CHRG_STAT[4:3], PG_STAT[2]
static constexpr uint8_t CHARGER_ADDR = 0x6B;
static constexpr uint8_t CHARGER_REG_STATUS = 0x0B;

static Input::PowerStatus s_status = {false, 0, false, false};
static uint32_t s_lastPollMs = 0;
static constexpr uint32_t POLL_INTERVAL_MS = 5000;

static bool readU16(uint8_t addr, uint8_t cmd, uint16_t* out) {
    Wire.beginTransmission(addr);
    Wire.write(cmd);
    if (Wire.endTransmission(false) != 0) return false;
    if (Wire.requestFrom(addr, (uint8_t)2) != 2) return false;
    uint8_t lo = Wire.read();
    uint8_t hi = Wire.read();
    *out = (uint16_t)((hi << 8) | lo);
    return true;
}

static bool readU8(uint8_t addr, uint8_t reg, uint8_t* out) {
    Wire.beginTransmission(addr);
    Wire.write(reg);
    if (Wire.endTransmission(false) != 0) return false;
    if (Wire.requestFrom(addr, (uint8_t)1) != 1) return false;
    *out = Wire.read();
    return true;
}

namespace Input {

void powerInit() {
    Wire.begin(BOARD_PIN_I2C_SDA, BOARD_PIN_I2C_SCL);
    powerPoll(0);
    s_lastPollMs = 0;  // let the first UI-loop poll run immediately too
}

void powerPoll(uint32_t nowMs) {
    if (nowMs != 0 && (nowMs - s_lastPollMs) < POLL_INTERVAL_MS) return;
    s_lastPollMs = nowMs;

    uint16_t soc = 0;
    bool gaugeOk = readU16(GAUGE_ADDR, CMD_SOC, &soc) && soc <= 100;

    uint8_t chg = 0;
    bool chargerOk = readU8(CHARGER_ADDR, CHARGER_REG_STATUS, &chg);
    bool powerGood = chargerOk && (chg & 0x04);            // PG_STAT
    uint8_t chrgStat = (uint8_t)((chg >> 3) & 0x03);       // CHRG_STAT
    bool charging = chargerOk && (chrgStat == 1 || chrgStat == 2);

    // Gauge sign-of-current as the charging fallback when the charger IC
    // doesn't answer (current is positive while charging on the BQ27220).
    if (!chargerOk && gaugeOk) {
        uint16_t rawCur = 0;
        if (readU16(GAUGE_ADDR, CMD_CURRENT, &rawCur)) {
            charging = ((int16_t)rawCur) > 20;
            powerGood = charging;
        }
    }

    s_status.valid = gaugeOk;
    s_status.soc = (uint8_t)soc;
    s_status.usbPowered = powerGood;
    s_status.charging = charging;
}

PowerStatus powerStatus() {
    return s_status;
}

void powerOff() {
    // Drop the latch: on battery this is a hard power-off. On USB the rail
    // stays externally fed, so fall through to deep sleep with the side key
    // as the wake source — same user-visible result (dark, silent, resumable).
    digitalWrite(BOARD_PIN_PWR_EN, LOW);
    delay(50);
    esp_sleep_enable_ext0_wakeup((gpio_num_t)BOARD_PIN_USER_KEY, 0);
    esp_deep_sleep_start();
}

}  // namespace Input

#endif  // BOARD_T_EMBED
