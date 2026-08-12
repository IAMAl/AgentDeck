# AGENTS.md

## 프로젝트 지침 (Antigravity & AI Agents)

이 프로젝트(AgentDeck)에서 작업할 때 모든 AI 에이전트(Claude Code, Codex, OpenCode, Antigravity 포함)는 다음 지침을 **반드시** 따르십시오.

### 0. 지원 에이전트 / Supported agents

이 레포는 Claude Code · Codex · OpenCode · Antigravity 를 오가며 개발합니다. 각 에이전트의 진입 방식, 읽는 파일, 자동 발견 범위, 한계는 **[docs/agent-harness.md](docs/agent-harness.md)** 의 매트릭스가 단일 기준입니다. 핵심:

- **Claude Code / Codex** = 1급 저작 에이전트. 둘 다 hook + skill 자동 발견을 가집니다. Skill 의 정본은 `.agents/skills/<name>/SKILL.md` 이고, `.claude/skills/*.md` 는 그 정본을 가리키는 **얇은 포인터**일 뿐입니다(절차 내용을 복붙/편집하지 마십시오 — drift 방지).
- **OpenCode** = 제품 세션 타입으로는 완전 지원(PTY + SSE)이지만, 이 레포를 *편집하는 개발 도구*로서는 **hook/skill 자동 발견이 없습니다.** `AGENTS.md` → `CLAUDE.md` 를 읽되, 절차가 필요하면 `.agents/workflows/<name>.md` 경로를 직접 지정해서 사용하십시오.
- **Antigravity** = 지시 파일(`AGENTS.md` → `CLAUDE.md`)만 읽습니다. 세션 관측·hook·skill 자동 발견이 **없으며**, Apple 앱은 Antigravity 의 사용량/크레딧 통계만 읽을 뿐 코딩 세션을 관측하지 않습니다. skill 자동 실행을 기대하지 말고 워크플로우 파일 경로를 직접 인용하십시오.

### 1. 컨텍스트 및 아키텍처 파악 (필수)
- 모든 작업(특히 새로운 기능 추가, 구조 변경, 디버깅) 시작 전에 **반드시 `CLAUDE.md`를 먼저 읽으십시오.**
- `DEVELOPMENT_LOG.md`는 전체 파일을 매번 통독하지 마십시오. 이 파일은 **최근 2개월분만** 유지하고, 그 이전 기록은 월별로 `docs/devlog/<YYYY-MM>.md` 에 아카이브되어 있습니다(인덱스: `docs/devlog/README.md`). 먼저 최신 항목(파일 상단 일부)을 확인한 뒤, 작업 대상 키워드/파일명으로 `rg` 검색하되 더 오래된 기록이 필요하면 **해당 월 아카이브 파일만** 검색하십시오(아카이브 전체를 한꺼번에 로드하지 말 것). 예: `rg -n "Codex|hooks|config.toml" DEVELOPMENT_LOG.md docs/devlog/2026-04.md`.
- `CLAUDE.md`는 프로젝트 아키텍처, 브릿지-플러그인 통신 규약, 포트 설정, UI/UX 비전(특히 Android E-ink 최적화 규칙)을 담고 있는 **단일 진실 공급원(SSOT)**입니다.
- 정보를 여러 문서로 분산시키지 마십시오. 만약 프로젝트의 핵심 구조적 변경이 발생하면, 이 정보들을 `CLAUDE.md`나 `DEVELOPMENT_LOG.md`에 업데이트하여 최신 상태로 유지해야 합니다.

### 2. 워크플로우 자동화 활용
- 빌드, 환경 설정 등의 반복 작업은 직접 스크립트 명령어를 유추해서 실행하지 말고, `.agents/workflows/` 디렉토리에 정의된 워크플로우를 사용하십시오.
  - 예: 안드로이드 APK 빌드 (`build-android.md`), 터미널 환경 세션 시작 등
- `.agents/skills/`의 repo-scoped skills 가 절차의 **정본**입니다. workflow 파일은 사람이 읽는 원본 절차이고, skill 은 자동 발견/호출을 위한 실행 표면입니다. Codex 는 `.agents/skills/` 를 자동 발견하고, Claude Code 는 `.claude/skills/` 의 포인터를 통해 같은 정본에 도달합니다.
- 세션 인계: `/clear`·`/new`·작업 전환·다른 에이전트로 넘기기 전에 `session-end` skill 을 실행하십시오.

### 3. 주요 개발 원칙 요약
- **Monorepo**: 프로젝트는 `pnpm workspaces` 기반으로 구성되어 있습니다. 항상 적절한 패키지(`bridge`, `plugin`, `shared`, `android` 등) 디렉토리를 확인하고 작업하세요.
- **Hook 포맷 (CRITICAL)**: Claude Code v2.1+ hook 은 3단계 중첩 포맷이 필수이며 구 flat 포맷은 조용히 실패합니다. Codex 는 `~/.codex/config.toml` lifecycle hook 을 씁니다. 자세한 규칙·자동 마이그레이션은 `CLAUDE.md` "Key Conventions" 의 Hook format 항목 참조(여기서 복제하지 말 것).
- **Android / E-ink UX**: 안드로이드 환경(Jetpack Compose) 수정 시 E-ink 디스플레이(Crema/Onyx) 특성을 매우 엄격하게 고려해야 합니다. (그레이스케일 디더링, 하드웨어 부분 새로고침 등 `CLAUDE.md`에 명시된 규칙 준수)
- **명령어 안전성**: 데몬 스크립트나 시스템 환경에 영향을 주는 코드를 테스트할 때는 신중히 접근하십시오.

### 4. App Store 심사 invariants (필수)
macOS 앱은 App Store 로 배포되며 Apple Review Guidelines 2.5.2 / 4.2 / 4.2.3 을 모든 변경에서 유지해야 합니다. **정본은 `CLAUDE.md` 의 "App Store build invariants" 섹션과 `apple/APP_REVIEW_NOTES.md` 이며, 규칙을 여기서 확장하지 말고 그쪽에 추가하십시오.** 하드 룰 요약:

- subprocess 경로(`Process()`/`/bin/sh`/`osascript`/`.command` 생성/외부 CLI 호출) 를 `#if !AGENTDECK_APP_STORE` 뒤에도 **재도입 금지**.
- App Store UI 문구는 companion executable 설치/기동을 **유도 금지**(외부 도구 존재 여부와 무관하게 동일 문구).
- 기능 추가/이동 시 `docs/appstore-feature-matrix.md` 표에 **행을 먼저 추가**한 뒤 구현.
- 제출 전 `bash apple/scripts/verify-appstore-archive.sh <.app>` 를 **Release 빌드로 통과**시킨 뒤 커밋(Debug 실패는 정상).
