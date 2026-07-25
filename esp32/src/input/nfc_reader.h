#pragma once

#include <cstddef>
#include <cstdint>

// PN532 NFC tag reader — the first peripheral primitive (peripheral_event
// kind "nfc_tag"). Read-only: the firmware reports tap events; what a tag
// MEANS (project bookmark, approve gate) is daemon-side mapping config.

namespace Input {

// Probe the PN532 on the shared I2C bus. Returns false when it doesn't
// answer — polling is then permanently disabled for this boot.
bool nfcInit();

// Poll for a tag (self-throttled, short timeout). Returns true when a NEW tag
// (debounced) was read and writes its uppercase-hex UID into uidOut.
bool nfcPoll(uint32_t nowMs, char* uidOut, size_t uidOutLen);

}  // namespace Input
