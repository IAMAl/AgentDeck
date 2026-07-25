#if defined(BOARD_T_EMBED)

#include "chime.h"
#include "../../../boards/board_config.h"

#include <Arduino.h>
#include <ESP_I2S.h>
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>
#include <math.h>

static volatile bool s_playing = false;

static void writeTone(I2SClass& i2s, float freqHz, uint32_t ms, uint16_t amplitude) {
    constexpr uint32_t RATE = 16000;
    const uint32_t total = RATE * ms / 1000;
    int16_t buf[256];
    uint32_t written = 0;
    float phase = 0.0f;
    const float step = 2.0f * (float)M_PI * freqHz / RATE;
    while (written < total) {
        uint32_t n = total - written;
        if (n > 256) n = 256;
        for (uint32_t i = 0; i < n; i++) {
            // Short attack/decay ramp so the note doesn't click.
            uint32_t idx = written + i;
            float env = 1.0f;
            if (idx < 320) env = idx / 320.0f;
            else if (total - idx < 320) env = (total - idx) / 320.0f;
            buf[i] = (int16_t)(sinf(phase) * amplitude * env);
            phase += step;
            if (phase > 2.0f * (float)M_PI) phase -= 2.0f * (float)M_PI;
        }
        i2s.write((uint8_t*)buf, n * sizeof(int16_t));
        written += n;
    }
}

static void chimeTask(void* param) {
    (void)param;
    I2SClass i2s;
    i2s.setPins(BOARD_PIN_SPK_BCLK, BOARD_PIN_SPK_LRCLK, BOARD_PIN_SPK_DIN, -1, -1);
    if (i2s.begin(I2S_MODE_STD, 16000, I2S_DATA_BIT_WIDTH_16BIT, I2S_SLOT_MODE_MONO)) {
        // Two-note rising chime, quiet enough for a desk (amp ≈ 18% FS).
        writeTone(i2s, 880.0f, 110, 6000);
        writeTone(i2s, 1318.5f, 140, 6000);
        i2s.end();
    }
    s_playing = false;
    vTaskDelete(nullptr);
}

namespace Chime {

void playAttention() {
    if (s_playing) return;  // coalesce overlapping requests
    s_playing = true;
    if (xTaskCreate(chimeTask, "chime", 4096, nullptr, 1, nullptr) != pdPASS) {
        s_playing = false;
    }
}

}  // namespace Chime

#endif  // BOARD_T_EMBED
