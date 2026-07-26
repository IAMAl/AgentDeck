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

// Show a transient footer notification (e.g. "NFC 04A1B2C3").
void notify(const char* text);

// True at the list level (no session entered) — where holding the encoder
// means "talk" rather than "back".
bool atListLevel();

// True once (and cleared) after the user picks Power off in the detail menu.
bool consumePowerOffRequest();

// Human label of the session the knob is pointing at ("AgentDeck · Claude"),
// so a voice capture can say out loud who it is about to talk to.
const char* focusedSessionLabel();

// Persistent "listening" banner while a push-to-talk capture runs. Unlike the
// transient flash, this must stay on screen for the whole hold — the user has
// to be able to see WHICH session they are speaking to while speaking.
void setListening(const char* targetLabel);
void clearListening();

// Session id the knob is pointing at (detail session, else the hovered list
// session). Empty string when there are none — the voice target.
const char* focusedSessionId();

// Session index the cursor is on (list level: hovered; detail level: entered).
// -1 when there are no sessions. Drives the ring highlight.
int selectedSessionIdx();

}  // namespace Knob
