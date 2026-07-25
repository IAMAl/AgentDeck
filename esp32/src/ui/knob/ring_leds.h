#pragma once

#include <cstdint>

// 8x WS2812 session-status ring around the T-Embed knob.
// LED i mirrors session i (fleet order). Semantic status colors; per the
// design-system rule only amber (awaiting) animates — kelp/coral stay static.

namespace Ring {

void init();

// Render one frame from the shared dashboard state. selectedIdx (-1 = none)
// brightens that session's LED and dims the rest — the cursor cue.
// dark=true blanks the ring entirely (host display-sleep contract: off must
// be dark). Call from the UI task (locks g_state internally).
void update(uint32_t nowMs, int selectedIdx, bool connected, bool dark);

}  // namespace Ring
