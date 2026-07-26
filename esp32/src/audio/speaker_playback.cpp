#if defined(BOARD_T_EMBED)

#include "speaker_playback.h"
#include "../../boards/board_config.h"

#include <Arduino.h>
#include <ESP_I2S.h>
#include <esp_heap_caps.h>
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>
#include <freertos/semphr.h>

// 64 KB = 2 s of 16 kHz mono PCM16. The daemon paces frames at playback speed,
// so this only has to absorb WiFi jitter, not a whole reply — a reply can run
// tens of seconds and will never fit in RAM.
static constexpr size_t RING_BYTES = 64 * 1024;
// Below this the playback task waits instead of writing, so a hiccup becomes a
// short pause rather than a burst of silence mid-word.
static constexpr size_t PREBUFFER_BYTES = 8 * 1024;
// Give up if the daemon goes quiet mid-utterance: without this the task would
// hold I2S open forever after a dropped link.
static constexpr uint32_t STARVE_TIMEOUT_MS = 8000;

static uint8_t* s_ring = nullptr;
static volatile size_t s_head = 0;   // read cursor
static volatile size_t s_tail = 0;   // write cursor
static SemaphoreHandle_t s_mutex = nullptr;
static volatile bool s_streaming = false;   // daemon still sending
static volatile bool s_playing = false;     // task alive
static volatile bool s_abort = false;
static uint32_t s_sampleRate = 16000;
// Utterance accounting. Without it a silent speaker is indistinguishable from
// audio that never arrived, which is exactly the ambiguity that made the mic
// side hard to debug.
static volatile uint32_t s_fedBytes = 0;
static volatile uint32_t s_playedBytes = 0;
static volatile uint32_t s_droppedFrames = 0;

static size_t ringAvailable() {
    size_t head = s_head, tail = s_tail;
    return (tail >= head) ? (tail - head) : (RING_BYTES - head + tail);
}

static size_t ringFree() {
    // Keep one byte unused so full and empty stay distinguishable.
    return RING_BYTES - ringAvailable() - 1;
}

static size_t ringRead(uint8_t* out, size_t want) {
    size_t avail = ringAvailable();
    if (want > avail) want = avail;
    size_t head = s_head;
    for (size_t i = 0; i < want; i++) {
        out[i] = s_ring[head];
        head = (head + 1) % RING_BYTES;
    }
    s_head = head;
    return want;
}

static void playbackTask(void* param) {
    (void)param;
    I2SClass i2s;
    i2s.setPins(BOARD_PIN_SPK_BCLK, BOARD_PIN_SPK_LRCLK, BOARD_PIN_SPK_DIN, -1, -1);
    if (!i2s.begin(I2S_MODE_STD, (uint32_t)s_sampleRate,
                   I2S_DATA_BIT_WIDTH_16BIT, I2S_SLOT_MODE_MONO)) {
        Serial.println("[Speaker] I2S begin failed");
        s_playing = false;
        s_streaming = false;
        vTaskDelete(nullptr);
        return;
    }

    // Wait for the prebuffer (or for the utterance to prove itself short).
    uint32_t waitStart = millis();
    while (!s_abort && s_streaming && ringAvailable() < PREBUFFER_BYTES &&
           (millis() - waitStart) < 1500) {
        vTaskDelay(pdMS_TO_TICKS(10));
    }

    uint8_t chunk[1024];
    uint32_t lastDataMs = millis();
    while (!s_abort) {
        size_t got = 0;
        xSemaphoreTake(s_mutex, portMAX_DELAY);
        got = ringRead(chunk, sizeof(chunk));
        xSemaphoreGive(s_mutex);

        if (got > 0) {
            i2s.write(chunk, got);
            s_playedBytes += got;
            lastDataMs = millis();
            continue;
        }
        // Ring empty: done if the daemon finished, otherwise wait for more.
        if (!s_streaming) break;
        if ((millis() - lastDataMs) > STARVE_TIMEOUT_MS) {
            Serial.println("[Speaker] starved — ending playback");
            break;
        }
        vTaskDelay(pdMS_TO_TICKS(5));
    }

    i2s.end();
    Serial.printf("[Speaker] played %lu/%lu bytes (%.1fs), %lu frames dropped%s\n",
                  (unsigned long)s_playedBytes, (unsigned long)s_fedBytes,
                  (double)s_playedBytes / 2.0 / (double)s_sampleRate,
                  (unsigned long)s_droppedFrames,
                  s_abort ? ", aborted" : "");
    s_playing = false;
    s_streaming = false;
    s_abort = false;
    vTaskDelete(nullptr);
}

namespace Audio {

bool playbackInit() {
    if (s_ring) return true;
    if (!s_mutex) s_mutex = xSemaphoreCreateMutex();
    if (!s_mutex) return false;
    // PSRAM first: 64 KB of internal RAM is too much to hold hostage for audio
    // on a board that also runs LVGL.
    s_ring = (uint8_t*)heap_caps_malloc(RING_BYTES, MALLOC_CAP_SPIRAM);
    if (!s_ring) s_ring = (uint8_t*)malloc(RING_BYTES);
    if (!s_ring) {
        Serial.println("[Speaker] ring allocation failed — playback disabled");
        return false;
    }
    Serial.printf("[Speaker] playback ready (%u KB ring)\n",
                  (unsigned)(RING_BYTES / 1024));
    return true;
}

bool playbackReady() { return s_ring != nullptr; }

void playbackBegin(uint32_t sampleRate) {
    if (!playbackInit()) return;
    if (s_playing) playbackStop();
    // Wait out the previous task so two I2S TX channels never overlap.
    uint32_t start = millis();
    while (s_playing && (millis() - start) < 500) delay(5);

    xSemaphoreTake(s_mutex, portMAX_DELAY);
    s_head = 0;
    s_tail = 0;
    xSemaphoreGive(s_mutex);
    s_sampleRate = (sampleRate >= 8000 && sampleRate <= 48000) ? sampleRate : 16000;
    s_abort = false;
    s_fedBytes = 0;
    s_playedBytes = 0;
    s_droppedFrames = 0;
    s_streaming = true;
    s_playing = true;
    if (xTaskCreate(playbackTask, "spk_play", 4096, nullptr, 2, nullptr) != pdPASS) {
        Serial.println("[Speaker] task spawn failed");
        s_playing = false;
        s_streaming = false;
    }
}

bool playbackFeed(const uint8_t* data, size_t len) {
    if (!s_ring || !data || len == 0 || !s_streaming) return false;
    bool ok = false;
    xSemaphoreTake(s_mutex, portMAX_DELAY);
    if (ringFree() >= len) {
        size_t tail = s_tail;
        for (size_t i = 0; i < len; i++) {
            s_ring[tail] = data[i];
            tail = (tail + 1) % RING_BYTES;
        }
        s_tail = tail;
        s_fedBytes += len;
        ok = true;
    } else {
        s_droppedFrames++;
    }
    xSemaphoreGive(s_mutex);
    return ok;
}

void playbackEnd() {
    // Leave s_playing alone: the task drains the ring, then exits on its own.
    s_streaming = false;
}

bool playbackActive() { return s_playing || s_streaming; }

void playbackStop() {
    s_abort = true;
    s_streaming = false;
}

}  // namespace Audio

#endif  // BOARD_T_EMBED
