#if defined(BOARD_T_EMBED)

#include "nfc_reader.h"
#include "../../boards/board_config.h"

#include <Arduino.h>
#include <Wire.h>
#include <Adafruit_PN532.h>

static Adafruit_PN532 s_nfc(BOARD_PIN_NFC_IRQ, BOARD_PIN_NFC_RST, &Wire);
static bool s_enabled = false;
static uint32_t s_lastPollMs = 0;
static char s_lastUid[24] = {0};
static uint32_t s_lastUidMs = 0;

static constexpr uint32_t POLL_INTERVAL_MS = 1500;
static constexpr uint32_t SAME_TAG_DEBOUNCE_MS = 4000;
// Short blocking budget — this runs on the UI task; one skipped frame every
// poll interval is invisible, a long stall is not.
static constexpr uint16_t READ_TIMEOUT_MS = 30;

namespace Input {

bool nfcInit() {
    // Adafruit_PN532::begin() calls Wire.begin() with NO arguments. That is
    // safe here only because powerInit() pinned the bus with Wire.setPins()
    // first — without it this call silently moved SCL to the S3 default and
    // took the fuel gauge down with it.
    s_nfc.begin();
    uint32_t version = s_nfc.getFirmwareVersion();
    if (version == 0) {
        Serial.println("[NFC] PN532 not answering — NFC disabled");
        // Say what IS on the bus: this distinguishes "chip absent / different
        // address" from "chip present but wedged", which the vendor spec sheet
        // alone cannot.
        Serial.print("[NFC] I2C scan:");
        for (uint8_t addr = 0x08; addr < 0x78; addr++) {
            Wire.beginTransmission(addr);
            if (Wire.endTransmission() == 0) Serial.printf(" 0x%02X", addr);
        }
        Serial.println();
        s_enabled = false;
        return false;
    }
    s_nfc.SAMConfig();
    s_enabled = true;
    Serial.printf("[NFC] PN532 ready (fw %lu.%lu)\n",
                  (unsigned long)((version >> 16) & 0xFF),
                  (unsigned long)((version >> 8) & 0xFF));
    return true;
}

bool nfcReady() { return s_enabled; }

bool nfcPoll(uint32_t nowMs, char* uidOut, size_t uidOutLen) {
    if (!s_enabled || uidOutLen < 15) return false;
    if ((uint32_t)(nowMs - s_lastPollMs) < POLL_INTERVAL_MS) return false;
    s_lastPollMs = nowMs;

    uint8_t uid[7] = {0};
    uint8_t uidLen = 0;
    if (!s_nfc.readPassiveTargetID(PN532_MIFARE_ISO14443A, uid, &uidLen,
                                   READ_TIMEOUT_MS)) {
        return false;
    }
    if (uidLen == 0 || uidLen > 7) return false;

    char hex[16];
    for (uint8_t i = 0; i < uidLen; i++) {
        snprintf(&hex[i * 2], 3, "%02X", uid[i]);
    }
    hex[uidLen * 2] = '\0';

    // Debounce: a tag resting on the reader must not spam events.
    if (strcmp(hex, s_lastUid) == 0 &&
        (uint32_t)(nowMs - s_lastUidMs) < SAME_TAG_DEBOUNCE_MS) {
        s_lastUidMs = nowMs;
        return false;
    }
    strncpy(s_lastUid, hex, sizeof(s_lastUid) - 1);
    s_lastUidMs = nowMs;

    strncpy(uidOut, hex, uidOutLen - 1);
    uidOut[uidOutLen - 1] = '\0';
    return true;
}

}  // namespace Input

#endif  // BOARD_T_EMBED
