#pragma once

// T-Display-S3-Pro "Tide Ticker" — a 480x222 always-on desk strip.
// Page 0: Claude/Codex quota gauges. Page 1: session ticker rows.
// Three hardware buttons page it (prev / next / auto-cycle toggle).

#include "../../input/touch_strip.h"

namespace Ticker {

void create();
void update(float dt);

void nextPage();
void prevPage();
void toggleAutoCycle();

// Strip gesture: on the Focus page, TAP approves / HOLD denies the captioned
// awaiting session; on other pages TAP jumps back to the Focus page.
void onTouch(Input::TouchGesture g);

}  // namespace Ticker
