#pragma once

#include "../../boards/board_config.h"   // defines BOARD_SPK_CODEC_ES8311

#if defined(BOARD_SPK_CODEC_ES8311)

#include <stdint.h>

/**
 * Minimal ES8311 bring-up for playback.
 *
 * Unlike the T-Embed's bare I2S amplifier — where `i2s.setPins()` is the whole
 * driver — the ES8311 is a codec: it needs an I2C register sequence, a master
 * clock, and a PA-enable line before a single sample means anything. This is
 * the DAC half only; the ADC (mic) side is out of scope until the analog side
 * is proven.
 *
 * Register sequence ported from Espressif's esp-adf / esp_codec_dev `es8311.c`.
 * I2C rides the panel's existing bus through `UI::hwI2cReadReg8/WriteReg8`, so
 * there is still exactly one I2C master on those pads.
 *
 * Fixed operating point, matching the daemon's voice-reply format: 16 kHz,
 * 16-bit, mono, MCLK = 256 x Fs = 4.096 MHz (the multiple ESP_I2S emits by
 * default), which selects the {4096000, 16000} coefficient row.
 */
namespace Es8311 {

/** Probe + full DAC init. Safe to call repeatedly; re-inits each time. */
bool begin(uint32_t sampleRate);

/** True once begin() has confirmed the chip ID and completed the sequence. */
bool ready();

/** Power the amplifier down and park the codec. */
void stop();

/** 0-100. Maps onto the codec's 0x00-0xFF DAC volume register. */
void setVolume(int percent);

}  // namespace Es8311

#endif  // BOARD_SPK_CODEC_ES8311
