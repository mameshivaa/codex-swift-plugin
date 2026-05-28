# Changelog

## v0.4.0 (2026-05-27)

### Added
- `swift_behavior_verify` -- regex-based semantic bug detection (24 patterns: empty actions, unused @State, Bool flag clusters, stale async, silent error swallowing, deep nesting)
- `swift_deep_verify` -- architectural pattern detection for media/capture apps (permissions, async state, time-domain, render divergence)
- `swift_intent_check` -- keyword-based intent fulfillment checking (login, CRUD, navigation, settings)
- `swift_runtime_check` -- build, launch on simulator, capture screenshot (tap interaction not yet implemented)
- `swift_preflight` -- deterministic preflight checker for invisible runtime issues (14 Info.plist permission rules, 5 Bundle.module patterns). Returns structured issues with readRanges for LLM context

### Changed
- Renamed project from `codex-swift-plugin` to `swift-agent-toolchain` (agent-neutral)
- Updated all templates and agent instructions for multi-agent support
- Tool count corrected to 21 across all documentation

### Known limitations
- `swift_behavior_verify` uses regex, not SwiftSyntax AST -- false positives on complex code
- `swift_runtime_check` captures screenshots only; tap sequences are accepted but not executed
- `swift_intent_check` is keyword-matching, not LLM-based semantic understanding
- `swift_deep_verify` patterns are AVFoundation/ScreenCaptureKit-specific

## v0.3.0 (2026-05-27)

### Added
- `swift_verify` -- staged verification loop (diagnostics -> typecheck -> build -> test -> simulator)
- `swift_repair_plan` -- generates source-aware repair plan from verification failures
- `swift_repair_next_step` -- selects next step in repair execution queue
- `swift_xcode_info` -- Xcode Bridge (schemes, build settings, signing, destinations)
- SourceKit-LSP direct connection for `swift_diagnostics` (~1.1s incremental)
- `.swift-agent.json` project configuration file support
- `commandExists()` detection for optional tools (swift-format, swiftlint)
- `availableTools` and `installHints` in `swift_project_describe`
- Mixed project guidance (`mixedProjectNote`)
- Actionable `suggestion` field on all 21 tools
- Rate limit detection for Swift Package Index API
- Post-edit verification hook with automatic repair queue generation

### Fixed
- `/private` path normalization in `parseDiagnostics()`
- `session-start.sh` reads `cwd` from stdin JSON (hook spec compliance)
- Removed non-standard fields from `.mcp.json`

## v0.1.0 (2026-05-27)

### Added
- Initial implementation: 13 MCP tools, 6 skills, 2 hooks
- Plugin manifest, marketplace config, icon
