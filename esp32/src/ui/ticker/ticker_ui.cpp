#if defined(BOARD_T_DISPLAY_PRO)

#include "ticker_ui.h"
#include "../../state/agent_state.h"
#include "../../net/wifi_manager.h"
#include "../../net/ws_client.h"
#include "../display.h"
#include "../theme.h"
#include "../agent_label.h"
#include "../../util/utf8.h"

#include <Arduino.h>
#include <lvgl.h>
#include <stdio.h>
#include <string.h>

static constexpr uint8_t PAGE_COUNT = 2;
static constexpr uint32_t AUTO_CYCLE_MS = 8000;

static uint8_t s_page = 0;
static bool s_autoCycle = true;
static uint32_t s_lastCycleMs = 0;

static lv_obj_t* s_scr = nullptr;
static lv_obj_t* s_headerLeft = nullptr;
static lv_obj_t* s_headerRight = nullptr;
static lv_obj_t* s_hdrWifi = nullptr;
static lv_obj_t* s_body = nullptr;

static char s_lastSig[224] = {0};

static lv_obj_t* makeLabel(lv_obj_t* parent, const lv_font_t* font,
                           uint32_t color, const char* text) {
    lv_obj_t* l = lv_label_create(parent);
    lv_obj_set_style_text_font(l, font, 0);
    lv_obj_set_style_text_color(l, lv_color_hex(color), 0);
    lv_label_set_text(l, text);
    return l;
}

static uint32_t gaugeColor(float pct) {
    if (pct >= 85.0f) return Theme::StatusRed;
    if (pct >= 60.0f) return Theme::StatusAmber;
    return Theme::StatusGreen;
}

// One full-fill gauge row: label | bar (fill = pct) | % numeral | reset.
static void renderGaugeRow(lv_obj_t* parent, int y, const char* label,
                           float pct, const char* reset) {
    lv_obj_t* name = makeLabel(parent, &lv_font_montserrat_14, Theme::HUDText, label);
    lv_obj_align(name, LV_ALIGN_TOP_LEFT, 10, y + 8);

    lv_obj_t* track = lv_obj_create(parent);
    lv_obj_remove_style_all(track);
    lv_obj_set_size(track, 240, 30);
    lv_obj_set_style_bg_color(track, lv_color_hex(Theme::MidWater), 0);
    lv_obj_set_style_bg_opa(track, LV_OPA_COVER, 0);
    lv_obj_set_style_radius(track, 4, 0);
    lv_obj_align(track, LV_ALIGN_TOP_LEFT, 110, y);

    bool haveData = pct >= 0.0f;
    if (haveData) {
        float clamped = pct > 100.0f ? 100.0f : pct;
        int w = (int)(240.0f * clamped / 100.0f);
        if (w > 0) {
            lv_obj_t* fill = lv_obj_create(track);
            lv_obj_remove_style_all(fill);
            lv_obj_set_size(fill, w < 4 ? 4 : w, 30);
            lv_obj_set_style_bg_color(fill, lv_color_hex(gaugeColor(clamped)), 0);
            lv_obj_set_style_bg_opa(fill, LV_OPA_COVER, 0);
            lv_obj_set_style_radius(fill, 4, 0);
            lv_obj_align(fill, LV_ALIGN_LEFT_MID, 0, 0);
        }
        // White numeral ON the bar (gauge grammar: full fill, sharp stage
        // colors, white numerals).
        char pctText[8];
        snprintf(pctText, sizeof(pctText), "%d%%", (int)clamped);
        lv_obj_t* p = makeLabel(track, &lv_font_montserrat_14, 0xFFFFFF, pctText);
        lv_obj_align(p, LV_ALIGN_LEFT_MID, 8, 0);
    } else {
        lv_obj_t* p = makeLabel(track, &lv_font_montserrat_14, Theme::HUDFaint, "--");
        lv_obj_align(p, LV_ALIGN_LEFT_MID, 8, 0);
    }

    lv_obj_t* r = makeLabel(parent, &lv_font_montserrat_12, Theme::HUDDim,
                            (haveData && reset[0]) ? reset : "");
    lv_obj_align(r, LV_ALIGN_TOP_LEFT, 362, y + 9);
}

static void renderUsagePage() {
    // Only windows that exist render — a retired window (e.g. Codex 5h on
    // current plans) disappears instead of showing a fabricated "--" row.
    struct GaugeData { const char* label; float pct; char reset[20]; };
    GaugeData rows[4];
    uint8_t n = 0;
    char subsLine[96] = {0};

    lockState();
    auto take = [&](const char* label, float pct, const char* reset) {
        if (pct < 0.0f) return;
        rows[n].label = label;
        rows[n].pct = pct;
        strncpy(rows[n].reset, reset, sizeof(rows[n].reset) - 1);
        rows[n].reset[sizeof(rows[n].reset) - 1] = '\0';
        n++;
    };
    take("Claude 5h", g_state.fiveHourPercent, g_state.fiveHourReset);
    take("Claude 7d", g_state.sevenDayPercent, g_state.sevenDayReset);
    take("Codex 5h", g_state.codexPrimaryPercent, g_state.codexPrimaryReset);
    take("Codex 7d", g_state.codexSecondaryPercent, g_state.codexSecondaryReset);
    // Account subscriptions (usage_update subscriptions[]) — the "what am I
    // paying for" line other dashboards carry.
    {
        size_t off = 0;
        for (uint8_t i = 0; i < g_state.subscriptionCount && off < sizeof(subsLine) - 24; i++) {
            off += snprintf(subsLine + off, sizeof(subsLine) - off, "%s%s %s",
                            i > 0 ? "  " LV_SYMBOL_BULLET "  " : "",
                            g_state.subscriptions[i].name,
                            g_state.subscriptions[i].until);
        }
    }
    unlockState();

    bool haveSubs = subsLine[0] != '\0';
    if (n == 0 && !haveSubs) {
        lv_obj_t* l = makeLabel(s_body, &lv_font_montserrat_14, Theme::HUDDim,
                                "Waiting for usage data...");
        lv_obj_align(l, LV_ALIGN_CENTER, 0, 0);
        return;
    }

    int areaH = haveSubs ? 174 : 198;
    int pitch = n > 0 ? areaH / (n > 0 ? n : 1) : 0;
    if (pitch > 52) pitch = 52;
    for (uint8_t i = 0; i < n; i++) {
        renderGaugeRow(s_body, 4 + i * pitch, rows[i].label, rows[i].pct, rows[i].reset);
    }

    if (haveSubs) {
        Utf8::sanitizeLvglText(subsLine);
        lv_obj_t* s = makeLabel(s_body, &lv_font_montserrat_12, Theme::HUDDim, subsLine);
        lv_label_set_long_mode(s, LV_LABEL_LONG_DOT);
        lv_obj_set_width(s, 460);
        lv_obj_align(s, LV_ALIGN_BOTTOM_LEFT, 10, -3);
    }
}

static uint32_t agentColor(const char* agentType) {
    if (strcmp(agentType, "claude-code") == 0) return Theme::ClaudeBody;
    if (strncmp(agentType, "codex", 5) == 0) return Theme::CloudBody;
    if (strcmp(agentType, "openclaw") == 0) return Theme::CrayfishShell;
    if (strcmp(agentType, "opencode") == 0) return Theme::OpenCodeOuter;
    return Theme::HUDDim;
}

static uint32_t stateColorOf(const char* state) {
    if (strstr(state, "awaiting") != nullptr) return Theme::StatusAmber;
    if (strcmp(state, "processing") == 0) return Theme::StatusBlue;
    if (strcmp(state, "idle") == 0) return Theme::StatusGreen;
    return Theme::HUDDim;
}

static void renderSessionsPage() {
    struct Row {
        char agentType[16];
        char projectName[40];
        char state[20];
        char line[100];
    } rows[5];
    uint8_t n = 0;
    lockState();
    for (uint8_t i = 0; i < g_state.sessionCount && n < 5; i++) {
        const SessionInfo& s = g_state.sessions[i];
        strncpy(rows[n].agentType, s.agentType, sizeof(rows[n].agentType));
        strncpy(rows[n].projectName, s.projectName, sizeof(rows[n].projectName));
        strncpy(rows[n].state, s.state, sizeof(rows[n].state));
        // Glance rule: milestone line, live tool belongs to state surfaces.
        strncpy(rows[n].line, s.lastEventText[0] ? s.lastEventText : s.activity,
                sizeof(rows[n].line));
        n++;
    }
    unlockState();

    if (n == 0) {
        lv_obj_t* l = makeLabel(s_body, &lv_font_montserrat_14, Theme::HUDDim,
                                "No active sessions");
        lv_obj_align(l, LV_ALIGN_CENTER, 0, 0);
        return;
    }

    for (uint8_t i = 0; i < n; i++) {
        Utf8::sanitizeLvglText(rows[i].projectName);
        Utf8::sanitizeLvglText(rows[i].line);
        int y = 2 + i * 39;

        lv_obj_t* dot = lv_obj_create(s_body);
        lv_obj_remove_style_all(dot);
        lv_obj_set_size(dot, 8, 8);
        lv_obj_set_style_bg_color(dot, lv_color_hex(stateColorOf(rows[i].state)), 0);
        lv_obj_set_style_bg_opa(dot, LV_OPA_COVER, 0);
        lv_obj_set_style_radius(dot, 4, 0);
        lv_obj_align(dot, LV_ALIGN_TOP_LEFT, 10, y + 8);

        lv_obj_t* brand = makeLabel(s_body, &lv_font_montserrat_12,
                                    agentColor(rows[i].agentType),
                                    agentShortLabel(rows[i].agentType));
        lv_obj_align(brand, LV_ALIGN_TOP_LEFT, 26, y);

        lv_obj_t* proj = makeLabel(s_body, &font_kr_12, Theme::HUDText,
                                   rows[i].projectName);
        lv_obj_set_width(proj, 150);
        lv_label_set_long_mode(proj, LV_LABEL_LONG_DOT);
        lv_obj_align(proj, LV_ALIGN_TOP_LEFT, 108, y);

        lv_obj_t* line = makeLabel(s_body, &font_kr_12, Theme::HUDDim, rows[i].line);
        lv_obj_set_width(line, 200);
        lv_label_set_long_mode(line, LV_LABEL_LONG_DOT);
        lv_obj_align(line, LV_ALIGN_TOP_LEFT, 268, y);

        lv_obj_t* st = makeLabel(s_body, &lv_font_montserrat_12,
                                 stateColorOf(rows[i].state), rows[i].state);
        lv_obj_align(st, LV_ALIGN_TOP_LEFT, 26, y + 16);
    }
}

namespace Ticker {

void create() {
    s_scr = lv_obj_create(NULL);
    lv_obj_set_style_bg_color(s_scr, lv_color_hex(Theme::DeepSea), 0);
    lv_obj_set_style_bg_opa(s_scr, LV_OPA_COVER, 0);

    lv_obj_t* header = lv_obj_create(s_scr);
    lv_obj_remove_style_all(header);
    lv_obj_set_size(header, 480, 22);
    lv_obj_set_style_bg_color(header, lv_color_hex(Theme::MidWater), 0);
    lv_obj_set_style_bg_opa(header, LV_OPA_COVER, 0);
    lv_obj_align(header, LV_ALIGN_TOP_LEFT, 0, 0);

    s_headerLeft = makeLabel(header, &lv_font_montserrat_12, Theme::HUDText, "AGENTDECK");
    lv_obj_align(s_headerLeft, LV_ALIGN_LEFT_MID, 10, 0);
    s_headerRight = makeLabel(header, &lv_font_montserrat_12, Theme::HUDDim, "");
    lv_obj_align(s_headerRight, LV_ALIGN_RIGHT_MID, -10, 0);
    s_hdrWifi = makeLabel(header, &lv_font_montserrat_12, Theme::HUDDim, LV_SYMBOL_WIFI);
    lv_obj_align(s_hdrWifi, LV_ALIGN_RIGHT_MID, -60, 0);

    s_body = lv_obj_create(s_scr);
    lv_obj_remove_style_all(s_body);
    lv_obj_set_size(s_body, 480, 200);
    lv_obj_align(s_body, LV_ALIGN_TOP_LEFT, 0, 22);

    lv_screen_load(s_scr);
    s_lastSig[0] = '\0';
}

void nextPage() {
    s_page = (uint8_t)((s_page + 1) % PAGE_COUNT);
    s_lastCycleMs = millis();
}

void prevPage() {
    s_page = (uint8_t)((s_page + PAGE_COUNT - 1) % PAGE_COUNT);
    s_lastCycleMs = millis();
}

void toggleAutoCycle() {
    s_autoCycle = !s_autoCycle;
    s_lastCycleMs = millis();
}

void update(float dt) {
    (void)dt;
    uint32_t now = millis();

    if (s_autoCycle && (uint32_t)(now - s_lastCycleMs) > AUTO_CYCLE_MS) {
        s_page = (uint8_t)((s_page + 1) % PAGE_COUNT);
        s_lastCycleMs = now;
    }

    bool wifiUp = Net::wifiConnected();
    bool wsUp = Net::wsConnected();

    // Signature: page + coarse usage buckets + session states/lines.
    char sig[224];
    {
        lockState();
        int c5 = (int)g_state.fiveHourPercent, c7 = (int)g_state.sevenDayPercent;
        int x5 = (int)g_state.codexPrimaryPercent, x7 = (int)g_state.codexSecondaryPercent;
        char sess[96] = {0};
        size_t off = 0;
        for (uint8_t i = 0; i < g_state.sessionCount && off < sizeof(sess) - 20; i++) {
            off += snprintf(sess + off, sizeof(sess) - off, "%.8s:%.10s|",
                            g_state.sessions[i].state, g_state.sessions[i].lastEventText);
        }
        uint8_t count = g_state.sessionCount;
        bool connected = g_state.wsConnected;
        uint8_t subsCount = g_state.subscriptionCount;
        unlockState();
        snprintf(sig, sizeof(sig), "%d|%d.%d.%d.%d|%d|%d|%d%d%d|%s",
                 s_page, c5, c7, x5, x7, subsCount, count,
                 connected ? 1 : 0, wifiUp ? 1 : 0, wsUp ? 1 : 0, sess);
    }
    if (strcmp(sig, s_lastSig) == 0) return;
    strncpy(s_lastSig, sig, sizeof(s_lastSig) - 1);
    s_lastSig[sizeof(s_lastSig) - 1] = '\0';

    lv_obj_set_style_text_color(
        s_hdrWifi,
        lv_color_hex(wsUp ? Theme::StatusGreen : (wifiUp ? Theme::StatusAmber : Theme::StatusRed)), 0);

    char right[24];
    snprintf(right, sizeof(right), "%s  %d/%d",
             s_page == 0 ? "USAGE" : "SESSIONS", s_page + 1, PAGE_COUNT);
    lv_label_set_text(s_headerRight, right);

    lv_obj_clean(s_body);
    if (s_page == 0) renderUsagePage();
    else renderSessionsPage();
}

}  // namespace Ticker

#endif  // BOARD_T_DISPLAY_PRO
