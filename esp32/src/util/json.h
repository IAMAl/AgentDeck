#pragma once
// Minimal JSON string escaping for firmware-composed outbound frames.
//
// Most outbound JSON on this firmware carries only ids and numbers, which need
// no escaping — the one exception is daemon-supplied TEXT echoed back (the
// AskUserQuestion `question` echo). That text is arbitrary: a quote or a
// backslash in it would close the string early and the daemon would drop the
// whole frame as unparseable, silently.
//
// Truncation is a first-class outcome here, not an error. `Net::queueOutbound`
// hard-truncates at OUTBOUND_MAX_LEN, and a JSON frame cut mid-string is
// garbage — so composing an oversize value must stop at a *whole* escape
// sequence and a *whole* UTF-8 character, leaving a shorter but still-valid
// frame. Callers that can tolerate a prefix (the question echo can: the daemon
// prefix-matches a device-truncated one) ignore the return value; callers that
// cannot should check it and omit the field instead.
//
// C++11-safe — shared by the pioarduino C++20/23 envs, the `led8x32`
// espressif32 env, and the host simulator (see esp32-dual-cpp-standard-build).
#include <stddef.h>
#include <stdint.h>

namespace Json {

/**
 * Append `src` to `dst` as an escaped JSON string body (no surrounding quotes).
 *
 * Writes only whole escape sequences and whole UTF-8 sequences, always leaving
 * `dst` NUL-terminated and valid. Returns true when all of `src` fit, false
 * when it was cut short (including when `src` itself ends mid-sequence, which
 * happens routinely: the device's copy of a question is a byte-truncated
 * strncpy of the daemon's).
 *
 * `cap` is the full size of `dst` including its NUL.
 */
inline bool escapeAppend(char* dst, size_t cap, const char* src) {
    if (!dst || cap == 0) return false;
    size_t n = 0;
    while (n + 1 < cap && dst[n]) n++;
    if (!src) { dst[n] = '\0'; return true; }

    bool complete = true;
    for (size_t i = 0; src[i];) {
        const uint8_t b = (uint8_t)src[i];
        char out[6];
        size_t consumed = 1;
        size_t written;

        if (b == '"' || b == '\\') {
            out[0] = '\\'; out[1] = (char)b; written = 2;
        } else if (b == '\n') {
            out[0] = '\\'; out[1] = 'n'; written = 2;
        } else if (b == '\r') {
            out[0] = '\\'; out[1] = 'r'; written = 2;
        } else if (b == '\t') {
            out[0] = '\\'; out[1] = 't'; written = 2;
        } else if (b < 0x20) {
            static const char kHex[] = "0123456789abcdef";
            out[0] = '\\'; out[1] = 'u'; out[2] = '0'; out[3] = '0';
            out[4] = kHex[(b >> 4) & 0x0F]; out[5] = kHex[b & 0x0F];
            written = 6;
        } else {
            // Raw UTF-8 passes through — JSON strings carry it verbatim. Copy
            // whole sequences only; a source that ends mid-sequence stops here
            // rather than emitting a broken lead byte.
            consumed = (b & 0xF8) == 0xF0 ? 4 : (b & 0xF0) == 0xE0 ? 3 : (b & 0xE0) == 0xC0 ? 2 : 1;
            bool truncatedSource = false;
            for (size_t k = 0; k < consumed; k++) {
                if (!src[i + k]) { truncatedSource = true; break; }
                out[k] = src[i + k];
            }
            if (truncatedSource) { complete = false; break; }
            written = consumed;
        }

        if (n + written + 1 > cap) { complete = false; break; }
        for (size_t k = 0; k < written; k++) dst[n++] = out[k];
        i += consumed;
    }
    dst[n] = '\0';
    return complete;
}

}  // namespace Json
