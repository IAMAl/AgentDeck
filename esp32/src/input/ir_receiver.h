#pragma once

#include <cstddef>
#include <cstdint>

// IR receive — the second peripheral primitive (peripheral_event kind
// "ir_rx"). Read-only: the firmware reports protocol + code; what a button
// MEANS is daemon-side mapping config (settings.json peripheralMappings).

namespace Input {

bool irInit();
bool irReady();

// Poll for a decoded frame. Returns true when a NEW code (debounced, repeats
// suppressed) was decoded; fills protocol name and uppercase-hex code.
bool irPoll(uint32_t nowMs, char* protoOut, size_t protoLen,
            char* codeOut, size_t codeLen);

}  // namespace Input
