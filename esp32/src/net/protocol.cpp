#include "protocol.h"
#include "wifi_manager.h"
#include "ws_client.h"
#include "serial_client.h"
#include "../state/agent_state.h"
#include "../util/ota_capability.h"
#include "../util/reset_reason.h"
#include "../util/usage_format.h"
#include "../util/utf8.h"
#include "config.h"
#include <ArduinoJson.h>
#include <Arduino.h>
#include <WiFi.h>
#include <Update.h>
#include <mbedtls/base64.h>
#if defined(BOARD_IPS35) || defined(BOARD_AMOLED)
#include <Wire.h>
#include "../boards/board_config.h"
#endif
#if defined(BOARD_T_EMBED)
#include "../input/power_monitor.h"
#include "../input/ir_receiver.h"
#endif
#if defined(BOARD_T_DISPLAY_PRO)
#include "../input/touch_strip.h"
#include "../input/light_sensor.h"
#endif

// Reusable JSON document — sized for typical bridge messages
static JsonDocument doc;

struct OtaRxState {
    bool active;
    char otaId[40];
    uint32_t expectedSize;
    uint32_t written;
    uint32_t nextSeq;
};

static OtaRxState otaRx = {false, {0}, 0, 0, 0};
static uint8_t otaChunkBuf[1024];

static AgentState parseState(const char* s) {
    if (!s) return AgentState::DISCONNECTED;
    if (strcmp(s, "idle") == 0)                 return AgentState::IDLE;
    if (strcmp(s, "processing") == 0)           return AgentState::PROCESSING;
    if (strcmp(s, "awaiting_permission") == 0)  return AgentState::AWAITING_PERMISSION;
    if (strcmp(s, "awaiting_option") == 0)      return AgentState::AWAITING_OPTION;
    if (strcmp(s, "awaiting_diff") == 0)        return AgentState::AWAITING_DIFF;
    return AgentState::DISCONNECTED;
}

static bool isCodexAgent(const char* agentType) {
    return agentType &&
           (strcmp(agentType, "codex-cli") == 0 ||
            strcmp(agentType, "codex-app") == 0);
}

// strncpy + NUL + drop any mid-UTF-8 cut. Daemon text (prompts, activity,
// timeline rows, 프로젝트명) can exceed these byte-sized buffers — a plain
// strncpy leaves a split 한글/CJK sequence that renders as a broken glyph.
static void copyTextU8(char* dst, size_t cap, const char* src) {
    if (cap == 0) return;
    strncpy(dst, src ? src : "", cap - 1);
    dst[cap - 1] = '\0';
    Utf8::utf8TrimEnd(dst);
}

static void handleStateUpdate(JsonObject& obj) {
    lockState();

    g_state.state = parseState(obj["state"].as<const char*>());

    // Project & model
    if (obj["projectName"].is<const char*>())
        copyTextU8(g_state.projectName, sizeof(g_state.projectName), obj["projectName"].as<const char*>());
    if (obj["modelName"].is<const char*>())
        strncpy(g_state.modelName, obj["modelName"].as<const char*>(), sizeof(g_state.modelName) - 1);
    if (obj["agentType"].is<const char*>())
        strncpy(g_state.agentType, obj["agentType"].as<const char*>(), sizeof(g_state.agentType) - 1);
    if (obj["effortLevel"].is<const char*>())
        strncpy(g_state.effortLevel, obj["effortLevel"].as<const char*>(), sizeof(g_state.effortLevel) - 1);

    // Current tool
    if (obj["currentTool"].is<const char*>())
        strncpy(g_state.currentTool, obj["currentTool"].as<const char*>(), sizeof(g_state.currentTool) - 1);
    else
        g_state.currentTool[0] = '\0';
    if (obj["toolInput"].is<const char*>())
        copyTextU8(g_state.toolInput, sizeof(g_state.toolInput), obj["toolInput"].as<const char*>());
    else
        g_state.toolInput[0] = '\0';

    // Permission/Options
    if (obj["question"].is<const char*>())
        copyTextU8(g_state.question, sizeof(g_state.question), obj["question"].as<const char*>());
    if (obj["promptType"].is<const char*>())
        strncpy(g_state.promptType, obj["promptType"].as<const char*>(), sizeof(g_state.promptType) - 1);

    // Options array
    if (obj["options"].is<JsonArray>()) {
        JsonArray opts = obj["options"].as<JsonArray>();
        g_state.optionCount = min((int)opts.size(), 8);
        for (uint8_t i = 0; i < g_state.optionCount; i++) {
            JsonObject o = opts[i].as<JsonObject>();
            copyTextU8(g_state.options[i].label, sizeof(g_state.options[i].label), o["label"] | "");
            g_state.options[i].index = o["index"] | i;
            g_state.options[i].recommended = o["recommended"] | false;
            g_state.options[i].selected = o["selected"] | false;

            // Build action string
            if (o["shortcut"].is<const char*>()) {
                strncpy(g_state.options[i].action, o["shortcut"].as<const char*>(),
                        sizeof(g_state.options[i].action) - 1);
            }
        }
    }

    // Gateway
    // gatewayAvailable = OpenClaw process reachable (kept for future topology
    // widgets). gatewayConnected = authenticated — the one that drives
    // crayfish rendering. Older daemons that don't broadcast gatewayConnected
    // will leave it at false, so the crayfish stays dormant until they update.
    g_state.gatewayAvailable = obj["gatewayAvailable"] | false;
    g_state.gatewayConnected = obj["gatewayConnected"] | false;
    g_state.gatewayHasError = obj["gatewayHasError"] | false;

    // Mark that we've received real data from bridge
    g_state.dataReceived = true;

    // Derive creature states
    g_state.updateCreatureStates();

    unlockState();
}

static void handleUsageUpdate(JsonObject& obj) {
    lockState();
    g_state.dataReceived = true;

    // Percent fields: use -1.0f sentinel for "no data" (0 is a valid value).
    // When bridge omits the field (stale TTL expired), clear to sentinel
    // instead of keeping the old sticky value.
    g_state.fiveHourPercent = obj["fiveHourPercent"].is<float>()
        ? obj["fiveHourPercent"].as<float>() : -1.0f;
    g_state.sevenDayPercent = obj["sevenDayPercent"].is<float>()
        ? obj["sevenDayPercent"].as<float>() : -1.0f;

    g_state.inputTokens = obj["inputTokens"] | g_state.inputTokens;
    g_state.outputTokens = obj["outputTokens"] | g_state.outputTokens;
    g_state.toolCalls = obj["toolCalls"] | g_state.toolCalls;
    g_state.sessionDurationSec = obj["sessionDurationSec"] | g_state.sessionDurationSec;
    g_state.estimatedCostUsd = obj["estimatedCostUsd"].is<float>()
        ? obj["estimatedCostUsd"].as<float>() : -1.0f;
    g_state.usageStale = obj["usageStale"] | false;

    // Reset times: pre-formatted "Xh Ym" (relay) or ISO 8601 (bridge WebSocket)
    auto storeResetTime = [](JsonObject& obj, const char* key, char* out, size_t outLen) {
        if (!obj[key].is<const char*>()) { out[0] = '\0'; return; }
        const char* val = obj[key].as<const char*>();

        // Already formatted (no 'T' separator) — store directly
        if (strchr(val, 'T') == nullptr) {
            strncpy(out, val, outLen - 1);
            out[outLen - 1] = '\0';
            return;
        }

        // ISO 8601 — parse and compute relative time (needs NTP)
        struct tm tm = {};
        int tzH = 0, tzM = 0;
        char tzSign = '+';
        if (sscanf(val, "%d-%d-%dT%d:%d:%d",
                   &tm.tm_year, &tm.tm_mon, &tm.tm_mday,
                   &tm.tm_hour, &tm.tm_min, &tm.tm_sec) >= 6) {
            // Parse timezone offset (e.g. "+00:00", "+09:00")
            const char* tz = strrchr(val, '+');
            if (!tz) tz = strrchr(val, '-');
            // Make sure it's not the date separator
            if (tz && tz > val + 10) {
                tzSign = *tz;
                sscanf(tz + 1, "%d:%d", &tzH, &tzM);
            }

            tm.tm_year -= 1900;
            tm.tm_mon -= 1;

            // Convert to UTC epoch using timegm-equivalent
            // (mktime uses local time, but we set TZ to UTC via configTzTime)
            time_t resetEpoch = mktime(&tm);
            // Apply timezone offset to get UTC
            int offsetSec = (tzH * 3600 + tzM * 60) * (tzSign == '+' ? -1 : 1);
            resetEpoch += offsetSec;

            time_t now = time(nullptr);
            // Check if NTP has synced (time > 2025-01-01)
            if (now < 1735689600) {
                // No NTP yet — can't compute relative time
                out[0] = '\0';
                return;
            }

            int diffSec = (int)(resetEpoch - now);
            if (diffSec <= 0) {
                strncpy(out, "now", outLen - 1);
                out[outLen - 1] = '\0';
                return;
            }

            int diffMin = diffSec / 60;
            if (diffMin < 60) {
                snprintf(out, outLen, "%dm", diffMin);
            } else {
                int h = diffMin / 60;
                int m = diffMin % 60;
                if (h < 24) {
                    if (m > 0) snprintf(out, outLen, "%dh %dm", h, m);
                    else snprintf(out, outLen, "%dh", h);
                } else {
                    int d = h / 24;
                    int rh = h % 24;
                    if (rh > 0) snprintf(out, outLen, "%dd %dh", d, rh);
                    else snprintf(out, outLen, "%dd", d);
                }
            }
        } else {
            out[0] = '\0';
        }
    };

    storeResetTime(obj, "fiveHourResetsAt", g_state.fiveHourReset, sizeof(g_state.fiveHourReset));
    storeResetTime(obj, "sevenDayResetsAt", g_state.sevenDayReset, sizeof(g_state.sevenDayReset));

    // Codex (ChatGPT) rolling-window limits. Nested object mirrors the Claude
    // 5h/7d shape — primary ≈ 5h window, secondary ≈ 7d. Absent (→ sentinel)
    // for non-Codex users. Reuses the storeResetTime lambda on each window.
    g_state.codexPrimaryPercent = -1.0f;
    g_state.codexSecondaryPercent = -1.0f;
    g_state.codexPrimaryReset[0] = '\0';
    g_state.codexSecondaryReset[0] = '\0';
    if (obj["codexRateLimits"].is<JsonObject>()) {
        JsonObject cx = obj["codexRateLimits"].as<JsonObject>();
        if (cx["primary"].is<JsonObject>()) {
            JsonObject p = cx["primary"].as<JsonObject>();
            if (!p["stale"].as<bool>()) {
                if (p["usedPercent"].is<float>()) g_state.codexPrimaryPercent = p["usedPercent"].as<float>();
                storeResetTime(p, "resetsAt", g_state.codexPrimaryReset, sizeof(g_state.codexPrimaryReset));
            }
        }
        if (cx["secondary"].is<JsonObject>()) {
            JsonObject s = cx["secondary"].as<JsonObject>();
            if (!s["stale"].as<bool>()) {
                if (s["usedPercent"].is<float>()) g_state.codexSecondaryPercent = s["usedPercent"].as<float>();
                storeResetTime(s, "resetsAt", g_state.codexSecondaryReset, sizeof(g_state.codexSecondaryReset));
            }
        }
    }

    // Antigravity local IDE quota — availableCredits is a raw count (no max),
    // so consumers render it as a text chip rather than a percentage gauge.
    g_state.antigravityCredits = -1.0f;
    g_state.antigravityPlan[0] = '\0';
    if (obj["antigravityStatus"].is<JsonObject>()) {
        JsonObject ag = obj["antigravityStatus"].as<JsonObject>();
        if (ag["availableCredits"].is<float>())
            g_state.antigravityCredits = ag["availableCredits"].as<float>();
        if (ag["planName"].is<const char*>()) {
            strncpy(g_state.antigravityPlan, ag["planName"].as<const char*>(),
                    sizeof(g_state.antigravityPlan) - 1);
            g_state.antigravityPlan[sizeof(g_state.antigravityPlan) - 1] = '\0';
        }
    }

    // Account subscriptions (plan name + preformatted expiry). Only replace
    // when the key is present so a payload without it keeps the last known.
    if (obj["subscriptions"].is<JsonArray>()) {
        JsonArray subs = obj["subscriptions"].as<JsonArray>();
        g_state.subscriptionCount = 0;
        for (JsonObject sub : subs) {
            if (g_state.subscriptionCount >= 3) break;
            auto& slot = g_state.subscriptions[g_state.subscriptionCount];
            strncpy(slot.name, sub["name"] | "", sizeof(slot.name) - 1);
            slot.name[sizeof(slot.name) - 1] = '\0';
            // `until` arrives pre-formatted ("~7/12") over serial but as raw ISO
            // over the WiFi WS path (the daemon broadcasts the unmodified event).
            // Normalize both to the short "~M/D" form so the panels never render
            // a bare ISO timestamp.
            UsageFormat::formatShortExpiry(sub["until"] | "", slot.until, sizeof(slot.until));
            if (slot.name[0]) g_state.subscriptionCount++;
        }
    }

    unlockState();
}

static void handleSessionsList(JsonObject& obj) {
    lockState();
    g_state.dataReceived = true;

    JsonArray sessions = obj["sessions"].as<JsonArray>();
    // Cap 10 — keep in sync with sessions[10] (agent_state.h) and
    // SERIAL_SESSIONS_CAP (bridge/src/esp32-serial.ts).
    uint8_t incomingCount = min((int)sessions.size(), 10);
    if (incomingCount == 0) {
        if (g_state.sessionCount > 0) {
            uint32_t nowMs = millis();
            if (!g_state.sessionClearPending) {
                g_state.sessionClearPending = true;
                g_state.sessionClearPendingMs = nowMs;
                unlockState();
                return;
            }
            if ((uint32_t)(nowMs - g_state.sessionClearPendingMs) < SESSION_EMPTY_GRACE_MS) {
                unlockState();
                return;
            }
        }
        g_state.clearSessions();
        unlockState();
        return;
    }

    g_state.sessionClearPending = false;
    g_state.sessionClearPendingMs = 0;
    g_state.sessionCount = incomingCount;
    g_state.octopusCount = 0;
    g_state.cloudCount = 0;
    g_state.opencodeCount = 0;
    g_state.antigravityCount = 0;
    g_state.crayfishCount = 0;

    for (uint8_t i = 0; i < g_state.sessionCount; i++) {
        JsonObject s = sessions[i].as<JsonObject>();
        strncpy(g_state.sessions[i].id, s["id"] | "", sizeof(g_state.sessions[i].id) - 1);
        copyTextU8(g_state.sessions[i].projectName, sizeof(g_state.sessions[i].projectName),
                   s["projectName"] | "");
        strncpy(g_state.sessions[i].modelName, s["modelName"] | "",
                sizeof(g_state.sessions[i].modelName) - 1);
        strncpy(g_state.sessions[i].agentType, s["agentType"] | "",
                sizeof(g_state.sessions[i].agentType) - 1);
        strncpy(g_state.sessions[i].state, s["state"] | "",
                sizeof(g_state.sessions[i].state) - 1);
        g_state.sessions[i].port = s["port"] | 0;
        g_state.sessions[i].alive = s["alive"] | false;

        // Per-session detail for the D1 mosaic (tool/elapsed line + inline
        // Approve/Deny). Absent keys default to "" / 0 so non-enriched daemons
        // and idle sessions render cleanly.
        strncpy(g_state.sessions[i].currentTool, s["currentTool"] | "",
                sizeof(g_state.sessions[i].currentTool) - 1);
        g_state.sessions[i].currentTool[sizeof(g_state.sessions[i].currentTool) - 1] = '\0';
        g_state.sessions[i].elapsedSec = s["elapsedSec"] | 0;
        copyTextU8(g_state.sessions[i].question, sizeof(g_state.sessions[i].question),
                   s["question"] | "");
        strncpy(g_state.sessions[i].promptType, s["promptType"] | "",
                sizeof(g_state.sessions[i].promptType) - 1);
        g_state.sessions[i].promptType[sizeof(g_state.sessions[i].promptType) - 1] = '\0';
        strncpy(g_state.sessions[i].requestId, s["requestId"] | "",
                sizeof(g_state.sessions[i].requestId) - 1);
        g_state.sessions[i].requestId[sizeof(g_state.sessions[i].requestId) - 1] = '\0';
        strncpy(g_state.sessions[i].permissionMode, s["permissionMode"] | "",
                sizeof(g_state.sessions[i].permissionMode) - 1);
        g_state.sessions[i].permissionMode[sizeof(g_state.sessions[i].permissionMode) - 1] = '\0';
        // Per-session options — lets an interactive surface answer with the
        // session-scoped select_option without global focus (knob detail view).
        g_state.sessions[i].optionCount = 0;
        if (s["options"].is<JsonArray>()) {
            JsonArray sopts = s["options"].as<JsonArray>();
            uint8_t n = 0;
            for (JsonObject o : sopts) {
                if (n >= SESSION_OPTIONS_CAP) break;
                SessionOption& dst = g_state.sessions[i].options[n];
                copyTextU8(dst.label, sizeof(dst.label), o["label"] | "");
                dst.index = o["index"] | n;
                dst.recommended = o["recommended"] | false;
                n++;
            }
            g_state.sessions[i].optionCount = n;
        }
        // Shared per-session activity one-liner (heuristic → Foundation Models
        // summary) — the most meaningful glanceable line for a dashboard row.
        copyTextU8(g_state.sessions[i].activity, sizeof(g_state.sessions[i].activity),
                   s["activity"] | "");
        // Daemon-computed latest milestone (TIMELINE parity for cards).
        copyTextU8(g_state.sessions[i].lastEventText, sizeof(g_state.sessions[i].lastEventText),
                   s["lastEventText"] | "");
        copyTextU8(g_state.sessions[i].lastEventTask, sizeof(g_state.sessions[i].lastEventTask),
                   s["lastEventTask"] | "");
        strncpy(g_state.sessions[i].lastEventHm, s["lastEventHm"] | "",
                sizeof(g_state.sessions[i].lastEventHm) - 1);
        g_state.sessions[i].lastEventHm[sizeof(g_state.sessions[i].lastEventHm) - 1] = '\0';

        if (g_state.sessions[i].alive) {
            if (strcmp(g_state.sessions[i].agentType, "openclaw") == 0) {
                g_state.crayfishCount++;
                // Derive crayfish state from sibling
                if (strcmp(g_state.sessions[i].state, "processing") == 0)
                    g_state.crayfishState = CrayfishState::ROUTING;
                else if (g_state.sessions[i].state[0] != '\0')
                    g_state.crayfishState = CrayfishState::SITTING;
            } else if (isCodexAgent(g_state.sessions[i].agentType)) {
                g_state.cloudCount++;
            } else if (strcmp(g_state.sessions[i].agentType, "opencode") == 0) {
                g_state.opencodeCount++;
            } else if (strcmp(g_state.sessions[i].agentType, "antigravity") == 0) {
                g_state.antigravityCount++;
            } else if (strcmp(g_state.sessions[i].agentType, "claude-code") == 0) {
                g_state.octopusCount++;
            }
        }
    }

    // Populate sessionNames for octopus name tags (with dedup numbering)
    // First pass: collect raw names
    char rawNames[MAX_OCTOPUS][24];
    uint8_t nameIdx = 0;
    for (uint8_t i = 0; i < g_state.sessionCount && nameIdx < MAX_OCTOPUS; i++) {
        if (g_state.sessions[i].alive &&
            strcmp(g_state.sessions[i].agentType, "claude-code") == 0) {
            const char* name = g_state.sessions[i].projectName;
            if (name[0]) {
                strncpy(rawNames[nameIdx], name, sizeof(rawNames[nameIdx]) - 1);
                rawNames[nameIdx][sizeof(rawNames[nameIdx]) - 1] = '\0';
            } else {
                snprintf(rawNames[nameIdx], sizeof(rawNames[nameIdx]), "Session %d", nameIdx + 1);
            }
            nameIdx++;
        }
    }
    // Second pass: detect duplicates and add #1, #2 suffixes
    for (uint8_t i = 0; i < nameIdx; i++) {
        bool hasDup = false;
        for (uint8_t j = 0; j < nameIdx; j++) {
            if (j != i && strcmp(rawNames[i], rawNames[j]) == 0) {
                hasDup = true;
                break;
            }
        }
        if (hasDup) {
            uint8_t occurrence = 1;
            for (uint8_t j = 0; j < i; j++) {
                if (strcmp(rawNames[i], rawNames[j]) == 0) occurrence++;
            }
            snprintf(g_state.sessionNames[i], sizeof(g_state.sessionNames[i]),
                     "%s #%d", rawNames[i], occurrence);
        } else {
            strncpy(g_state.sessionNames[i], rawNames[i],
                    sizeof(g_state.sessionNames[i]) - 1);
            g_state.sessionNames[i][sizeof(g_state.sessionNames[i]) - 1] = '\0';
        }
    }

    // Populate cloudNames for cloud creature name tags (same dedup logic)
    if (MAX_CLOUD > 0) {
    char cloudRawNames[MAX_CLOUD > 0 ? MAX_CLOUD : 1][24];
    uint8_t cloudNameIdx = 0;
    for (uint8_t i = 0; i < g_state.sessionCount && cloudNameIdx < MAX_CLOUD; i++) {
        if (g_state.sessions[i].alive &&
            isCodexAgent(g_state.sessions[i].agentType)) {
            const char* name = g_state.sessions[i].projectName;
            if (name[0]) {
                strncpy(cloudRawNames[cloudNameIdx], name, sizeof(cloudRawNames[cloudNameIdx]) - 1);
                cloudRawNames[cloudNameIdx][sizeof(cloudRawNames[cloudNameIdx]) - 1] = '\0';
            } else {
                snprintf(cloudRawNames[cloudNameIdx], sizeof(cloudRawNames[cloudNameIdx]), "Codex %d", cloudNameIdx + 1);
            }
            cloudNameIdx++;
        }
    }
    for (uint8_t i = 0; i < cloudNameIdx; i++) {
        bool hasDup = false;
        for (uint8_t j = 0; j < cloudNameIdx; j++) {
            if (j != i && strcmp(cloudRawNames[i], cloudRawNames[j]) == 0) {
                hasDup = true;
                break;
            }
        }
        if (hasDup) {
            uint8_t occurrence = 1;
            for (uint8_t j = 0; j < i; j++) {
                if (strcmp(cloudRawNames[i], cloudRawNames[j]) == 0) occurrence++;
            }
            snprintf(g_state.cloudNames[i], sizeof(g_state.cloudNames[i]),
                     "%s #%d", cloudRawNames[i], occurrence);
        } else {
            strncpy(g_state.cloudNames[i], cloudRawNames[i],
                    sizeof(g_state.cloudNames[i]) - 1);
            g_state.cloudNames[i][sizeof(g_state.cloudNames[i]) - 1] = '\0';
        }
    }
    }  // MAX_CLOUD > 0

    // Populate opencodeNames for opencode creature name tags (same dedup logic)
    if (MAX_OPENCODE > 0) {
    char opencodeRawNames[MAX_OPENCODE > 0 ? MAX_OPENCODE : 1][24];
    uint8_t opencodeNameIdx = 0;
    for (uint8_t i = 0; i < g_state.sessionCount && opencodeNameIdx < MAX_OPENCODE; i++) {
        if (g_state.sessions[i].alive &&
            strcmp(g_state.sessions[i].agentType, "opencode") == 0) {
            const char* name = g_state.sessions[i].projectName;
            if (name[0]) {
                strncpy(opencodeRawNames[opencodeNameIdx], name, sizeof(opencodeRawNames[opencodeNameIdx]) - 1);
                opencodeRawNames[opencodeNameIdx][sizeof(opencodeRawNames[opencodeNameIdx]) - 1] = '\0';
            } else {
                snprintf(opencodeRawNames[opencodeNameIdx], sizeof(opencodeRawNames[opencodeNameIdx]), "OpenCode %d", opencodeNameIdx + 1);
            }
            opencodeNameIdx++;
        }
    }
    for (uint8_t i = 0; i < opencodeNameIdx; i++) {
        bool hasDup = false;
        for (uint8_t j = 0; j < opencodeNameIdx; j++) {
            if (j != i && strcmp(opencodeRawNames[i], opencodeRawNames[j]) == 0) {
                hasDup = true;
                break;
            }
        }
        if (hasDup) {
            uint8_t occurrence = 1;
            for (uint8_t j = 0; j < i; j++) {
                if (strcmp(opencodeRawNames[i], opencodeRawNames[j]) == 0) occurrence++;
            }
            snprintf(g_state.opencodeNames[i], sizeof(g_state.opencodeNames[i]),
                     "%s #%d", opencodeRawNames[i], occurrence);
        } else {
            strncpy(g_state.opencodeNames[i], opencodeRawNames[i],
                    sizeof(g_state.opencodeNames[i]) - 1);
            g_state.opencodeNames[i][sizeof(g_state.opencodeNames[i]) - 1] = '\0';
        }
    }
    }  // MAX_OPENCODE > 0

    // Populate antigravityNames for antigravity creature name tags (same dedup logic)
    if (MAX_ANTIGRAVITY > 0) {
    char antigravityRawNames[MAX_ANTIGRAVITY > 0 ? MAX_ANTIGRAVITY : 1][24];
    uint8_t antigravityNameIdx = 0;
    for (uint8_t i = 0; i < g_state.sessionCount && antigravityNameIdx < MAX_ANTIGRAVITY; i++) {
        if (g_state.sessions[i].alive &&
            strcmp(g_state.sessions[i].agentType, "antigravity") == 0) {
            const char* name = g_state.sessions[i].projectName;
            if (name[0]) {
                strncpy(antigravityRawNames[antigravityNameIdx], name, sizeof(antigravityRawNames[antigravityNameIdx]) - 1);
                antigravityRawNames[antigravityNameIdx][sizeof(antigravityRawNames[antigravityNameIdx]) - 1] = '\0';
            } else {
                snprintf(antigravityRawNames[antigravityNameIdx], sizeof(antigravityRawNames[antigravityNameIdx]), "Antigravity %d", antigravityNameIdx + 1);
            }
            antigravityNameIdx++;
        }
    }
    for (uint8_t i = 0; i < antigravityNameIdx; i++) {
        bool hasDup = false;
        for (uint8_t j = 0; j < antigravityNameIdx; j++) {
            if (j != i && strcmp(antigravityRawNames[i], antigravityRawNames[j]) == 0) {
                hasDup = true;
                break;
            }
        }
        if (hasDup) {
            uint8_t occurrence = 1;
            for (uint8_t j = 0; j < i; j++) {
                if (strcmp(antigravityRawNames[i], antigravityRawNames[j]) == 0) occurrence++;
            }
            snprintf(g_state.antigravityNames[i], sizeof(g_state.antigravityNames[i]),
                     "%s #%d", antigravityRawNames[i], occurrence);
        } else {
            strncpy(g_state.antigravityNames[i], antigravityRawNames[i],
                    sizeof(g_state.antigravityNames[i]) - 1);
            g_state.antigravityNames[i][sizeof(g_state.antigravityNames[i]) - 1] = '\0';
        }
    }
    }  // MAX_ANTIGRAVITY > 0

    // No OpenClaw sessions: gate crayfish on authentication, not reachability.
    if (g_state.crayfishCount == 0) {
        if (g_state.gatewayHasError) {
            g_state.crayfishState = CrayfishState::SICK;
        } else if (g_state.gatewayConnected) {
            g_state.crayfishState = CrayfishState::SITTING;
        } else {
            g_state.crayfishState = CrayfishState::DORMANT;
        }
    }

    unlockState();
}

static void handleTimelineEvent(JsonObject& obj) {
    TimelineEntry entry;
    memset(&entry, 0, sizeof(entry));

    JsonObject e = obj["entry"].as<JsonObject>();
    uint64_t tsMs = e["ts"] | 0ULL;
    // Convert to seconds since midnight (compact for display)
    entry.ts = (uint32_t)((tsMs / 1000) % 86400);
    strncpy(entry.hm, e["localHm"] | "", sizeof(entry.hm) - 1);

    strncpy(entry.type, e["type"] | "", sizeof(entry.type) - 1);
    copyTextU8(entry.raw, sizeof(entry.raw), e["raw"] | "");
    if (e["detail"].is<const char*>())
        copyTextU8(entry.detail, sizeof(entry.detail), e["detail"].as<const char*>());
    if (e["status"].is<const char*>())
        strncpy(entry.status, e["status"].as<const char*>(), sizeof(entry.status) - 1);
    strncpy(entry.sessionId, e["sessionId"] | "", sizeof(entry.sessionId) - 1);
    strncpy(entry.agentType, e["agentType"] | "", sizeof(entry.agentType) - 1);
    copyTextU8(entry.projectName, sizeof(entry.projectName), e["projectName"] | "");
    strncpy(entry.taskId, e["taskId"] | "", sizeof(entry.taskId) - 1);

    lockState();
    // Upsert: check if existing entry matches (same ts + type)
    bool upsert = obj["upsert"] | false;
    if (upsert) {
        for (uint8_t i = 0; i < g_state.timelineCount; i++) {
            uint8_t idx = (g_state.timelineHead + i) % TIMELINE_MAX_ENTRIES;
            if (g_state.timeline[idx].ts == entry.ts &&
                strcmp(g_state.timeline[idx].type, entry.type) == 0) {
                g_state.timeline[idx] = entry;
                unlockState();
                return;
            }
        }
    }
    g_state.addTimelineEntry(entry);
    unlockState();
}

static void handleTimelineHistory(JsonObject& obj) {
    JsonArray entries = obj["entries"].as<JsonArray>();

#if defined(BOARD_T_EMBED)
    // Session-scoped reply (query_session_timeline) → knob History scrub
    // buffer, NOT the global ring — the reply is a backfill for one session
    // and must not clobber the live feed.
    {
        const char* sid = obj["sessionId"] | "";
        if (sid[0]) {
            size_t total = entries.size();
            size_t start = total > KNOB_SCRUB_CAP ? total - KNOB_SCRUB_CAP : 0;
            lockState();
            if (strcmp(g_state.scrubSessionId, sid) == 0) {
                g_state.scrubCount = 0;
                size_t i = 0;
                for (JsonObject e : entries) {
                    if (i++ < start) continue;
                    if (g_state.scrubCount >= KNOB_SCRUB_CAP) break;
                    ScrubEntry& se = g_state.scrub[g_state.scrubCount++];
                    memset(&se, 0, sizeof(se));
                    strncpy(se.hm, e["localHm"] | "", sizeof(se.hm) - 1);
                    strncpy(se.type, e["type"] | "", sizeof(se.type) - 1);
                    copyTextU8(se.text, sizeof(se.text), e["raw"] | "");
                }
            }
            unlockState();
            return;
        }
    }
#endif

    lockState();
    // Reset timeline and load history
    g_state.timelineHead = 0;
    g_state.timelineCount = 0;

    for (JsonObject e : entries) {
        TimelineEntry entry;
        memset(&entry, 0, sizeof(entry));

        uint64_t tsMs = e["ts"] | 0ULL;
        entry.ts = (uint32_t)((tsMs / 1000) % 86400);
        strncpy(entry.hm, e["localHm"] | "", sizeof(entry.hm) - 1);
        strncpy(entry.type, e["type"] | "", sizeof(entry.type) - 1);
        copyTextU8(entry.raw, sizeof(entry.raw), e["raw"] | "");
        if (e["detail"].is<const char*>())
            copyTextU8(entry.detail, sizeof(entry.detail), e["detail"].as<const char*>());
        if (e["status"].is<const char*>())
            strncpy(entry.status, e["status"].as<const char*>(), sizeof(entry.status) - 1);
        strncpy(entry.sessionId, e["sessionId"] | "", sizeof(entry.sessionId) - 1);
        strncpy(entry.agentType, e["agentType"] | "", sizeof(entry.agentType) - 1);
        copyTextU8(entry.projectName, sizeof(entry.projectName), e["projectName"] | "");
        strncpy(entry.taskId, e["taskId"] | "", sizeof(entry.taskId) - 1);

        g_state.addTimelineEntry(entry);
    }
    unlockState();
}

static void handleWifiProvision(JsonObject& obj) {
    const char* ssid = obj["ssid"] | "";
    const char* password = obj["password"] | "";
    const char* bridgeIp = obj["bridgeIp"] | "";
    uint16_t bridgePort = obj["bridgePort"] | BRIDGE_DEFAULT_PORT;
    const char* authToken = obj["authToken"] | "";

    if (ssid[0] == '\0' || password[0] == '\0') {
        Serial.println("[Provision] Missing SSID or password");
        Serial.println("{\"type\":\"wifi_provision_ack\",\"success\":false,\"error\":\"missing credentials\"}");
        return;
    }

    Serial.printf("[Provision] Received WiFi credentials: SSID=%s\n", ssid);

    // Store bridge endpoint for direct WebSocket connection after WiFi connects
    lockState();
    strncpy(g_state.bridgeIp, bridgeIp, sizeof(g_state.bridgeIp) - 1);
    g_state.bridgePort = bridgePort;
    strncpy(g_state.authToken, authToken, sizeof(g_state.authToken) - 1);
    unlockState();

    bool ok = false;
#if defined(BOARD_IPS10)
    if (Net::serialConnected()) {
        // USB serial is the primary IPS10 transport. Persist the daemon endpoint
        // refresh, but do not wake the hosted C6 radio; WiFi will reconnect from
        // the serial-timeout restore path when USB is actually removed.
        Net::wifiSaveProvisionedCredentials(ssid, password);
        Net::wifiSaveProvisionedBridge(bridgeIp, bridgePort, authToken);
        ok = true;
    } else
#endif
    {
        ok = Net::wifiConnectWith(ssid, password);
    }
    if (ok) {
        if (!Net::wifiRadioParked() && !Net::serialConnected()) {
            Net::wifiSaveProvisionedBridge(bridgeIp, bridgePort, authToken);
        }
        if (!Net::wifiRadioParked() && !Net::serialConnected() && bridgeIp[0] != '\0' && bridgePort != 0 && !Net::wsConnected()) {
            Net::wsConnect(bridgeIp, bridgePort, authToken);
        }
    }

    // Build ack response with ArduinoJson for safe serialization
    JsonDocument resp;
    resp["type"] = "wifi_provision_ack";
    resp["success"] = ok;
    if (ok) {
        resp["ip"] = Net::wifiLocalIP();
    } else {
        resp["error"] = "connection failed";
    }
    char buf[256];
    serializeJson(resp, buf, sizeof(buf));
    Net::serialWriteJsonLine(buf);
}

static void sendOtaAck(const char* otaId, const char* stage, uint32_t seq, uint32_t offset, uint32_t written) {
    JsonDocument resp;
    resp["type"] = "esp32_ota_ack";
    resp["otaId"] = otaId;
    resp["stage"] = stage;
    if (seq != UINT32_MAX) resp["seq"] = seq;
    resp["offset"] = offset;
    resp["written"] = written;

    char buf[192];
    serializeJson(resp, buf, sizeof(buf));
    Net::serialWriteJsonLine(buf);
    if (Net::wsConnected()) Net::wsSend(buf);
}

static void sendOtaError(const char* otaId, const char* stage, const char* error) {
    JsonDocument resp;
    resp["type"] = "esp32_ota_error";
    if (otaId && otaId[0]) resp["otaId"] = otaId;
    resp["stage"] = stage;
    resp["error"] = error;

    char buf[192];
    serializeJson(resp, buf, sizeof(buf));
    Net::serialWriteJsonLine(buf);
    if (Net::wsConnected()) Net::wsSend(buf);
}

static void resetOtaRx() {
    otaRx.active = false;
    otaRx.otaId[0] = '\0';
    otaRx.expectedSize = 0;
    otaRx.written = 0;
    otaRx.nextSeq = 0;
}

static void handleOtaBegin(JsonObject& obj) {
    const char* otaId = obj["otaId"] | "";
    const char* md5 = obj["md5"] | "";
    uint32_t size = obj["size"] | 0U;
    if (!otaId[0] || size == 0) {
        sendOtaError(otaId, "begin", "missing_parameters");
        return;
    }

    OtaCapability::Info cap = OtaCapability::get();
    if (!cap.supported) {
        sendOtaError(otaId, "begin", cap.reason);
        return;
    }
    if (cap.slotSize > 0 && size > cap.slotSize) {
        sendOtaError(otaId, "begin", "image_too_large");
        return;
    }
    if (otaRx.active) {
        Update.abort();
        resetOtaRx();
    }

    if (strlen(md5) == 32) {
        Update.setMD5(md5);
    }
    if (!Update.begin(size, U_FLASH)) {
        sendOtaError(otaId, "begin", "update_begin_failed");
        resetOtaRx();
        return;
    }

    otaRx.active = true;
    strncpy(otaRx.otaId, otaId, sizeof(otaRx.otaId) - 1);
    otaRx.otaId[sizeof(otaRx.otaId) - 1] = '\0';
    otaRx.expectedSize = size;
    otaRx.written = 0;
    otaRx.nextSeq = 0;
    sendOtaAck(otaRx.otaId, "begin", UINT32_MAX, 0, 0);
}

static void handleOtaChunk(JsonObject& obj) {
    const char* otaId = obj["otaId"] | "";
    uint32_t seq = obj["seq"] | UINT32_MAX;
    uint32_t offset = obj["offset"] | 0U;
    const char* data = obj["data"] | "";
    if (!otaRx.active || strcmp(otaRx.otaId, otaId) != 0) {
        sendOtaError(otaId, "chunk", "no_active_update");
        return;
    }
    if (seq + 1 == otaRx.nextSeq && offset < otaRx.written) {
        // Host may resend the last chunk after a WiFi reconnect if the ack was
        // lost after flash write completed. Treat that as idempotent.
        sendOtaAck(otaId, "chunk", seq, offset, otaRx.written);
        return;
    }
    if (seq != otaRx.nextSeq || offset != otaRx.written) {
        sendOtaError(otaId, "chunk", "unexpected_offset");
        return;
    }
    if (!data[0]) {
        sendOtaError(otaId, "chunk", "missing_data");
        return;
    }

    size_t decodedLen = 0;
    int rc = mbedtls_base64_decode(
        otaChunkBuf,
        sizeof(otaChunkBuf),
        &decodedLen,
        reinterpret_cast<const unsigned char*>(data),
        strlen(data)
    );
    if (rc != 0 || decodedLen == 0) {
        sendOtaError(otaId, "chunk", "base64_decode_failed");
        return;
    }
    if (otaRx.written + decodedLen > otaRx.expectedSize) {
        sendOtaError(otaId, "chunk", "image_overflow");
        return;
    }

    size_t wrote = Update.write(otaChunkBuf, decodedLen);
    if (wrote != decodedLen) {
        sendOtaError(otaId, "chunk", "update_write_failed");
        return;
    }

    otaRx.written += decodedLen;
    otaRx.nextSeq++;
    sendOtaAck(otaId, "chunk", seq, offset, otaRx.written);
}

static void handleOtaEnd(JsonObject& obj) {
    const char* otaId = obj["otaId"] | "";
    if (!otaRx.active || strcmp(otaRx.otaId, otaId) != 0) {
        sendOtaError(otaId, "end", "no_active_update");
        return;
    }
    if (otaRx.written != otaRx.expectedSize) {
        sendOtaError(otaId, "end", "size_mismatch");
        Update.abort();
        resetOtaRx();
        return;
    }
    if (!Update.end(true)) {
        sendOtaError(otaId, "end", "update_end_failed");
        resetOtaRx();
        return;
    }

    sendOtaAck(otaId, "end", UINT32_MAX, otaRx.written, otaRx.written);
    resetOtaRx();
    delay(250);
    ESP.restart();
}

static void handleOtaAbort(JsonObject& obj) {
    const char* otaId = obj["otaId"] | "";
    if (otaRx.active && (!otaId[0] || strcmp(otaRx.otaId, otaId) == 0)) {
        Update.abort();
        resetOtaRx();
    }
    sendOtaAck(otaId, "abort", UINT32_MAX, 0, 0);
}

static void sendDeviceInfo() {
    JsonDocument resp;
    resp["type"] = "device_info";

    #if defined(BOARD_LED8X32)
    resp["board"] = "ulanzi_tc001";
    #elif defined(BOARD_INKDECK)
    resp["board"] = "inkdeck";
    #elif defined(BOARD_TTGO)
    resp["board"] = "ttgo_t_display";
    #elif defined(BOARD_T_EMBED)
    resp["board"] = "t_embed";
    #elif defined(BOARD_T_DISPLAY_PRO)
    resp["board"] = "t_display_pro";
    #elif defined(BOARD_ESP32_C6_147)
    resp["board"] = "esp32_c6_147";
    #elif IS_ROUND
    resp["board"] = "round_amoled";
    #elif defined(BOARD_BOX_86) || defined(BOARD_86_BOX)
    resp["board"] = "86box";
    #elif defined(BOARD_IPS10)
    resp["board"] = "ips_10";
    #else
    resp["board"] = "ips_35";
    #endif

    resp["version"] = FIRMWARE_VERSION;
    resp["buildHash"] = GIT_SHA;
    resp["buildEpoch"] = (uint32_t)BUILD_EPOCH;
    resp["protocolRevision"] = PROTOCOL_REVISION;
    resp["wifiConfigured"] = Net::wifiConfigured();
    resp["wifiConnected"] = Net::wifiConnected();
    resp["wifiRadioParked"] = Net::wifiRadioParked();
    resp["uptimeSec"] = millis() / 1000;
    {
        esp_reset_reason_t resetReason = esp_reset_reason();
        resp["resetReasonCode"] = (int)resetReason;
        resp["resetReason"] = Util::resetReasonName(resetReason);
    }
    // Debug aid: what this board actually holds — lets a host-side probe
    // (daemon /devices) distinguish "data never parsed" from "render gating"
    // without stealing the serial port.
    resp["timelineCount"] = g_state.timelineCount;
    resp["sessionCount"] = g_state.sessionCount;
    resp["usageFiveH"] = (int)g_state.fiveHourPercent;   // -1 = no usage data held
    {
        uint8_t processing = 0;
        for (uint8_t i = 0; i < g_state.sessionCount; i++)
            if (strcmp(g_state.sessions[i].state, "processing") == 0) processing++;
        resp["processingCount"] = processing;
    }
    if (Net::wifiConnected()) {
        resp["ip"] = Net::wifiLocalIP();
    }
#if defined(BOARD_T_EMBED)
    {
        // Battery telemetry for the dashboard downstream rail (gauge-validated;
        // absent fields mean "no gauge answer", not 0%).
        // Capability advertisement — only what this firmware actually exposes
        // today (grow as ir/subghz land).
        {
            JsonArray caps = resp["capabilities"].to<JsonArray>();
            caps.add("battery");
            caps.add("nfc");
            caps.add("audio");
            if (Input::irReady()) caps.add("ir_rx");
        }
        Input::PowerStatus ps = Input::powerStatus();
        if (ps.valid) {
            resp["batteryPercent"] = ps.soc;
            resp["batteryCharging"] = ps.charging;
            resp["usbPowered"] = ps.usbPowered;
        } else {
            resp["batteryDiag"] = ps.gaugeErr;  // Wire error code — see power_monitor.h
        }
    }
#endif
#if defined(BOARD_T_DISPLAY_PRO)
    {
        // Remote peripheral diag — lets /devices answer "did touch/ALS init?"
        // without stealing the serial port.
        resp["touchReady"] = Input::touchReady();
        resp["alsReady"] = Input::lightReady();
    }
#endif
    OtaCapability::Info ota = OtaCapability::get();
    resp["otaSupported"] = ota.supported;
    resp["otaSlotCount"] = ota.slotCount;
    resp["otaSlotSize"] = ota.slotSize;
    resp["otaFreeSketchSpace"] = ota.freeSketchSpace;
    if (!ota.supported) resp["otaReason"] = ota.reason;

    // 768: the t_embed capabilities array + battery telemetry pushed the frame
    // past the old 512 (serializeJson truncates silently on overflow).
    char buf[768];
    serializeJson(resp, buf, sizeof(buf));
    // Both transports: serial for the USB-attached identify flow, WS so a
    // WiFi-only board (InkDeck) is registrable by the daemon without a cable.
    Net::serialWriteJsonLine(buf);
    if (Net::wsConnected()) Net::wsSend(buf);
}

namespace Protocol {

void announceDeviceInfo() { sendDeviceInfo(); }

void parseMessage(const char* json, size_t length) {
    // Reject oversized frames before feeding the elastic JsonDocument — an
    // unbounded sessions_list/timeline_history would otherwise grow the doc
    // until it fragments/exhausts the heap on no-PSRAM boards.
    if (length > PROTOCOL_MAX_MSG_BYTES) {
        Serial.printf("[Protocol] frame too large: %u bytes (max %u) — dropped\n",
                      (unsigned)length, (unsigned)PROTOCOL_MAX_MSG_BYTES);
        return;
    }
    doc.clear();
    DeserializationError err = deserializeJson(doc, json, length);
    if (err) {
        Serial.printf("[Protocol] JSON error: %s\n", err.c_str());
        return;
    }

    JsonObject obj = doc.as<JsonObject>();
    const char* type = obj["type"] | "";

    if (strcmp(type, "state_update") == 0) {
        handleStateUpdate(obj);
    } else if (strcmp(type, "usage_update") == 0) {
        handleUsageUpdate(obj);
    } else if (strcmp(type, "sessions_list") == 0) {
        handleSessionsList(obj);
    } else if (strcmp(type, "timeline_event") == 0) {
        handleTimelineEvent(obj);
    } else if (strcmp(type, "timeline_history") == 0) {
        handleTimelineHistory(obj);
    } else if (strcmp(type, "wifi_provision") == 0) {
        handleWifiProvision(obj);
    } else if (strcmp(type, "device_info_request") == 0) {
        sendDeviceInfo();
    } else if (strcmp(type, "esp32_ota_begin") == 0) {
        handleOtaBegin(obj);
    } else if (strcmp(type, "esp32_ota_chunk") == 0) {
        handleOtaChunk(obj);
    } else if (strcmp(type, "esp32_ota_end") == 0) {
        handleOtaEnd(obj);
    } else if (strcmp(type, "esp32_ota_abort") == 0) {
        handleOtaAbort(obj);
    } else if (strcmp(type, "display_state") == 0) {
        bool displayOn = obj["displayOn"] | true;
        // Optional `dim` instruction. Absent (un-upgraded host) ⇒ the `| default`
        // values keep legacy full-off: enabled=true, mode=off. We read displayOn
        // first so even firmware that ignored `dim` would still dim to 0.
        bool dimEnabled = obj["dim"]["enabled"] | true;
        const char* dimMode = obj["dim"]["mode"] | "off";
        int dimLevelPct = obj["dim"]["level"] | 0;
        uint8_t dimMode8 = (strcmp(dimMode, "min") == 0) ? 1 : 0;
        // Scale percent (1-100) → 0-255 backlight domain, rounded, floored at 1
        // so "minimum brightness" never collapses to full-off.
        int scaled = (dimLevelPct * 255 + 50) / 100;
        if (scaled < 1) scaled = 1;
        if (scaled > 255) scaled = 255;
        lockState();
        g_state.hostDisplayOn = displayOn;
        g_state.hostDimEnabled = dimEnabled;
        g_state.hostDimMode = dimMode8;
        g_state.hostDimLevel = (uint8_t)scaled;
        unlockState();
        Serial.printf("[Host] display %s (dim=%d mode=%d level=%d)\n",
                      displayOn ? "on" : "off", dimEnabled, dimMode8, scaled);
    } else if (strcmp(type, "set_orientation") == 0) {
        bool landscape = obj["landscape"] | true;
        lockState();
        g_state.pendingLandscape = landscape;
        g_state.orientationChanged = true;
        unlockState();
    } else if (strcmp(type, "connection") == 0) {
        // Connection status is handled by WS event callbacks
    } else if (strcmp(type, "touch_diag") == 0) {
#if defined(BOARD_IPS35)
        Serial.println("[TouchDiag] === I2C scan ===");
        for (uint8_t addr = 1; addr < 127; addr++) {
            Wire.beginTransmission(addr);
            if (Wire.endTransmission() == 0) {
                Serial.printf("[TouchDiag] Found device at 0x%02X\n", addr);
            }
        }
        // AXS15231B command protocol touch read
        static const uint8_t cmd[] = {
            0xB5, 0xAB, 0xA5, 0x5A, 0x00, 0x00, 0x00, 0x08,
            0x00, 0x00, 0x00
        };
        for (int attempt = 0; attempt < 5; attempt++) {
            Wire.beginTransmission(BOARD_TOUCH_ADDR);
            Wire.write(cmd, sizeof(cmd));
            uint8_t err = Wire.endTransmission();
            int n = Wire.requestFrom((uint8_t)BOARD_TOUCH_ADDR, (uint8_t)8);
            Serial.printf("[TouchDiag] Attempt %d: CMD err=%d, read %d bytes: ", attempt, err, n);
            for (int i = 0; i < n; i++) {
                Serial.printf("%02X ", Wire.read());
            }
            Serial.println();
            delay(100);
        }
        // Also try old register-style read for comparison
        Wire.beginTransmission(BOARD_TOUCH_ADDR);
        Wire.write((uint8_t)0x01);
        uint8_t err2 = Wire.endTransmission(false);
        int n2 = Wire.requestFrom((uint8_t)BOARD_TOUCH_ADDR, (uint8_t)6);
        Serial.printf("[TouchDiag] Old-style reg 0x01: err=%d, read %d bytes: ", err2, n2);
        for (int i = 0; i < n2; i++) {
            Serial.printf("%02X ", Wire.read());
        }
        Serial.println();
        Serial.printf("[TouchDiag] INT pin (GPIO %d) = %d\n", BOARD_PIN_TOUCH_INT, digitalRead(BOARD_PIN_TOUCH_INT));
#elif defined(BOARD_AMOLED)
        Serial.println("[TouchDiag] Round AMOLED — CST816S scan");
        for (uint8_t addr = 1; addr < 127; addr++) {
            Wire.beginTransmission(addr);
            if (Wire.endTransmission() == 0) {
                Serial.printf("[TouchDiag] Found device at 0x%02X\n", addr);
            }
        }
#else
        Serial.println("[TouchDiag] Not supported on this board");
#endif
    }
    // Ignore: encoder_state, button_state, deck_slot_map, voice_state
    // (not needed for display-only client)
}

}  // namespace Protocol
