#if defined(BOARD_T_EMBED)

#include "ir_receiver.h"
#include "../../boards/board_config.h"

#include <Arduino.h>
#include <IRrecv.h>
#include <IRutils.h>

// 1024-entry raw buffer covers long AC-style frames; 15ms idle marks the end
// of a transmission (IRremoteESP8266's recommended value for reliable
// end-of-frame detection).
static constexpr uint16_t IR_BUF_SIZE = 1024;
static constexpr uint8_t IR_TIMEOUT_MS = 15;
// A held remote button repeats ~every 110ms — collapse the burst into one
// event so a long press does not fire the mapped command dozens of times.
static constexpr uint32_t SAME_CODE_DEBOUNCE_MS = 700;

static IRrecv s_irrecv(BOARD_PIN_IR_RX, IR_BUF_SIZE, IR_TIMEOUT_MS, true);
static decode_results s_results;
static bool s_enabled = false;
static char s_lastCode[24] = {0};
static uint32_t s_lastCodeMs = 0;

namespace Input {

bool irInit() {
    // The transceiver's enable line must be high before the receiver sees
    // anything (vendor utilities.h: BOARD_IR_EN).
    pinMode(BOARD_PIN_IR_EN, OUTPUT);
    digitalWrite(BOARD_PIN_IR_EN, HIGH);
    s_irrecv.enableIRIn();
    s_enabled = true;
    Serial.println("[IR] receiver enabled on GPIO" + String(BOARD_PIN_IR_RX));
    return s_enabled;
}

bool irReady() {
    return s_enabled;
}

bool irPoll(uint32_t nowMs, char* protoOut, size_t protoLen,
            char* codeOut, size_t codeLen) {
    if (!s_enabled || protoLen < 8 || codeLen < 8) return false;
    if (!s_irrecv.decode(&s_results)) return false;

    const bool repeat = s_results.repeat;
    const uint64_t value = s_results.value;
    const decode_type_t proto = s_results.decode_type;
    s_irrecv.resume();

    // Unknown-protocol frames carry a rolling hash rather than a stable code,
    // so mapping them would be unreliable; drop them (noise, fluorescent
    // flicker, and partial captures land here too).
    if (proto == decode_type_t::UNKNOWN || repeat || value == 0) return false;

    char code[24];
    snprintf(code, sizeof(code), "%llX", (unsigned long long)value);
    if (strcmp(code, s_lastCode) == 0 &&
        (uint32_t)(nowMs - s_lastCodeMs) < SAME_CODE_DEBOUNCE_MS) {
        s_lastCodeMs = nowMs;
        return false;
    }
    strncpy(s_lastCode, code, sizeof(s_lastCode) - 1);
    s_lastCodeMs = nowMs;

    String name = typeToString(proto, false);
    strncpy(protoOut, name.c_str(), protoLen - 1);
    protoOut[protoLen - 1] = '\0';
    strncpy(codeOut, code, codeLen - 1);
    codeOut[codeLen - 1] = '\0';
    return true;
}

}  // namespace Input

#endif  // BOARD_T_EMBED
