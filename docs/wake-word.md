# Wake Word Detection

> **Status note (2026-08-05):** Porcupine (§1) is the only wake word AgentDeck ships; it was last verified 2026-03. §2 microWakeWord is **not in the firmware** — the on-board listener was removed on 2026-08-05 and only the trained model + the trainer recipe remain. Read §2 as a resume guide, not as a description of running code.

AgentDeck는 두 가지 wake word 감지 시스템을 지원한다.

## 1. Porcupine (Mac — 현재 운영)

Mac Studio 모니터 마이크로 "오픈클로" 키워드 감지.

- **엔진**: Picovoice Porcupine (`@picovoice/porcupine-node`)
- **키워드**: `~/.agentdeck/wake-word/*.ppn` (한국어 커스텀 모델)
- **언어모델**: `~/.agentdeck/wake-word/*.pv` (Korean)
- **Access key**: `~/.agentdeck/picovoice-key.txt`
- **코드**: `bridge/src/wake-word.ts` — `WakeWordListener` class
- **설정**: `~/.agentdeck/settings.json` — `wakeWordMic`, `wakeWordSensitivity`
- **제한**: 모니터 sleep 시 마이크 비활성 → 감지 불가

## 2. microWakeWord (ESP32 — 펌웨어에서 제거됨, 모델만 보관)

목표는 ESP32-S3의 내장 마이크로 상시 감지해서 모니터가 잠들어도 동작하게 하는 것이었다. **현재 펌웨어에는 이 기능이 없다.**

- **엔진**: microWakeWord (TFLite Micro, MixConv streaming)
- **모델**: `esp32/models/openclaw_wake_word.tflite` (62KB, INT8 양자화)
- **타겟 보드**: Round AMOLED JC3636W518 (ESP32-S3, I2S PDM mic GPIO45/46)
- **추론**: ~0.026M MACs, <10ms per frame on ESP32-S3

### 모델 훈련 환경

```
~/github/microWakeWord-Trainer-AppleSilicon/
├── .venv/                    # arm64 Python 3.11 + TF 2.16 + Metal
├── generated_samples/        # Edge-TTS 한국어 945개 WAV (16kHz mono)
├── generate_korean_samples.py  # Edge-TTS 샘플 생성 스크립트
├── train_openclaw_ko.sh      # 한국어 훈련 래퍼
├── trained_models/           # 훈련된 모델
└── micro-wake-word/          # microWakeWord 소스 (TaterTotterson fork)
```

### 훈련 파이프라인

1. **샘플 생성** (Edge-TTS — Piper에 한국어 없음)
   - 3 음성: SunHi(여), InJoon(남), Hyunsu(남 다국어)
   - 7 속도 × 3 피치 × 3 볼륨 × 5 텍스트변형 = 945개
   - `uv run --python 3.11 --with edge-tts -- python generate_korean_samples.py`

2. **증강 데이터셋** (자동 다운로드)
   - MIT RIR (270 room impulse responses)
   - AudioSet (18,683 clips)
   - FMA xsmall (210 music clips)
   - WHAM (28,000 noise clips)
   - CHiME-Home (실패 — archive.org 불안정, 다른 3개로 충분)

3. **Feature 생성** — 40-feature spectrograms, SpecAugment, background noise 5-10dB SNR

4. **훈련** — 40,000 steps, Metal GPU (M1 Max), ~30분
   - MixConv: `[5], [7,11], [9,15], [23]` kernels, 64 pointwise filters
   - 최종: Accuracy 1.000, Recall 1.000, Precision 1.000, Loss 0.0002
   - FRR 0%, FAPH 0.19 at cutoff 0.07

5. **출력** — `stream_state_internal_quant.tflite` (62KB INT8)

### 재훈련

```bash
cd ~/github/microWakeWord-Trainer-AppleSilicon
source .venv/bin/activate

# 샘플 재생성 (필요시)
WAKE_WORD="오픈클로" uv run --python 3.11 --with edge-tts -- python generate_korean_samples.py

# 훈련 (기존 샘플 + 데이터셋 재사용)
export TARGET_WORD="오픈클로" MWW_LANGUAGE="ko"
python scripts_macos/make_features.py
python scripts_macos/fetch_negatives.py
python scripts_macos/write_training_yaml.py
python -m microwakeword.model_train_eval \
  --training_config=training_parameters.yaml \
  --train 1 --restore_checkpoint 1 \
  --test_tflite_streaming_quantized 1 \
  --use_weights "best_weights" \
  mixednet \
  --pointwise_filters "64,64,64,64" \
  --repeat_in_block "1,1,1,1" \
  --mixconv_kernel_sizes "[5], [7,11], [9,15], [23]" \
  --residual_connection "0,0,0,0" \
  --first_conv_filters 32 \
  --first_conv_kernel_size 5 \
  --stride 2

# 모델 복사
cp trained_models/wakeword/tflite_stream_state_internal_quant/stream_state_internal_quant.tflite \
   ~/github/AgentDeck/esp32/models/openclaw_wake_word.tflite
```

### 환경 의존성

- **Python**: 3.11 arm64 (`uv python install 3.11`)
- **TensorFlow**: 2.16.2 + tensorflow-metal 1.2.0 (Metal GPU)
- **ffmpeg**: arm64 (`/opt/homebrew/opt/ffmpeg@7`), symlink `/opt/homebrew/opt/ffmpeg` 필수
- **torchcodec**: ffmpeg@7 rpath 의존 — symlink 없으면 import 실패

### ESP32 통합 (2026-08-05 제거됨)

펌웨어 쪽 코드는 지웠다. 지운 이유는 하드웨어가 없어서가 아니라, **남아 있던 코드가 이름값을 못 했기 때문이다**:

- `wake_word.cpp` 는 I2S PDM RX + RMS VAD 까지만 구현돼 있었고 **TFLite 인터프리터를 부르는 코드가 없었다** — 파일 이름과 헤더 주석만 microWakeWord 였다.
- 어떤 보드 코드도 `Audio::wakeWordInit/Start` 를 호출하지 않았다. 유일한 게이트 `BOARD_HAS_AUDIO` 는 실장 보드에서 `0`, 나머지에서는 주석 처리 상태였다.
- 63,520 B 모델이 `wake_word_model.h` 에 C 배열로 임베드돼 있었다(소스 397 KB). 아무도 읽지 않는 배열이 매 빌드마다 따라다녔다.

삭제된 것: `esp32/src/audio/wake_word.{cpp,h}`, `esp32/src/audio/wake_word_model.h`, 보드 헤더의 `BOARD_HAS_AUDIO`, `platformio.ini` 의 `-<audio/wake_word.*>` 제외 규칙.
**남긴 것**: `esp32/models/openclaw_wake_word.tflite` (62 KB, 훈련 산출물) — 위 훈련 파이프라인의 결과물이고, 재개하면 그대로 다시 임베드하면 된다.

보유 보드의 마이크 사정도 그대로다:
- Round AMOLED (JC3636W518): 핀 정의만 있고 칩 미실장 — I2S PDM 테스트 결과 DC offset(~1310) 고정
- 86 Box (4848S040) · IPS 3.5" (JC3248W535): 오디오 핀 없음
- IPS 10.1" (JC8012P4A1C): ES8311 코덱 실장 확인 — 단 push-to-talk 캡처/재생 경로로만 쓰고 있다 (`mic_capture.cpp` / `speaker_playback.cpp`, 별도 기능)

**재개 조건 (셋 다 필요):**
1. 상시 켜둘 마이크가 있는 보드 — IPS 10.1" 의 ES8311 ADC 를 상시 캡처로 돌리거나, MEMS 마이크 내장 S3 보드(ESP32-S3-BOX-3, INMP441 모듈 등)
2. TFLite Micro 추론 실제 구현 — pioarduino GCC 14 호환 라이브러리 또는 ESP-IDF 네이티브 빌드, + 40-feature 스펙트로그램 프런트엔드
3. 실기 검증 — 이 저장소의 ESP32 규칙상 하드웨어에서 확인하기 전에는 "동작한다"고 쓰지 않는다

복원 지점: 삭제 커밋의 `esp32/src/audio/wake_word.*` (git 히스토리에 그대로 있다).

### Porcupine vs microWakeWord

| | Porcupine (Mac) | microWakeWord (ESP32) |
|---|---|---|
| 플랫폼 | macOS arm64 | ESP32-S3 |
| 모델 | .ppn (Picovoice Console) | .tflite (자체 훈련) |
| 비용 | Picovoice 라이선스 | 무료 (오픈소스) |
| 한국어 | 지원 (커스텀 키워드) | TTS 합성 훈련 |
| 항상 켜짐 | 모니터 의존 | 독립 (ESP32 상시 전원) |
| 정확도 | 높음 (상용) | 높음 (TTS 훈련 한계 있음) |
