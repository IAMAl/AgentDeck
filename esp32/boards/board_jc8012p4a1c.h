#pragma once

// ===== JC8012P4A1C — 10.1" IPS 800x1280 (JD9365 MIPI-DSI + GSL3680 I2C Touch) =====
// MCU: ESP32-P4NRW32 (RISC-V Dual-Core 400MHz, 32MB PSRAM, 16MB Flash)
// Co-processor: ESP32-C6-MINI-1U-N4
// Manufacturer: Guition (Jingcai)

#define BOARD_DISPLAY_TYPE   DISPLAY_JD9365_MIPI_DSI

// Display Pins
#define BOARD_PIN_RST        27
#define BOARD_PIN_BL         23

// Touch: GSL3680 (I2C)
#define BOARD_TOUCH_TYPE     TOUCH_GSL3680
#define BOARD_TOUCH_ADDR     0x40
#define BOARD_PIN_TOUCH_SDA  7
#define BOARD_PIN_TOUCH_SCL  8
#define BOARD_PIN_TOUCH_INT  21
#define BOARD_PIN_TOUCH_RST  22

// Display settings
#define BOARD_ROTATION       0     // Portrait native: 800 x 1280
#define BOARD_INVERT         false
#define BOARD_NATIVE_W       800   // Panel native width
#define BOARD_NATIVE_H       1280  // Panel native height

// Audio: ES8311 codec CONFIRMED at I2C 0x18 on the touch bus (I2C_NUM_1,
// SDA 7 / SCL 8) — chip ID 0xFD/0xFE = 0x83/0x11, version 0x01, ACK 5/5,
// registers at reset defaults. Measured 2026-07-27 with UI::hwI2cProbe()
// ({"type":"i2c_diag"}); the same sweep also found unidentified devices at
// 0x32 and 0x36.
//
// Still 0 because presence of the codec is not a playback path: whether a
// speaker and the two vendor-claimed mics are actually wired to it is
// unmeasured, and the I2S / MCLK / PA-enable pin map is unknown. Setting this
// to 1 requires that pin map plus an ES8311 I2C init sequence (unlike the
// T-Embed's bare I2S amp, this is a codec).
#define BOARD_HAS_AUDIO      0
