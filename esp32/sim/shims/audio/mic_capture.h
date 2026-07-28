#pragma once
// Host shim for <audio/mic_capture.h> — the PTT button queries mic readiness and
// starts/stops capture. There is no I2S on the host, so the sim renders the
// board as mic-ready-but-idle: that is the state the layout has to look right
// in, and it keeps the voice button visible in every scene.
#include <stdint.h>
namespace Audio {
bool micInit();
bool micReady();
bool micCapturing();
uint32_t micElapsedMs(uint32_t nowMs);
void micStart(const char* sessionId);
void micPump();
void micStop(bool cancel);
}  // namespace Audio
