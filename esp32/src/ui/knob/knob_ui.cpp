#if defined(BOARD_T_EMBED)

#include "knob_ui.h"
#include "../../state/agent_state.h"
#include "../../net/ws_client.h"
#include "../../net/wifi_manager.h"
#include "../../input/power_monitor.h"
#include "../display.h"
#include "../theme.h"
#include "../agent_label.h"
#include "../../util/utf8.h"

#include <Arduino.h>
#include <lvgl.h>
#include <stdio.h>
#include <string.h>

// ── view model ──────────────────────────────────────────────────────────────

enum class Mode : uint8_t { LIST, DETAIL };

enum MenuKind : uint8_t {
    MI_OPTION,    // select_option(optIndex)
    MI_APPROVE,   // permission_decision allow (requestId) / select_option(0)
    MI_DENY,      // permission_decision deny (requestId) / escape
    MI_ESC,       // session escape
    MI_STOP,      // session interrupt
    MI_CONTINUE,  // send_prompt "go on"
    MI_BACK,      // leave detail
};

struct MenuItem {
    char label[64];
    uint8_t kind;
    uint8_t optIndex;
    bool recommended;
};

static constexpr uint8_t MENU_MAX = SESSION_OPTIONS_CAP + 3;
static constexpr uint8_t MENU_VISIBLE = 4;

// Snapshot of the one session the UI is looking at (copied under lock).
struct SessionSnap {
    char id[32];
    char projectName[40];
    char agentType[16];
    char state[20];
    char currentTool[40];
    char question[160];
    char promptType[20];
    char requestId[40];
    char activity[80];
    char lastEventText[100];
    uint32_t elapsedSec;
};

static Mode s_mode = Mode::LIST;
static int s_listIdx = 0;
static int s_menuIdx = 0;
static int s_menuScroll = 0;
static MenuItem s_menu[MENU_MAX];
static uint8_t s_menuCount = 0;
static char s_detailSessionId[32] = {0};  // session the detail view entered

// Transient "sent" flash — one-frame-cheap optimistic press feedback.
static char s_flashText[48] = {0};
static uint32_t s_flashUntilMs = 0;

// ── widgets ─────────────────────────────────────────────────────────────────

static lv_obj_t* s_scr = nullptr;
static lv_obj_t* s_header = nullptr;
static lv_obj_t* s_headerLeft = nullptr;
static lv_obj_t* s_headerRight = nullptr;
static lv_obj_t* s_hdrWifi = nullptr;   // WiFi/WS link glyph
static lv_obj_t* s_hdrBatt = nullptr;   // battery % (+ charge bolt)
static lv_obj_t* s_body = nullptr;
static lv_obj_t* s_footer = nullptr;

static char s_lastSig[256] = {0};  // content signature — rebuild body on change

// ── outbound commands (thread-safe queue; drained on the network core) ──────

static void sendSelectOption(const char* sid, int index) {
    char buf[96];
    snprintf(buf, sizeof(buf),
             "{\"type\":\"select_option\",\"index\":%d,\"sessionId\":\"%s\"}",
             index, sid);
    Net::queueOutbound(buf);
}

static void sendPermissionDecision(const char* requestId, bool allow) {
    char buf[160];
    snprintf(buf, sizeof(buf),
             "{\"type\":\"permission_decision\",\"requestId\":\"%s\",\"decision\":\"%s\"}",
             requestId, allow ? "allow" : "deny");
    Net::queueOutbound(buf);
}

static void sendSessionCommand(const char* sid, const char* cmdType) {
    char buf[160];
    snprintf(buf, sizeof(buf),
             "{\"type\":\"session_command\",\"sessionId\":\"%s\",\"command\":{\"type\":\"%s\"}}",
             sid, cmdType);
    Net::queueOutbound(buf);
}

static void sendGoOn(const char* sid) {
    char buf[176];
    snprintf(buf, sizeof(buf),
             "{\"type\":\"session_command\",\"sessionId\":\"%s\","
             "\"command\":{\"type\":\"send_prompt\",\"text\":\"go on\"}}",
             sid);
    Net::queueOutbound(buf);
}

static void flash(const char* text) {
    strncpy(s_flashText, text, sizeof(s_flashText) - 1);
    s_flashText[sizeof(s_flashText) - 1] = '\0';
    s_flashUntilMs = millis() + 1200;
}

// ── snapshot helpers ────────────────────────────────────────────────────────

static bool snapshotSession(int idx, SessionSnap& out) {
    bool ok = false;
    lockState();
    if (idx >= 0 && idx < g_state.sessionCount) {
        const SessionInfo& s = g_state.sessions[idx];
        strncpy(out.id, s.id, sizeof(out.id));
        strncpy(out.projectName, s.projectName, sizeof(out.projectName));
        strncpy(out.agentType, s.agentType, sizeof(out.agentType));
        strncpy(out.state, s.state, sizeof(out.state));
        strncpy(out.currentTool, s.currentTool, sizeof(out.currentTool));
        strncpy(out.question, s.question, sizeof(out.question));
        strncpy(out.promptType, s.promptType, sizeof(out.promptType));
        strncpy(out.requestId, s.requestId, sizeof(out.requestId));
        strncpy(out.activity, s.activity, sizeof(out.activity));
        strncpy(out.lastEventText, s.lastEventText, sizeof(out.lastEventText));
        out.elapsedSec = s.elapsedSec;
        ok = true;
    }
    unlockState();
    if (ok) {
        // Daemon text can carry punctuation outside Montserrat + the Hangul-only
        // Noto KR fallback (U+00B7 " · " above all) — sanitize once at snapshot
        // time so no render path ever draws a tofu box.
        Utf8::sanitizeLvglText(out.projectName);
        Utf8::sanitizeLvglText(out.question);
        Utf8::sanitizeLvglText(out.currentTool);
        Utf8::sanitizeLvglText(out.activity);
        Utf8::sanitizeLvglText(out.lastEventText);
    }
    return ok;
}

static int findSessionById(const char* sid) {
    int found = -1;
    lockState();
    for (uint8_t i = 0; i < g_state.sessionCount; i++) {
        if (strcmp(g_state.sessions[i].id, sid) == 0) { found = i; break; }
    }
    unlockState();
    return found;
}

static uint32_t agentColor(const char* agentType) {
    if (strcmp(agentType, "claude-code") == 0) return Theme::ClaudeBody;
    if (strncmp(agentType, "codex", 5) == 0) return Theme::CloudBody;
    if (strcmp(agentType, "openclaw") == 0) return Theme::CrayfishShell;
    if (strcmp(agentType, "opencode") == 0) return Theme::OpenCodeOuter;
    if (strcmp(agentType, "antigravity") == 0) return Theme::AntigravityMark;
    return Theme::HUDDim;
}

static uint32_t stateColorOf(const char* state) {
    if (strstr(state, "awaiting") != nullptr) return Theme::StatusAmber;
    if (strcmp(state, "processing") == 0) return Theme::StatusBlue;
    if (strcmp(state, "idle") == 0) return Theme::StatusGreen;
    return Theme::HUDDim;
}

static const char* statePhrase(const char* state) {
    if (strcmp(state, "processing") == 0) return "working";
    if (strcmp(state, "awaiting_permission") == 0) return "awaiting approval";
    if (strcmp(state, "awaiting_option") == 0) return "choosing";
    if (strcmp(state, "awaiting_diff") == 0) return "reviewing diff";
    if (strcmp(state, "idle") == 0) return "idle";
    return state[0] ? state : "-";
}

static void fmtElapsed(uint32_t sec, char* out, size_t n) {
    if (sec == 0) { out[0] = '\0'; return; }
    if (sec < 3600) snprintf(out, n, "%lum", (unsigned long)(sec / 60));
    else snprintf(out, n, "%luh%02lum", (unsigned long)(sec / 3600),
                  (unsigned long)((sec % 3600) / 60));
}

// ── menu construction ───────────────────────────────────────────────────────

static void addMenuItem(const char* label, uint8_t kind, uint8_t optIndex,
                        bool recommended) {
    if (s_menuCount >= MENU_MAX) return;
    MenuItem& m = s_menu[s_menuCount++];
    strncpy(m.label, label, sizeof(m.label) - 1);
    m.label[sizeof(m.label) - 1] = '\0';
    m.kind = kind;
    m.optIndex = optIndex;
    m.recommended = recommended;
}

// Build the state-dependent command menu for the entered session. Mirrors the
// Stream Deck detail-level grammar: awaiting = real options, processing = STOP,
// idle = GO ON; BACK is always last.
static void buildMenu(const SessionSnap& s) {
    s_menuCount = 0;
    bool awaiting = strstr(s.state, "awaiting") != nullptr;

    if (awaiting) {
        uint8_t optCount = 0;
        SessionOption opts[SESSION_OPTIONS_CAP];
        lockState();
        int idx = -1;
        for (uint8_t i = 0; i < g_state.sessionCount; i++)
            if (strcmp(g_state.sessions[i].id, s.id) == 0) { idx = i; break; }
        if (idx >= 0) {
            optCount = g_state.sessions[idx].optionCount;
            memcpy(opts, g_state.sessions[idx].options, sizeof(opts));
        }
        unlockState();

        if (optCount > 0) {
            for (uint8_t i = 0; i < optCount; i++) {
                Utf8::sanitizeLvglText(opts[i].label);
                addMenuItem(opts[i].label, MI_OPTION, opts[i].index,
                            opts[i].recommended);
            }
        } else {
            // No parsed options (plain permission gate) — Approve/Deny pair.
            addMenuItem("Approve", MI_APPROVE, 0, true);
            addMenuItem("Deny", MI_DENY, 0, false);
        }
        addMenuItem("Esc (cancel prompt)", MI_ESC, 0, false);
    } else if (strcmp(s.state, "processing") == 0) {
        addMenuItem("STOP (interrupt)", MI_STOP, 0, false);
    } else if (strncmp(s.id, "observed:", 9) != 0) {
        // "Go on" types into the managed PTY. An observed session's terminal
        // cannot be typed into, and its idle directive queue only drains at a
        // turn end that never comes — so the item is honest only for managed
        // sessions. (Observed processing sessions still get STOP: the soft-stop
        // ladder is real.)
        addMenuItem("Go on", MI_CONTINUE, 0, false);
    }
    addMenuItem("Back", MI_BACK, 0, false);

    if (s_menuIdx >= s_menuCount) s_menuIdx = s_menuCount - 1;
    if (s_menuIdx < 0) s_menuIdx = 0;
}

static void executeMenuItem(const SessionSnap& s, const MenuItem& m) {
    switch (m.kind) {
        case MI_OPTION:
            sendSelectOption(s.id, m.optIndex);
            flash("sent: option");
            s_mode = Mode::LIST;
            break;
        case MI_APPROVE:
            // Observed gate carries a requestId → resolve it; managed PTY
            // session drives the live prompt (same fallback as the IPS10
            // mosaic: select_option(0) is the affirmative).
            if (s.requestId[0]) sendPermissionDecision(s.requestId, true);
            else sendSelectOption(s.id, 0);
            flash("sent: approve");
            s_mode = Mode::LIST;
            break;
        case MI_DENY:
            if (s.requestId[0]) sendPermissionDecision(s.requestId, false);
            else sendSessionCommand(s.id, "escape");
            flash("sent: deny");
            s_mode = Mode::LIST;
            break;
        case MI_ESC:
            sendSessionCommand(s.id, "escape");
            flash("sent: esc");
            s_mode = Mode::LIST;
            break;
        case MI_STOP:
            sendSessionCommand(s.id, "interrupt");
            flash("sent: stop");
            s_mode = Mode::LIST;
            break;
        case MI_CONTINUE:
            sendGoOn(s.id);
            flash("sent: go on");
            s_mode = Mode::LIST;
            break;
        case MI_BACK:
        default:
            s_mode = Mode::LIST;
            break;
    }
}

// ── rendering ───────────────────────────────────────────────────────────────

static lv_obj_t* makeLabel(lv_obj_t* parent, const lv_font_t* font,
                           uint32_t color, const char* text) {
    lv_obj_t* l = lv_label_create(parent);
    lv_obj_set_style_text_font(l, font, 0);
    lv_obj_set_style_text_color(l, lv_color_hex(color), 0);
    lv_label_set_text(l, text);
    return l;
}

static void renderListBody(bool connected, uint8_t sessionCount) {
    if (!connected) {
        bool wifiUp = Net::wifiConnected();
        lv_obj_t* l = makeLabel(s_body, &lv_font_montserrat_14, Theme::HUDDim,
                                wifiUp ? "Searching for AgentDeck..."
                                       : "No WiFi — provision over USB");
        lv_obj_align(l, LV_ALIGN_CENTER, 0, -10);
        char netline[64];
        if (wifiUp) snprintf(netline, sizeof(netline), "WiFi ok " LV_SYMBOL_BULLET " %s", Net::wifiLocalIP());
        else snprintf(netline, sizeof(netline), "agentdeck wifi-setup");
        lv_obj_t* n = makeLabel(s_body, &lv_font_montserrat_12, Theme::HUDFaint, netline);
        lv_obj_align(n, LV_ALIGN_CENTER, 0, 14);
        return;
    }
    if (sessionCount == 0) {
        lv_obj_t* l = makeLabel(s_body, &lv_font_montserrat_14, Theme::HUDDim,
                                "No active sessions");
        lv_obj_align(l, LV_ALIGN_CENTER, 0, 0);
        return;
    }

    SessionSnap s;
    if (!snapshotSession(s_listIdx, s)) return;

    // Agent brand chip + project name
    lv_obj_t* brand = makeLabel(s_body, &lv_font_montserrat_14,
                                agentColor(s.agentType),
                                agentShortLabel(s.agentType));
    lv_obj_align(brand, LV_ALIGN_TOP_LEFT, 8, 4);

    char elapsed[12];
    fmtElapsed(s.elapsedSec, elapsed, sizeof(elapsed));
    char stateLine[64];
    snprintf(stateLine, sizeof(stateLine), "%s%s%s", statePhrase(s.state),
             elapsed[0] ? " " LV_SYMBOL_BULLET " " : "", elapsed);
    lv_obj_t* st = makeLabel(s_body, &lv_font_montserrat_12,
                             stateColorOf(s.state), stateLine);
    lv_obj_align(st, LV_ALIGN_TOP_RIGHT, -8, 6);

    lv_obj_t* proj = makeLabel(s_body, &font_kr_12, Theme::HUDText,
                               s.projectName[0] ? s.projectName : "(no project)");
    lv_obj_set_width(proj, 304);
    lv_label_set_long_mode(proj, LV_LABEL_LONG_DOT);
    lv_obj_align(proj, LV_ALIGN_TOP_LEFT, 8, 26);

    // Context line: awaiting question > live tool > activity > last milestone.
    const char* ctx = "";
    if (strstr(s.state, "awaiting") && s.question[0]) ctx = s.question;
    else if (s.currentTool[0]) ctx = s.currentTool;
    else if (s.activity[0]) ctx = s.activity;
    else if (s.lastEventText[0]) ctx = s.lastEventText;
    lv_obj_t* ctxl = makeLabel(s_body, &font_kr_12, Theme::HUDDim, ctx);
    lv_obj_set_width(ctxl, 304);
    lv_label_set_long_mode(ctxl, LV_LABEL_LONG_WRAP);
    lv_obj_set_height(ctxl, 48);
    lv_obj_align(ctxl, LV_ALIGN_TOP_LEFT, 8, 46);

    // Awaiting badge: make "needs you" unmissable even on the context line.
    if (strstr(s.state, "awaiting") != nullptr) {
        lv_obj_t* bar = lv_obj_create(s_body);
        lv_obj_remove_style_all(bar);
        lv_obj_set_size(bar, 3, 96);
        lv_obj_set_style_bg_color(bar, lv_color_hex(Theme::StatusAmber), 0);
        lv_obj_set_style_bg_opa(bar, LV_OPA_COVER, 0);
        lv_obj_align(bar, LV_ALIGN_TOP_LEFT, 0, 2);
    }
}

static void renderDetailBody(const SessionSnap& s) {
    // Question / context header (top ~44px)
    const char* head = "";
    if (strstr(s.state, "awaiting") && s.question[0]) head = s.question;
    else if (strcmp(s.state, "processing") == 0 && s.currentTool[0]) head = s.currentTool;
    else if (s.activity[0]) head = s.activity;
    lv_obj_t* q = makeLabel(s_body, &font_kr_12, Theme::HUDText, head);
    lv_obj_set_width(q, 304);
    lv_label_set_long_mode(q, LV_LABEL_LONG_WRAP);
    lv_obj_set_height(q, 34);
    lv_obj_align(q, LV_ALIGN_TOP_LEFT, 8, 2);

    // Menu window (4 rows x 20px)
    if (s_menuIdx < s_menuScroll) s_menuScroll = s_menuIdx;
    if (s_menuIdx >= s_menuScroll + MENU_VISIBLE)
        s_menuScroll = s_menuIdx - MENU_VISIBLE + 1;

    for (uint8_t row = 0; row < MENU_VISIBLE; row++) {
        int i = s_menuScroll + row;
        if (i >= s_menuCount) break;
        const MenuItem& m = s_menu[i];
        bool cur = (i == s_menuIdx);

        lv_obj_t* rowObj = lv_obj_create(s_body);
        lv_obj_remove_style_all(rowObj);
        lv_obj_set_size(rowObj, 312, 19);
        lv_obj_align(rowObj, LV_ALIGN_TOP_LEFT, 4, 40 + row * 20);
        if (cur) {
            lv_obj_set_style_bg_color(rowObj, lv_color_hex(Theme::ShallowWater), 0);
            lv_obj_set_style_bg_opa(rowObj, LV_OPA_COVER, 0);
            lv_obj_set_style_radius(rowObj, 3, 0);
        }

        char text[80];
        snprintf(text, sizeof(text), "%s%s%s", cur ? "> " : "  ", m.label,
                 m.recommended ? " *" : "");
        lv_obj_t* l = makeLabel(rowObj, &font_kr_12,
                                cur ? Theme::HUDText : Theme::HUDDim, text);
        lv_label_set_long_mode(l, LV_LABEL_LONG_DOT);
        lv_obj_set_width(l, 300);
        lv_obj_align(l, LV_ALIGN_LEFT_MID, 4, 0);
    }

    // Scroll hint
    if (s_menuCount > MENU_VISIBLE) {
        char pos[16];
        snprintf(pos, sizeof(pos), "%d/%d", s_menuIdx + 1, s_menuCount);
        lv_obj_t* p = makeLabel(s_body, &lv_font_montserrat_12, Theme::HUDFaint, pos);
        lv_obj_align(p, LV_ALIGN_BOTTOM_RIGHT, -6, 0);
    }
}

// ── public API ──────────────────────────────────────────────────────────────

namespace Knob {

void create() {
    s_scr = lv_obj_create(NULL);
    lv_obj_set_style_bg_color(s_scr, lv_color_hex(Theme::DeepSea), 0);
    lv_obj_set_style_bg_opa(s_scr, LV_OPA_COVER, 0);

    s_header = lv_obj_create(s_scr);
    lv_obj_remove_style_all(s_header);
    lv_obj_set_size(s_header, 320, 22);
    lv_obj_set_style_bg_color(s_header, lv_color_hex(Theme::MidWater), 0);
    lv_obj_set_style_bg_opa(s_header, LV_OPA_COVER, 0);
    lv_obj_align(s_header, LV_ALIGN_TOP_LEFT, 0, 0);

    s_headerLeft = makeLabel(s_header, &lv_font_montserrat_12, Theme::HUDText, "AGENTDECK");
    lv_obj_align(s_headerLeft, LV_ALIGN_LEFT_MID, 8, 0);
    s_headerRight = makeLabel(s_header, &lv_font_montserrat_12, Theme::HUDDim, "");
    lv_obj_align(s_headerRight, LV_ALIGN_RIGHT_MID, -8, 0);
    s_hdrBatt = makeLabel(s_header, &lv_font_montserrat_12, Theme::HUDDim, "");
    lv_obj_align(s_hdrBatt, LV_ALIGN_RIGHT_MID, -44, 0);
    s_hdrWifi = makeLabel(s_header, &lv_font_montserrat_12, Theme::HUDDim, LV_SYMBOL_WIFI);
    lv_obj_align(s_hdrWifi, LV_ALIGN_RIGHT_MID, -100, 0);

    s_body = lv_obj_create(s_scr);
    lv_obj_remove_style_all(s_body);
    lv_obj_set_size(s_body, 320, 126);
    lv_obj_align(s_body, LV_ALIGN_TOP_LEFT, 0, 22);

    s_footer = makeLabel(s_scr, &lv_font_montserrat_12, Theme::HUDFaint, "");
    lv_obj_align(s_footer, LV_ALIGN_BOTTOM_LEFT, 8, -3);

    lv_screen_load(s_scr);
    s_lastSig[0] = '\0';
}

void onRotate(int detents) {
    if (detents == 0) return;
    lockState();
    uint8_t count = g_state.sessionCount;
    unlockState();

    if (s_mode == Mode::LIST) {
        if (count == 0) return;
        s_listIdx = (s_listIdx + detents) % (int)count;
        if (s_listIdx < 0) s_listIdx += count;
    } else {
        if (s_menuCount == 0) return;
        s_menuIdx += detents;
        if (s_menuIdx < 0) s_menuIdx = 0;
        if (s_menuIdx >= s_menuCount) s_menuIdx = s_menuCount - 1;
    }
}

void onKey(Input::KeyEvent evt) {
    if (evt == Input::KeyEvent::NONE) return;

    if (evt == Input::KeyEvent::LONG_PRESS) {
        s_mode = Mode::LIST;
        return;
    }

    // SHORT_PRESS
    if (s_mode == Mode::LIST) {
        SessionSnap s;
        if (!snapshotSession(s_listIdx, s)) return;
        strncpy(s_detailSessionId, s.id, sizeof(s_detailSessionId) - 1);
        s_menuIdx = 0;
        s_menuScroll = 0;
        buildMenu(s);
        s_mode = Mode::DETAIL;
    } else {
        SessionSnap s;
        int idx = findSessionById(s_detailSessionId);
        if (idx < 0 || !snapshotSession(idx, s)) {
            s_mode = Mode::LIST;  // session went away under us
            return;
        }
        if (s_menuIdx < s_menuCount) executeMenuItem(s, s_menu[s_menuIdx]);
    }
}

int selectedSessionIdx() {
    lockState();
    uint8_t count = g_state.sessionCount;
    unlockState();
    if (count == 0) return -1;
    if (s_mode == Mode::DETAIL) {
        int idx = findSessionById(s_detailSessionId);
        return idx >= 0 ? idx : -1;
    }
    return s_listIdx < count ? s_listIdx : -1;
}

void update(float dt) {
    (void)dt;
    uint32_t now = millis();

    lockState();
    bool connected = g_state.wsConnected;
    uint8_t count = g_state.sessionCount;
    unlockState();

    if (count > 0 && s_listIdx >= count) s_listIdx = count - 1;

    // Detail mode follows its session; if the session or its state changed,
    // rebuild the menu (an answered prompt must not leave stale options up).
    SessionSnap detail;
    bool haveDetail = false;
    if (s_mode == Mode::DETAIL) {
        int idx = findSessionById(s_detailSessionId);
        if (idx < 0 || !snapshotSession(idx, detail)) {
            s_mode = Mode::LIST;
        } else {
            haveDetail = true;
        }
    }

    bool flashOn = s_flashText[0] && (int32_t)(s_flashUntilMs - now) > 0;
    if (!flashOn) s_flashText[0] = '\0';

    // Status cluster inputs (battery, radio link) — part of the signature so
    // the header refreshes exactly when they change.
    Input::PowerStatus pw = Input::powerStatus();
    bool wifiUp = Net::wifiConnected();
    bool wsUp = Net::wsConnected();
    int battBucket = pw.valid ? (pw.soc / 5) : -1;

    // Content signature — cheap change detection; rebuild the body only when
    // something the user can see actually changed.
    char sig[256];
    if (s_mode == Mode::DETAIL && haveDetail) {
        buildMenu(detail);
        snprintf(sig, sizeof(sig), "D|%s|%s|%d|%d|%d|%.40s|%d|%s|%d%d%d%d",
                 detail.id, detail.state, s_menuIdx, s_menuScroll, s_menuCount,
                 detail.question, connected ? 1 : 0, s_flashText,
                 battBucket, pw.charging ? 1 : 0, wifiUp ? 1 : 0, wsUp ? 1 : 0);
    } else {
        SessionSnap s;
        bool have = snapshotSession(s_listIdx, s);
        snprintf(sig, sizeof(sig), "L|%d|%d|%s|%s|%.24s|%.40s|%lu|%d|%s|%d%d%d%d",
                 s_listIdx, count, have ? s.id : "", have ? s.state : "",
                 have ? s.currentTool : "", have ? s.activity : "",
                 have ? (unsigned long)(s.elapsedSec / 60) : 0,
                 connected ? 1 : 0, s_flashText,
                 battBucket, pw.charging ? 1 : 0, wifiUp ? 1 : 0, wsUp ? 1 : 0);
    }
    if (strcmp(sig, s_lastSig) == 0) return;
    strncpy(s_lastSig, sig, sizeof(s_lastSig) - 1);
    s_lastSig[sizeof(s_lastSig) - 1] = '\0';

    // Status cluster: WiFi/WS link glyph + battery. Link color: green = WS to
    // the daemon, amber = WiFi without WS, red = no WiFi. Battery hides when
    // the gauge doesn't answer; charge bolt while the charger reports charging.
    lv_obj_set_style_text_color(
        s_hdrWifi,
        lv_color_hex(wsUp ? Theme::StatusGreen : (wifiUp ? Theme::StatusAmber : Theme::StatusRed)), 0);
    if (pw.valid) {
        char batt[24];
        const char* battSym = pw.soc > 80 ? LV_SYMBOL_BATTERY_FULL
                            : pw.soc > 55 ? LV_SYMBOL_BATTERY_3
                            : pw.soc > 30 ? LV_SYMBOL_BATTERY_2
                            : pw.soc > 10 ? LV_SYMBOL_BATTERY_1
                                          : LV_SYMBOL_BATTERY_EMPTY;
        snprintf(batt, sizeof(batt), "%s%s %d%%",
                 pw.charging ? LV_SYMBOL_CHARGE : "", battSym, pw.soc);
        lv_label_set_text(s_hdrBatt, batt);
        uint32_t battColor = pw.charging ? Theme::StatusBlue
                           : pw.soc > 50 ? Theme::HUDDim
                           : pw.soc > 20 ? Theme::StatusAmber
                                         : Theme::StatusRed;
        lv_obj_set_style_text_color(s_hdrBatt, lv_color_hex(battColor), 0);
    } else {
        lv_label_set_text(s_hdrBatt, "");
    }

    // Header
    if (s_mode == Mode::DETAIL && haveDetail) {
        char left[64];
        // U+00B7 " · " is a tofu box on this font stack — LV_SYMBOL_BULLET is
        // the covered separator (see Utf8::sanitizeLvglText).
        snprintf(left, sizeof(left), "%s " LV_SYMBOL_BULLET " %s",
                 agentShortLabel(detail.agentType),
                 detail.projectName[0] ? detail.projectName : "?");
        lv_label_set_text(s_headerLeft, left);
        lv_obj_set_style_text_font(s_headerLeft, &font_kr_12, 0);
        lv_label_set_text(s_headerRight, statePhrase(detail.state));
        lv_obj_set_style_text_color(s_headerRight,
                                    lv_color_hex(stateColorOf(detail.state)), 0);
    } else {
        lv_label_set_text(s_headerLeft, "AGENTDECK");
        lv_obj_set_style_text_font(s_headerLeft, &lv_font_montserrat_12, 0);
        char right[24];
        if (connected && count > 0)
            snprintf(right, sizeof(right), "%d/%d", s_listIdx + 1, count);
        else
            snprintf(right, sizeof(right), "%s", connected ? "-" : "offline");
        lv_label_set_text(s_headerRight, right);
        lv_obj_set_style_text_color(s_headerRight, lv_color_hex(Theme::HUDDim), 0);
    }

    // Body
    lv_obj_clean(s_body);
    if (s_mode == Mode::DETAIL && haveDetail) {
        renderDetailBody(detail);
    } else {
        renderListBody(connected, count);
    }

    // Footer: flash feedback wins; otherwise the interaction hint.
    if (flashOn) {
        lv_label_set_text(s_footer, s_flashText);
        lv_obj_set_style_text_color(s_footer, lv_color_hex(Theme::StatusGreen), 0);
    } else {
        lv_label_set_text(s_footer, s_mode == Mode::DETAIL
                                        ? "turn: choose " LV_SYMBOL_BULLET " press: send " LV_SYMBOL_BULLET " hold: back"
                                        : "turn: session " LV_SYMBOL_BULLET " press: open");
        lv_obj_set_style_text_color(s_footer, lv_color_hex(Theme::HUDFaint), 0);
    }
}

}  // namespace Knob

#endif  // BOARD_T_EMBED
