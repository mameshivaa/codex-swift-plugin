# Changelog

## v0.3.0 (2026-05-27)

### Added
- `swift_verify` -- staged verification loop (diagnostics -> typecheck -> build -> test -> simulator)
- `swift_repair_plan` -- generates source-aware repair plan from verification failures
- `swift_repair_next_step` -- selects next step in repair execution queue
- `swift_xcode_info` -- Xcode Bridge (schemes, build settings, signing, destinations)
- SourceKit-LSP direct connection for `swift_diagnostics` (~1.1s incremental)
- `.codex-swift.json` project configuration file support
- `commandExists()` detection for optional tools (swift-format, swiftlint)
- `availableTools` and `installHints` in `swift_project_describe`
- Mixed project guidance (`mixedProjectNote`)
- Actionable `suggestion` field on all 17 tools
- Rate limit detection for Swift Package Index API
- Post-edit verification hook with automatic repair queue generation

### Fixed
- `/private` path normalization in `parseDiagnostics()`
- `session-start.sh` reads `cwd` from stdin JSON (Codex hook spec compliance)
- Removed non-standard fields from `.mcp.json`

## v0.1.0 (2026-05-27)

### Added
- Initial implementation: 13 MCP tools, 6 skills, 2 hooks
- Plugin manifest, marketplace config, icon
