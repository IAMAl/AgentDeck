---
id: hardware.compatibility
title: Hardware and OS Compatibility
description: Canonical device, panel, transport, host, and App Store compatibility matrix.
category: Specs
locale: en
canonical: true
status: stable
owner: Hardware maintainers
reviewed: 2026-07-25
revision: 2026-07-25
source_of_truth: docs/hardware-compatibility.md
validators: [node scripts/build-design-system-viewer.mjs --check, bash esp32/robot/run.sh all]
translations: [ko, ja]
---

# Hardware and OS Compatibility

This is the source of truth for AgentDeck dashboard surfaces and their compatibility. A **surface** is any hardware, app, or terminal client that connects to the daemon hub and renders or controls agent state.

Reader translations: [한국어](../agentdeck-design-system/locales/ko/hardware-compatibility.md) · [日本語](../agentdeck-design-system/locales/ja/hardware-compatibility.md). English remains canonical; translations carry the same revision and must not introduce new facts.

## Ownership

| Fact | Canonical source |
|---|---|
| Cross-platform device, panel, transport, and compatibility data | This document |
| ESP32 flashing, pins, ports, provisioning, and OTA | [ESP32 operations](esp32.md) |
| Device protocol, discovery, and event handling | [Device transports](devices.md) |
| Android build and e-ink rendering | [Android](android.md) |
| App Store versus CLI feature gates | [App Store feature matrix](appstore-feature-matrix.md) |

Do not copy numeric specifications into domain guides. Link back to this matrix and keep operational detail in the owning guide.

## Support legend

| Mark | Meaning |
|:---:|---|
| Yes | Supported by the App Store Swift daemon or app |
| Partial | Supported with a stated limitation or pending hardware verification |
| CLI | Requires the external Node daemon or a CLI-managed transport |
| Experimental | Registration or firmware is under active development |

## Surface matrix

| Surface | Class | Platform / controller | Display | Transport | App Store |
|---|---|---|---|---|:---:|
| IPS 3.5 | ESP32 display | ESP32-S3 | AXS15231B IPS · 480×320 | USB serial · Wi-Fi WS | Yes |
| Round AMOLED 1.8 | ESP32 display | ESP32-S3 | ST77916 · 360×360 | USB serial · Wi-Fi WS | Yes |
| 86 Box 4.0 | ESP32 display | ESP32-S3 | ST7701 IPS · 480×480 | USB serial · Wi-Fi WS | Yes |
| TTGO T-Display 1.14 | ESP32 display | ESP32 classic | ST7789 · 135×240 | USB serial · Wi-Fi WS | Yes |
| Waveshare LCD 1.47 | ESP32 display | ESP32-C6 | ST7789 · 172×320 | USB serial · Wi-Fi WS | Yes |
| IPS 10.1 | ESP32 display | ESP32-P4 + C6 | JD9365 MIPI-DSI · 800×1280 | USB serial · Wi-Fi WS | Yes |
| Ulanzi TC001 | ESP32 LED | ESP32 classic | WS2812B · 32×8 | USB serial · Wi-Fi WS | Partial |
| InkDeck | ESP32 e-ink | XIAO ESP32-S3 Plus | UC8179 · 800×480 | USB serial · Wi-Fi WS | Yes |
| XTeink X3 | e-ink reader | ESP32-C3 | 3.7-inch · 528×792 | Wi-Fi WS | Partial |
| XTeink X4 | e-ink reader | ESP32-C3 | 800×480 | Wi-Fi WS | Partial |
| Divoom Pixoo64 | Commercial LED | Divoom controller | RGB LED · 64×64 | HTTP REST | Yes |
| iDotMatrix | Commercial pixel display | BLE SoC | RGB · 32×32 | BLE GATT | Yes |
| Divoom Timebox Mini | Commercial LED | BLE SoC | RGB LED · 11×11 | BLE GATT | Yes |
| Ulanzi D200H | HID deck | SigmaStar SSD210 | LCD keys · logical 960×540 | Ulanzi Studio plugin | Yes |
| Stream Deck | HID deck | Elgato | 15 LCD keys · 5×3 | Elgato plugin → WS | Yes |
| Stream Deck Mini | HID deck | Elgato | 6 LCD keys · 3×2 | Elgato plugin → WS | Yes |
| Stream Deck+ | HID deck | Elgato | 8 keys · 4 dials · touch strip | Elgato plugin → WS | Yes |
| macOS | App | Apple Silicon · Intel | Host display | In-process Swift daemon | Yes |
| iOS / iPadOS | App | A-series · M-series | Device display | Wi-Fi WS | Yes |
| Android e-ink | App | Vendor-specific | B&W or color e-ink | ADB localhost · mDNS | Partial |
| Android tablet | App | ARM · x86 | Color LCD | mDNS · Wi-Fi WS | Partial |
| TUI dashboard | Terminal | Host CPU | Truecolor terminal | WS | Yes |
| SSE stream | Protocol | Host | Browser or script | HTTP `/sse` | Partial |

`App Store` describes compatibility with the submitted Apple app and its Swift daemon, not whether third-party host software is bundled. Stream Deck and D200H still require their vendor applications.

**Counted surfaces: 22.** Public surface-count claims (README, landing page) mirror this derivation: every row above except the protocol rows (SSE stream) counts. XTeink X3/X4 operate normally (both register with the daemon over Wi-Fi) but run the community CrossPoint fork — their Partial mark states that distribution limitation, see operational exceptions. Update this line and the mirrors together when rows change.

## ESP32 board specification sheet

The AgentDeck firmware uses PlatformIO and Arduino. LVGL 9.2 drives LCD boards; TC001 uses FastLED; InkDeck uses its e-ink renderer. USB port names are not identities—probe `device_info_request` before flashing.

Rows are ordered by overall capability, applied in this precedence: SoC class, then memory, then panel capability, then peripheral breadth. Boards of the same character sit together. Two status values appear:

- **Shipping** — runs AgentDeck firmware from `esp32/`, and has a row in the surface matrix above.
- **Evaluation** — hardware on hand that AgentDeck does not yet build firmware for. These rows are *not* counted as surfaces and carry no compatibility claim; they exist so board selection starts from measured facts rather than vendor copy.

| Board | `device_info.board` · env | SoC | Flash · PSRAM | Panel · controller | Input | Notable peripherals | USB | OTA slot | Status |
|---|---|---|---|---|---|---|---|---:|---|
| JC8012P4A1C | `ips_10` · `ips10` | ESP32-P4NRW32 + C6 | 16 MB · 32 MB | JD9365 MIPI-DSI · 800×1280 | GSL3680 touch | ESP32-C6 Wi-Fi coprocessor | CH340 | 6 MB | Shipping |
| ESP32-S3-4848S040 | `86box` · `box_86` | ESP32-S3 | 16 MB · 8 MB | ST7701 RGB IPS · 480×480 | GT911 touch | — | CH340 | 7.75 MB | Shipping |
| JC3248W535 | `ips_35` · `ips35` | ESP32-S3 | 16 MB · 8 MB | AXS15231B QSPI IPS · 480×320 | AXS15231B touch (0x3B) | FAT data partition | Native USB JTAG | 3.5 MB | Shipping |
| LilyGO T-Display-S3-Pro V1.1 · GC0308 | — | ESP32-S3R8 | 16 MB · 8 MB | ST7796U SPI IPS · 480×222 | CST226SE touch (0x5A) · 3 buttons | GC0308 camera · SY6970 PMU (0x6A) · LTR-553ALS (0x23) · microSD · 470 mAh | Native USB JTAG | — | Evaluation |
| LilyGO T-Display-S3-Pro V1.1 · no camera | — | ESP32-S3R8 | 16 MB · 8 MB | ST7796U SPI IPS · 480×222 | CST226SE touch (0x5A) · 3 buttons | SY6970 PMU (0x6A) · LTR-553ALS (0x23) · microSD · 470 mAh · camera POGO header | Native USB JTAG | — | Evaluation |
| LilyGO T-Embed CC1101 | — | ESP32-S3-WROOM-1 | 16 MB · 8 MB | ST7789 IPS · 320×170 | Rotary encoder · button | CC1101 sub-GHz · PN532 NFC (0x24) · IR TX/RX · 8× WS2812 · mic + speaker · BQ25896 (0x6B) · BQ27220 (0x55) · microSD · 1300 mAh | Native USB JTAG | — | Evaluation |
| JC3636W518 | `round_amoled` · `amoled` | ESP32-S3 | 8 MB · 8 MB | ST77916 QSPI AMOLED · 360×360 round | CST816S touch | — | Native USB JTAG | 3 MB | Shipping |
| Seeed TRMNL 7.5 DIY Kit | `inkdeck` · `inkdeck` | XIAO ESP32-S3 Plus | 8 MB · 8 MB | UC8179 e-ink · 800×480 | — | USB-powered only | Native USB CDC | 3.19 MB | Shipping |
| Waveshare ESP32-C6-LCD-1.47 | `esp32_c6_147` · `esp32_c6_147` | ESP32-C6 | 4 MB · none | ST7789 · 172×320 | — | — | Native USB CDC | Single app | Shipping |
| LilyGO T-Display | `ttgo_t_display` · `ttgo` | ESP32 classic | 16 MB · none | ST7789 SPI · 135×240 | 2 buttons | — | CH340 | 6 MB | Shipping |
| Ulanzi TC001 | `ulanzi_tc001` · `led8x32` | ESP32 classic | 8 MB · none | WS2812B matrix · 32×8 | 3 buttons | Buzzer on GPIO 15 (silenced at boot) | CH340 | 3 MB | Shipping |

The ordering is by panel and compute, so peripheral breadth does not drive it. On that separate axis the T-Embed CC1101 leads every board here: it is the only unit with a rotary encoder, and the only one carrying a sub-GHz radio, NFC, and infrared. It is also the only bidirectional-input candidate in the fleet — every Shipping board is output-only apart from touch.

OTA slot sizes are the measured `device_info.otaSlotSize` from live boards, matching `esp32/partitions/*.csv`. Evaluation units run vendor factory firmware and have no AgentDeck OTA layout; their shipped partition tables are single-app 4 MB (T-Display-S3-Pro) and dual-OTA 6.25 MB (T-Embed CC1101). Factory images and restore instructions live in [`esp32/backups/MANIFEST.md`](../esp32/backups/MANIFEST.md).

Operational exceptions:

- `box_86` is the 86 Box environment and the `default_envs` target. The former `rgb48` duplicate — a LovyanGFX build on espressif32@6.9.0 — was removed on 2026-07-20 when the board consolidated onto the pioarduino/Arduino_GFX stack the other S3 boards use.
- TTGO flashing uses 57,600 baud with `--no-stub`; its no-PSRAM renderer has a deliberately small buffer.
- IPS 10.1 uses a 16 MB dual-OTA layout with 6 MB slots and requires internal-memory LVGL buffers. Its ESP32-C6 is the Wi-Fi coprocessor.
- Existing factory or old-partition 86 Box and IPS 10.1 units require one USB full flash before OTA.
- InkDeck serial reflashing must go through the download-mode port with `boot_app0.bin` included (native-CDC re-enumeration makes plain `pio -t upload` unreliable); routine updates ship over WiFi OTA instead. A residual crash in the prebuilt Espressif mDNS component is under observation and does not affect the render or OTA path.
- XTeink X3/X4 run the external CrossPoint Reader fork, not the `esp32/` PlatformIO project. They are not distributed through AgentDeck releases and flash via SD-card `update.bin` only (no WiFi OTA). Their wire contract is [ESP32 client contract](esp32-client-contract.md).
- T-Display-S3-Pro ships in hardware revisions V1.0 and V1.1 that differ in backlight drive, with no runtime detection — the vendor selects it at compile time with `USING_DISPLAY_PRO_V1`. V1.0 is LEDC PWM with 255 levels; V1.1 is a constant-current driver pulsed on GPIO 48 with 16 levels. Both on-hand units are V1.1, so that flag must stay undefined for them. The vendor `platformio.ini` comment on this flag has its two revisions transposed; the `#ifdef` branches in `AdjustBacklight.ino` and `utilities.h` are authoritative.
- T-Display-S3-Pro camera is a purchase option (`GC0308`, `OV5640`, or none) on a POGO shield header, not a board revision. Its SCCB lines share the I2C bus with touch, PMU, and the light sensor, so capture and touch responsiveness interact.
- T-Embed CC1101 has a known upstream defect where the panel stays dark after flashing; the vendor ships a dedicated fix image and advises pressing `RST` on the back afterwards. Check this before diagnosing a hardware fault.

## Pixel displays and control decks

| Device | Rendering / ownership constraint |
|---|---|
| Pixoo64 | LAN HTTP REST; no supported raw-frame BLE path. AgentDeck throttles frame pushes and recovers from device-side timeouts. |
| iDotMatrix | Native 32×32 composition over BLE. The daemon owns one BLE display connection at a time. |
| Timebox Mini | Dedicated 11×11 Agent Beacon over ISSC BLE GATT. It shares the single BLE connection budget with iDotMatrix. |
| TC001 | Self-rendering serial/Wi-Fi board. App Store status is Partial only because the Swift `led8x32` path awaits hardware verification; this is not a sandbox restriction. |
| D200H | Ulanzi Studio plugin is the only driver. Direct-HID implementations are retired. |
| Stream Deck family | One plugin provides bundled profiles for standard, Mini, and Plus. XL grid calculation exists, but no XL profile ships. |

## Software platforms

| Platform | Minimum / toolchain | Connection model | Constraint |
|---|---|---|---|
| macOS | macOS 26 · Xcode 26.6 · Swift 6 | In-process Swift daemon on port 9120 | App Store sandbox; no subprocesses or bundled interpreter |
| iOS / iPadOS | iOS 17 · Swift 6 | Bonjour + same-LAN WS | Client only; no direct hardware modules |
| Android | minSdk 29 · target/compileSdk 34 · JDK 17 | ADB localhost first, then mDNS | ADB reverse is CLI-only; same-LAN discovery is sandbox-safe |
| Node bridge | Node.js 22+ | Daemon on port 9120 | Supported on macOS and Windows 11; Linux is not an official host |

Android e-ink uses vendor-native refresh controls: Crema and MOAAN use `EinkManager`, Onyx uses its update-mode API, Bigme uses a color palette path, and Kobo falls back to invalidation. Android and Apple share the wire protocol; their render and discovery layers remain platform-native.

## Protocol surfaces

| Surface | Contract | Limitation |
|---|---|---|
| TUI | WS client, truecolor ANSI, responsive at 60/80/120 columns | Push-only view |
| SSE | `GET /sse` on daemon port 9120 | Full streaming and heartbeats exist in the Node bridge. The Swift daemon currently sends only the initial `connected` event. |

## Change checklist

1. Update the owning row here before changing a public device count or compatibility claim.
2. Update the domain guide only for operational behavior; do not duplicate specifications.
3. Update the matching KR and JP translation revision without adding translation-only facts.
4. Run the frontmatter/catalog validator and the relevant runtime or hardware suite.
5. Keep the GitHub Pages viewer generated from these sources; never hand-edit generated viewer content.
