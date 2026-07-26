#if defined(BOARD_T_EMBED)

#include "mic_capture.h"
#include "../../boards/board_config.h"
#include "../net/ws_client.h"

#include <Arduino.h>
#include <ESP_I2S.h>

static constexpr uint32_t SAMPLE_RATE = 16000;   // what Apple's recognizer wants
static constexpr size_t READ_SAMPLES = 512;      // 1 KB per frame, ~32 ms
static constexpr uint32_t MAX_UTTERANCE_MS = 30000;

// After the user lets go, keep reading long enough to collect what the I2S DMA
// already holds. Releasing and stopping in the same instant clipped the last
// syllable off every utterance ("안녕하세요" reached the recognizer as "안녕하세").
static constexpr uint32_t TAIL_DRAIN_MS = 300;
// Don't wait forever for the ring to flush if the link is wedged — closing the
// utterance late is better than never closing it.
static constexpr uint32_t END_FLUSH_TIMEOUT_MS = 3000;

static I2SClass s_i2s;
static bool s_ready = false;
static bool s_capturing = false;
static uint32_t s_startedMs = 0;
static int16_t s_buf[READ_SAMPLES];
// Closing state: capture has stopped but voice_end must not be sent yet.
static bool s_closing = false;
static bool s_closingCancel = false;
static uint32_t s_closingSinceMs = 0;
static uint32_t s_closingDurationMs = 0;

namespace Audio {

bool micInit() {
    // PDM RX shares no pins with the speaker's STD TX, but both grab an I2S
    // peripheral — the S3 has two, so capture and the chime can coexist.
    s_i2s.setPinsPdmRx(BOARD_PIN_MIC_CLK, BOARD_PIN_MIC_DATA);
    s_ready = s_i2s.begin(I2S_MODE_PDM_RX, SAMPLE_RATE,
                          I2S_DATA_BIT_WIDTH_16BIT, I2S_SLOT_MODE_MONO);
    if (!s_ready) Serial.println("[Mic] PDM RX init failed — push-to-talk disabled");
    else Serial.println("[Mic] PDM RX ready (16 kHz mono)");
    return s_ready;
}

bool micReady() { return s_ready; }
bool micCapturing() { return s_capturing || s_closing; }

uint32_t micElapsedMs(uint32_t nowMs) {
    return s_capturing ? (uint32_t)(nowMs - s_startedMs) : 0;
}

void micStart(const char* sessionId) {
    if (!s_ready || s_capturing) return;
    s_closing = false;
    s_capturing = true;
    s_startedMs = millis();
    char frame[160];
    snprintf(frame, sizeof(frame),
             "{\"type\":\"voice_begin\",\"board\":\"t_embed\",\"format\":\"pcm16\","
             "\"sampleRate\":%lu,\"sessionId\":\"%s\"}",
             (unsigned long)SAMPLE_RATE, sessionId ? sessionId : "");
    Net::queueOutbound(frame);
    Serial.println("[Mic] capture start");
}

void micPump() {
    if (s_closing) {
        uint32_t since = millis() - s_closingSinceMs;
        // Phase 1: keep draining the mic so the tail of the last word is kept.
        if (since < TAIL_DRAIN_MS) {
            size_t got = s_i2s.readBytes((char*)s_buf, sizeof(s_buf));
            if (got > 0) Net::queueAudioChunk((const uint8_t*)s_buf, got);
            return;
        }
        // Phase 2: voice_end must not overtake the audio still in flight.
        // pumpOutbound() drains the JSON outbox BEFORE the PCM ring, so an
        // end frame queued while frames are pending reaches the daemon first
        // and the utterance is finalized without its tail.
        if (Net::audioBacklogged() && since < END_FLUSH_TIMEOUT_MS) return;
        char frame[96];
        snprintf(frame, sizeof(frame),
                 "{\"type\":\"voice_end\",\"durationMs\":%lu,\"cancel\":%s}",
                 (unsigned long)s_closingDurationMs, s_closingCancel ? "true" : "false");
        Net::queueOutbound(frame);
        Serial.printf("[Mic] capture stop (%lums%s, tail %lums)\n",
                      (unsigned long)s_closingDurationMs,
                      s_closingCancel ? ", cancelled" : "", (unsigned long)since);
        s_closing = false;
        return;
    }
    if (!s_capturing) return;
    // Runaway guard: a stuck button must not stream forever.
    if (millis() - s_startedMs > MAX_UTTERANCE_MS) {
        micStop(false);
        return;
    }
    size_t got = s_i2s.readBytes((char*)s_buf, sizeof(s_buf));
    if (got == 0) return;
    // A full ring means the link cannot keep up; drop this frame rather than
    // block — late audio is worthless and stalling here would also stall the UI.
    Net::queueAudioChunk((const uint8_t*)s_buf, got);
}

void micStop(bool cancel) {
    if (!s_capturing) return;
    s_capturing = false;
    // Enter the closing state instead of ending here: micPump() drains the tail
    // and only then queues voice_end. See TAIL_DRAIN_MS.
    s_closing = true;
    s_closingCancel = cancel;
    s_closingSinceMs = millis();
    s_closingDurationMs = millis() - s_startedMs;
}

}  // namespace Audio

#endif  // BOARD_T_EMBED
