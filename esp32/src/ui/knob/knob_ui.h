#pragma once

#include "../../input/encoder.h"

// T-Embed "Companion Knob" UI — two-level session steering on 320x170.
// List level: rotate cycles sessions, press enters. Detail level: rotate moves
// the command/option cursor, press commits, long-press backs out.
// Grammar: docs/esp32-companion-concepts.md (the Stream Deck two-level UX
// translated to an encoder).

namespace Knob {

// Build the screen tree and load it. Call once from the UI task after
// UI::displayInit().
void create();

// Per-frame: snapshot shared state, rebuild widgets when content changed.
void update(float dt);

// Encoder input (UI task).
void onRotate(int detents);
void onKey(Input::KeyEvent evt);

// Session index the cursor is on (list level: hovered; detail level: entered).
// -1 when there are no sessions. Drives the ring highlight.
int selectedSessionIdx();

}  // namespace Knob
