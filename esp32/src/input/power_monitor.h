#pragma once

#include <cstdint>

// T-Embed battery/charger telemetry: BQ27220 fuel gauge (0x55) for state of
// charge, BQ25896 charger (0x6B) for USB-power/charging status. Polled from
// the UI task; every read is defensive — a failed bus read flips valid=false
// and the UI hides the battery cluster instead of showing garbage.

namespace Input {

struct PowerStatus {
    bool valid;        // gauge answered — battery UI may render
    uint8_t soc;       // state of charge, 0-100 %
    bool usbPowered;   // charger power-good (VBUS present)
    bool charging;     // charger actively charging (pre/fast charge)
    // Last-read diagnostics, surfaced through device_info so a failing I2C
    // path is debuggable from the daemon without stealing the serial port.
    // Wire codes: 0 ok, 2 NACK-addr, 3 NACK-data, 5 timeout; 100+n = requestFrom short read n.
    uint8_t gaugeErr;
    uint8_t chargerErr;
};

void powerInit();

// Log every address answering on the shared I2C bus. Used to pin down which
// init step kills the bus when a peripheral stops responding.
void i2cScanLog(const char* tag);

// Cheap cadence guard — reads I2C at most every few seconds.
void powerPoll(uint32_t nowMs);

PowerStatus powerStatus();

// Clean shutdown: latch the power rail off (battery operation dies here) and
// deep-sleep as the USB-powered fallback, waking on the side key.
void powerOff();

}  // namespace Input
