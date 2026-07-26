#pragma once

#include <lvgl.h>

/**
 * Montserrat 12 + Korean fallback (Noto Sans KR 12).
 * RAM copy of lv_font_montserrat_12 with fallback pointer set.
 * Use &font_kr_12 instead of &lv_font_montserrat_12 for labels
 * that may display Korean text (session names, timeline, etc.).
 * Initialized in displayInit().
 */
extern lv_font_t font_kr_12;
#if defined(BOARD_IPS10)
/** Larger Korean-safe faces (Latin at size, Korean via 12 px Noto fallback) for the IPS10 D1 detail overlay. */
extern lv_font_t font_kr_16;
extern lv_font_t font_kr_20;
#elif defined(BOARD_T_DISPLAY_PRO)
/** 16px Korean-safe face for the Focus Strip caption (~1.5MB flash; 6MB OTA slot has room). */
extern lv_font_t font_kr_16;
#endif

namespace UI {

/**
 * Initialize display driver (LovyanGFX), LVGL, touch input.
 * Must be called from LVGL core (Core 1).
 */
void displayInit();

/**
 * Get the main LVGL display pointer.
 */
lv_display_t* getDisplay();

/**
 * Set display backlight brightness (0-255).
 */
void setBrightness(int level);

/**
 * LVGL tick handler — call from timer ISR or task.
 */
void lvglTick();

/**
 * LVGL task handler — call from LVGL core loop.
 */
void lvglLoop();

/**
 * Switch display orientation at runtime (IPS 3.5" only).
 * Landscape = 480×320, Portrait = 320×480.
 * Updates g_screenW/g_screenH, hardware rotation, LVGL resolution, NVS.
 * Caller must recreate LVGL screens after calling this.
 */
void setOrientation(bool landscape);

/**
 * 90° rotation steps for small SPI panels (TTGO / C6): index 0-3.
 * 0 = upright portrait, 1 = landscape, 2 = flipped portrait, 3 = flipped landscape.
 * Persists to NVS. Caller must recreate LVGL screens after calling this.
 */
void setRotationIndex(uint8_t idx);
uint8_t getRotationIndex();

/**
 * Periodic panel self-heal (TTGO): re-assert DISPON + backlight duty.
 * No-op on other boards.
 */
void reassertPanel();

/**
 * Returns true if display is in landscape mode.
 */
bool isLandscape();

}  // namespace UI
