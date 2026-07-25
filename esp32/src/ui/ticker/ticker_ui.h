#pragma once

// T-Display-S3-Pro "Tide Ticker" — a 480x222 always-on desk strip.
// Page 0: Claude/Codex quota gauges. Page 1: session ticker rows.
// Three hardware buttons page it (prev / next / auto-cycle toggle).

namespace Ticker {

void create();
void update(float dt);

void nextPage();
void prevPage();
void toggleAutoCycle();

}  // namespace Ticker
