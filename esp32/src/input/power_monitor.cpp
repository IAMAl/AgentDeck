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

static Input::PowerStatus s_status = {false, 0, false, false, 0, 0};
static uint32_t s_lastPollMs = 0;
static constexpr uint32_t POLL_INTERVAL_MS = 5000;

// One read attempt. `restart`: repeated-start (false to endTransmission) vs
// full stop before the read phase. Returns 0 on success, a Wire error code
// (2 NACK-addr / 3 NACK-data / 5 timeout), or 100+n for a short read of n.
static uint8_t readBytes(uint8_t addr, uint8_t cmd, uint8_t* out, uint8_t n, bool restart) {
    delayMicroseconds(70);  // BQ27220 bus-free time between transactions (t_BUF 66us)
    Wire.beginTransmission(addr);
    Wire.write(cmd);
    uint8_t err = Wire.endTransmission(restart ? false : true);
    if (err != 0) return err;
    uint8_t got = Wire.requestFrom(addr, n);
    if (got != n) return (uint8_t)(100 + got);
    for (uint8_t i = 0; i < n; i++) out[i] = Wire.read();
    return 0;
}

// Repeated-start first (TI convention), full-stop fallback (some cores/gauges
// misbehave on restart). Records the LAST error for diagnostics.
static bool readU16(uint8_t addr, uint8_t cmd, uint16_t* out, uint8_t* errOut) {
    uint8_t b[2];
    uint8_t err = readBytes(addr, cmd, b, 2, true);
    if (err != 0) err = readBytes(addr, cmd, b, 2, false);
    if (errOut) *errOut = err;
    if (err != 0) return false;
    *out = (uint16_t)((b[1] << 8) | b[0]);
    return true;
}

static bool readU8(uint8_t addr, uint8_t reg, uint8_t* out, uint8_t* errOut) {
    uint8_t err = readBytes(addr, reg, out, 1, true);
    if (err != 0) err = readBytes(addr, reg, out, 1, false);
    if (errOut) *errOut = err;
    return err == 0;
}

namespace Input {

void i2cScanLog(const char* tag) {
    Serial.printf("[I2C] scan @%s:", tag);
    for (uint8_t addr = 0x08; addr < 0x78; addr++) {
        Wire.beginTransmission(addr);
        if (Wire.endTransmission() == 0) Serial.printf(" 0x%02X", addr);
    }
    Serial.println();
}

void powerInit() {
    // Pin the bus pins on the peripheral itself, then begin. Libraries that
    // call the argument-less `Wire.begin()` (Adafruit_PN532 does) would
    // otherwise re-initialize on the ESP32-S3 defaults and move SCL off 18.
    // Hardening, not a fix for an observed failure — see the correction note
    // in powerOff() below.
    Wire.setPins(BOARD_PIN_I2C_SDA, BOARD_PIN_I2C_SCL);
    Wire.begin();
    powerPoll(0);
    if (!s_status.valid) {
        // An empty scan here means the PWR_EN rail is down, not that the driver
        // is misconfigured — see powerOff().
        Serial.printf("[I2C] gauge silent (err %u), PWR_EN=%d — scanning bus\n",
                      s_status.gaugeErr, digitalRead(BOARD_PIN_PWR_EN));
        i2cScanLog("boot");
    }
    s_lastPollMs = 0;  // let the first UI-loop poll run immediately too
}

void powerPoll(uint32_t nowMs) {
    if (nowMs != 0 && (nowMs - s_lastPollMs) < POLL_INTERVAL_MS) return;
    s_lastPollMs = nowMs;

    uint16_t soc = 0;
    uint8_t gaugeErr = 0, chargerErr = 0;
    bool gaugeOk = readU16(GAUGE_ADDR, CMD_SOC, &soc, &gaugeErr) && soc <= 100;

    uint8_t chg = 0;
    bool chargerOk = readU8(CHARGER_ADDR, CHARGER_REG_STATUS, &chg, &chargerErr);
    bool powerGood = chargerOk && (chg & 0x04);            // PG_STAT
    uint8_t chrgStat = (uint8_t)((chg >> 3) & 0x03);       // CHRG_STAT
    bool charging = chargerOk && (chrgStat == 1 || chrgStat == 2);

    // Gauge sign-of-current as the charging fallback when the charger IC
    // doesn't answer (current is positive while charging on the BQ27220).
    if (!chargerOk && gaugeOk) {
        uint16_t rawCur = 0;
        if (readU16(GAUGE_ADDR, CMD_CURRENT, &rawCur, nullptr)) {
            charging = ((int16_t)rawCur) > 20;
            powerGood = charging;
        }
    }

    s_status.gaugeErr = gaugeErr;
    s_status.chargerErr = chargerErr;
    s_status.valid = gaugeOk;
    s_status.soc = (uint8_t)soc;
    s_status.usbPowered = powerGood;
    s_status.charging = charging;
}

PowerStatus powerStatus() {
    return s_status;
}

void powerOff() {
    // Don't drop PWR_EN while USB-powered. This board has no wake button (the
    // vendor's BOARD_USER_KEY is not populated), so a rail dropped while the
    // MCU stays alive on USB leaves nothing able to bring the peripherals back
    // except a physical power cycle. Deep sleep alone gives the same
    // user-visible result — dark, silent, resumable with RST — without that
    // risk.
    //
    // CORRECTION (2026-07-26): an earlier version of this comment claimed the
    // above was measured, citing an empty I2C scan and batteryDiag 4. It was
    // not. Those readings came from the T-Display-S3-Pro, which had been
    // flashed with t_embed firmware by mistake and was therefore scanning I2C
    // on pins 8/18 instead of its own 5/6. The T-Embed's gauge, charger and
    // PN532 were healthy the whole time. Keep this guard as the precaution it
    // is, and do not treat the latch behaviour as established.
    PowerStatus ps = powerStatus();
    if (!ps.usbPowered) {
        digitalWrite(BOARD_PIN_PWR_EN, LOW);
        delay(50);
    } else {
        Serial.println("[Power] USB-powered: deep sleep only (rail latch left armed)");
    }
    // No wake source is wired on this board (the vendor's BOARD_USER_KEY has
    // no physical button), so waking means pressing RST.
    esp_deep_sleep_start();
}

}  // namespace Input

#endif  // BOARD_T_EMBED
