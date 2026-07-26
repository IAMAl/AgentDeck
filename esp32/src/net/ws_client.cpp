#include "ws_client.h"
#include "serial_client.h"
#include "protocol.h"
#include "config.h"
#include "../state/agent_state.h"
#if defined(BOARD_T_EMBED)
#include "../audio/speaker_playback.h"
#endif

#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <WebSocketsClient.h>
#include <Arduino.h>
#include <mbedtls/base64.h>

static WebSocketsClient ws;
static bool connected = false;
static bool connecting = false;
static uint32_t reconnectMs = WS_RECONNECT_MIN_MS;
static uint32_t lastReconnectAttempt = 0;
static char savedIp[16] = {0};
static uint16_t savedPort = 0;
static char savedToken[40] = {0};

// ── outbound queue (UI core → network core) ──
// LVGL event callbacks run on CORE_UI; the WebSocket + serial transports are
// driven from CORE_NETWORK. arduinoWebSockets is not thread-safe, so UI-side
// senders enqueue here and the network task drains via pumpOutbound().
static constexpr int OUTBOX_MAX = 6;
static constexpr int OUTBOX_LEN = 200;
static char outbox[OUTBOX_MAX][OUTBOX_LEN];
static int outboxHead = 0;
static int outboxCount = 0;
static SemaphoreHandle_t outboxMutex = nullptr;

// ── binary audio ring (capture task → network core) ──
// 6 × 2 KB covers ~380 ms of 16 kHz mono PCM16 in flight, enough to ride out a
// WiFi hiccup without stalling the I2S reader.
//
// Board-guarded: 12 KB of DRAM is a rounding error on a PSRAM S3 and fatal on
// the TTGO, whose 46 KB canvas already crowds dram0_0_seg — allocating it there
// overflowed the segment by 13 KB and broke that board's build outright. Only a
// board with a microphone can ever fill this ring, so only such a board pays
// for it. Nothing gates ESP32 builds in CI, which is why the break stayed
// invisible until a full-fleet compile.
#if defined(BOARD_T_EMBED)
static constexpr int AUDIO_SLOTS = 6;
static constexpr size_t AUDIO_SLOT_BYTES = 2048;
static uint8_t audioRing[AUDIO_SLOTS][AUDIO_SLOT_BYTES];
static size_t audioLen[AUDIO_SLOTS] = {0};
static int audioHead = 0;
static int audioCount = 0;
static SemaphoreHandle_t audioMutex = nullptr;
#endif

static void onWsEvent(WStype_t type, uint8_t* payload, size_t length) {
    switch (type) {
        case WStype_DISCONNECTED:
            Serial.println("[WS] Disconnected");
            connected = false;
            connecting = false;
            lockState();
            // Only mark disconnected if serial is also not connected
            // (serial data is authoritative — don't override it)
            if (!Net::serialConnected()) {
                g_state.markBridgeDisconnected();
            }
            unlockState();
            break;

        case WStype_CONNECTED:
            Serial.printf("[WS] Connected to %s:%d\n", savedIp, savedPort);
            connected = true;
            connecting = false;
            reconnectMs = WS_RECONNECT_MIN_MS;
            ws.setReconnectInterval(reconnectMs);
            lockState();
            g_state.wsConnected = true;
            g_state.lastMessageMs = millis();
            unlockState();
            // Request initial state + identify ourselves (device_info is
            // request-driven on serial, but nothing requests it over WS — a
            // WiFi-only board must announce or the daemon never learns its
            // board/buildHash).
            Net::wsSendCommand("query_usage");
            Protocol::announceDeviceInfo();
            break;

        case WStype_TEXT:
            Protocol::parseMessage((const char*)payload, length);
            lockState();
            g_state.lastMessageMs = millis();
            unlockState();
            break;

        case WStype_BIN:
#if defined(BOARD_T_EMBED)
            // Inbound binary is spoken-reply PCM, bracketed by
            // audio_play_begin/end. Dropped when the ring is full: a late frame
            // is worse than a gap, and blocking here would stall WS reads.
            Audio::playbackFeed(payload, length);
#endif
            lockState();
            g_state.lastMessageMs = millis();
            unlockState();
            break;

        case WStype_PING:
            // Library handles pong automatically
            break;

        case WStype_PONG:
            break;

        case WStype_ERROR:
            Serial.println("[WS] Error");
            break;

        default:
            break;
    }
}

namespace Net {

void wsInit() {
    if (!outboxMutex) outboxMutex = xSemaphoreCreateMutex();
#if defined(BOARD_T_EMBED)
    if (!audioMutex) audioMutex = xSemaphoreCreateMutex();
#endif
}

#if !defined(BOARD_T_EMBED)
// Boards without a microphone keep the API but never carry the buffer.
bool queueAudioChunk(const uint8_t*, size_t) { return false; }
bool audioBacklogged() { return false; }
#else
bool queueAudioChunk(const uint8_t* data, size_t len) {
    if (!data || len == 0 || len > AUDIO_SLOT_BYTES || !audioMutex) return false;
    bool queued = false;
    xSemaphoreTake(audioMutex, portMAX_DELAY);
    if (audioCount < AUDIO_SLOTS) {
        int idx = (audioHead + audioCount) % AUDIO_SLOTS;
        memcpy(audioRing[idx], data, len);
        audioLen[idx] = len;
        audioCount++;
        queued = true;
    }
    xSemaphoreGive(audioMutex);
    return queued;
}

bool audioBacklogged() {
    if (!audioMutex) return false;
    xSemaphoreTake(audioMutex, portMAX_DELAY);
    bool any = audioCount > 0;
    xSemaphoreGive(audioMutex);
    return any;
}
#endif  // BOARD_T_EMBED

// Enqueue an outbound JSON command from any task (typically CORE_UI). Dropped if
// the small queue is full — interactive commands are user-paced, not bursty.
void queueOutbound(const char* json) {
    if (!json || !json[0] || !outboxMutex) return;
    xSemaphoreTake(outboxMutex, portMAX_DELAY);
    if (outboxCount < OUTBOX_MAX) {
        int idx = (outboxHead + outboxCount) % OUTBOX_MAX;
        strncpy(outbox[idx], json, OUTBOX_LEN - 1);
        outbox[idx][OUTBOX_LEN - 1] = '\0';
        outboxCount++;
    }
    xSemaphoreGive(outboxMutex);
}

// Drain the outbound queue on CORE_NETWORK. Sends over WS when connected, else
// over the serial bridge. Call once per network-task iteration.
void pumpOutbound() {
    if (!outboxMutex) return;
    while (true) {
        char line[OUTBOX_LEN];
        xSemaphoreTake(outboxMutex, portMAX_DELAY);
        if (outboxCount == 0) { xSemaphoreGive(outboxMutex); break; }
        strncpy(line, outbox[outboxHead], sizeof(line));
        line[sizeof(line) - 1] = '\0';
        outboxHead = (outboxHead + 1) % OUTBOX_MAX;
        outboxCount--;
        xSemaphoreGive(outboxMutex);
        if (connected) ws.sendTXT(line);
        else Net::serialWriteJsonLine(line);  // serial bridge consumes line-delimited JSON
    }

#if defined(BOARD_T_EMBED)
    // Binary audio frames — WS only. Dropped (not buffered) when the socket is
    // down: a voice utterance is worthless late, and holding it would stall
    // the capture task behind a dead link.
    while (audioMutex) {
        uint8_t frame[AUDIO_SLOT_BYTES];
        size_t len = 0;
        xSemaphoreTake(audioMutex, portMAX_DELAY);
        if (audioCount == 0) { xSemaphoreGive(audioMutex); break; }
        len = audioLen[audioHead];
        memcpy(frame, audioRing[audioHead], len);
        audioHead = (audioHead + 1) % AUDIO_SLOTS;
        audioCount--;
        xSemaphoreGive(audioMutex);
        if (len == 0) continue;
        if (connected) {
            ws.sendBIN(frame, len);
#if defined(BOARD_T_EMBED)
        } else if (Net::serialConnected()) {
            // USB-attached: the board's WiFi WS is parked, but the mic must not
            // go dead just because the user plugged in to charge. Serial is
            // line-delimited JSON, so the samples ride base64 — raw PCM would
            // tear the framing for every other reader of this port.
            //
            // Board-guarded because the 3 KB line buffer is DRAM: only the board
            // with a microphone can ever reach this branch, and the no-PSRAM
            // boards have no room to spare for a buffer they cannot use.
            static char line[3072];
            const char* prefix = "{\"type\":\"audio_chunk\",\"d\":\"";
            size_t pfx = strlen(prefix);
            memcpy(line, prefix, pfx);
            size_t wrote = 0;
            if (mbedtls_base64_encode((unsigned char*)line + pfx,
                                      sizeof(line) - pfx - 4, &wrote,
                                      frame, len) == 0) {
                line[pfx + wrote] = '"';
                line[pfx + wrote + 1] = '}';
                line[pfx + wrote + 2] = '\0';
                Net::serialWriteJsonLine(line);
            }
#endif  // BOARD_T_EMBED
        }
    }
#endif  // BOARD_T_EMBED
}

void wsConnect(const char* ip, uint16_t port, const char* token) {
    if (connected || connecting) {
        return;
    }
    connecting = true;

    // Disconnect any existing attempt before beginning a new one
    ws.disconnect();
    delay(10);

    strncpy(savedIp, ip, sizeof(savedIp) - 1);
    savedPort = port;
    strncpy(savedToken, token, sizeof(savedToken) - 1);

    // Build URL path with token
    char path[104];
    if (token[0] != '\0') {
        snprintf(path, sizeof(path), "/?token=%s&clientType=esp32", token);
    } else {
        strcpy(path, "/?clientType=esp32");
    }

    ws.begin(ip, port, path);
    ws.onEvent(onWsEvent);
    ws.setReconnectInterval(reconnectMs);
    ws.enableHeartbeat(WS_PING_INTERVAL_MS, WS_PONG_TIMEOUT_MS, 2);

    Serial.printf("[WS] Connecting to %s:%d\n", ip, port);
}

void wsDisconnect() {
    ws.disconnect();
    connected = false;
    connecting = false;
}

void wsLoop() {
    if (!WiFi.isConnected()) {
        if (connected || connecting) {
            ws.disconnect();
        }
        connected = false;
        connecting = false;
        return;
    }

    ws.loop();

    // Exponential backoff reconnection. The library's internal reconnect timer
    // is driven by setReconnectInterval(); we must push updated values into it
    // whenever our backoff grows, otherwise it sticks at whatever was set at
    // wsConnect() time.
    if (!connected && savedIp[0] != '\0') {
        uint32_t now = millis();
        if (now - lastReconnectAttempt > reconnectMs) {
            lastReconnectAttempt = now;
            uint32_t next = reconnectMs * 2;
            if (next > WS_RECONNECT_MAX_MS) next = WS_RECONNECT_MAX_MS;
            reconnectMs = next;
            ws.setReconnectInterval(reconnectMs);
        }
    }
}

uint32_t wsLastAttemptMs() {
    return lastReconnectAttempt;
}

uint32_t wsBackoffMs() {
    return reconnectMs;
}

bool wsConnected() {
    return connected;
}

bool wsConnecting() {
    return connecting;
}

void wsSend(const char* json) {
    if (connected) {
        ws.sendTXT(json);
    }
}

void wsSendCommand(const char* type) {
    char buf[64];
    snprintf(buf, sizeof(buf), "{\"type\":\"%s\"}", type);
    wsSend(buf);
}

void wsSendRespond(const char* value) {
    char buf[128];
    snprintf(buf, sizeof(buf), "{\"type\":\"respond\",\"value\":\"%s\"}", value);
    wsSend(buf);
}

void wsSendSelectOption(uint8_t index) {
    char buf[64];
    snprintf(buf, sizeof(buf), "{\"type\":\"select_option\",\"index\":%d}", index);
    wsSend(buf);
}

void wsSendInterrupt() {
    wsSendCommand("interrupt");
}

void wsSendEscape() {
    wsSendCommand("escape");
}

}  // namespace Net
