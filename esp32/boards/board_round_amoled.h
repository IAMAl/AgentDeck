#pragma once

// ===== JC3636W518 — 1.8" Round AMOLED 360x360 (ST77916 QSPI + CST816S) =====
// Port: cu.usbmodem201201 (Native JTAG)
// MAC: D0:CF:13:1E:0B:64
// Manufacturer: Guition (Jingcai)

// Display: ST77916 (QSPI interface)
// Verified pinout from modi12jin, clowrey, freddy-, ESP32_Display_Panel #176
#define BOARD_DISPLAY_TYPE   DISPLAY_ST77916_QSPI
#define BOARD_PIN_QSPI_CS   10
#define BOARD_PIN_QSPI_CLK  9
#define BOARD_PIN_QSPI_D0   11
#define BOARD_PIN_QSPI_D1   12
#define BOARD_PIN_QSPI_D2   13
#define BOARD_PIN_QSPI_D3   14
#define BOARD_PIN_RST        47
#define BOARD_PIN_BL         15

// Touch: CST816S (I2C)
#define BOARD_TOUCH_TYPE     TOUCH_CST816S
#define BOARD_TOUCH_ADDR     0x15
#define BOARD_PIN_TOUCH_SDA  7
#define BOARD_PIN_TOUCH_SCL  8
#define BOARD_PIN_TOUCH_INT  41
#define BOARD_PIN_TOUCH_RST  40

// Display settings
#define BOARD_ROTATION       0
#define BOARD_INVERT         false
#define BOARD_NATIVE_W       360   // Actual resolution (not 240!)
#define BOARD_NATIVE_H       360

// Audio: NO hardware — MEMS mic/codec chip not populated on this board.
// GPIOs 45/46 are exposed on header but no I2S peripheral is connected.
// 3.5mm jack (if present) is for antenna/serial debug, NOT audio.
//
// The commented-out BOARD_HAS_AUDIO / I2S PDM pins that used to sit here were
// the intended home of the on-board microWakeWord listener. That firmware was
// removed on 2026-08-05 (it only ever ran an RMS VAD, never the model, and no
// board started its task) — see docs/wake-word.md § 2.
