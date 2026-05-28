# Swift Agent Toolchain

MCP toolchain that connects AI coding agents to the Swift development ecosystem. 22 MCP tools, 6 skills. Targets the bugs that AI-generated Swift code actually produces — especially the ones the compiler doesn't catch: missing Info.plist permissions, Bundle.module misuse, empty UI actions, async state corruption, and incomplete feature implementation.

Works with **Claude Code**, **Codex**, **Cursor**, and **GitHub Copilot**.

> **Status: prototype (v0.4.0).** Verification tools use regex pattern matching, not SwiftSyntax AST. Expect false positives. Runtime check captures screenshots but does not execute tap sequences. See [Maturity](#maturity) for details.

## Install

### Option A: Clone into your project

```bash
git clone https://github.com/mameshivaa/swift-agent-toolchain.git .agents/plugins/swift-agent
cd .agents/plugins/swift-agent && npm run build
```

### Option B: Git submodule

```bash
git submodule add https://github.com/mameshivaa/swift-agent-toolchain.git .agents/plugins/swift-agent
cd .agents/plugins/swift-agent && npm run build
```

### Option C: Global install

```bash
git clone https://github.com/mameshivaa/swift-agent-toolchain.git ~/.agents/plugins/swift-agent
cd ~/.agents/plugins/swift-agent && npm run build
```

### Prerequisites

| Required | Optional |
|----------|----------|
| Node.js 18+ | [SwiftLint](https://github.com/realm/SwiftLint) |
| Xcode + Command Line Tools | [swift-format](https://github.com/swiftlang/swift-format) |
| Swift 5.9+ toolchain | |

## Example session

A realistic flow: AI generates a camera-based profile screen. The toolchain catches what the compiler misses — including invisible runtime crashes.

```
User: "build a profile screen with camera avatar upload"

─── Agent generates ProfileView.swift ───

> swift_preflight(path: ".")
  ✗ 3 issues — will crash at runtime but compiler won't warn:
    [MISSING_PERMISSION] Sources/ProfileView.swift:5
      AVCaptureSession used but NSCameraUsageDescription missing from Info.plist
      → Fix: add <key>NSCameraUsageDescription</key> to Info.plist
    [MISSING_PERMISSION] Sources/ProfileView.swift:18
      PHPhotoLibrary used but NSPhotoLibraryUsageDescription missing
      → Fix: add <key>NSPhotoLibraryUsageDescription</key> to Info.plist
    [BUNDLE_MISUSE] Sources/ProfileView.swift:12
      Image("avatar") without bundle: parameter — will return nil in SPM packages
      → Fix: change to Image("avatar", bundle: .module)
  readRanges: [{file: "Sources/ProfileView.swift", lines: 1-20}, {file: "Info.plist", lines: 1-50}]

─── Agent adds Info.plist keys and fixes Bundle.module ───

> swift_diagnostics(files: ["ProfileView.swift"])
  ✓ No compile errors (SourceKit-LSP, 0.9s)

> swift_behavior_verify(files: ["ProfileView.swift"])
  ✗ 1 issue:
    [EMPTY_ACTION] Line 24: Button("Take Photo") { } — action body is empty

─── Agent adds camera capture logic in button action ───

> swift_runtime_check(path: ".", scheme: "MyApp")
  ✓ Built and launched on iPhone 16 Pro simulator
  ✓ Screenshot saved — profile form visible, avatar placeholder rendered
```

**The key difference:** Without `swift_preflight`, the code compiles cleanly but crashes on first camera access. The compiler sees nothing wrong. The preflight catches it before you waste a build-test-debug cycle.

**What this doesn't do yet:** `swift_runtime_check` captures screenshots but cannot tap buttons. `swift_intent_check` matches keywords, not semantic meaning. See [Maturity](#maturity).

## What's inside

### 22 MCP Tools

**Preflight — catches what the compiler misses (deterministic):**

| Tool | What it does |
|------|-------------|
| `swift_preflight` | **Detect invisible runtime issues** — missing Info.plist permission keys, Bundle.module misuse in SPM packages. Returns exact file/line/fix instructions + readRanges for the LLM. Zero false positives for known patterns. Run BEFORE building. |

**Core build/diagnose (battle-tested):**

| Tool | What it does |
|------|-------------|
| `swift_project_describe` | Detect project type, targets, schemes, available tools |
| `swift_diagnostics` | SourceKit-LSP diagnostics (~1s) with build fallback |
| `swift_build` | Incremental build with `stopAfter: typecheck` support |
| `swift_test` | Run tests with filtering |
| `swift_verify` | Staged verification loop (diagnostics → typecheck → build → test) |
| `swift_repair_plan` | Generate source-aware repair plan from failures |
| `swift_repair_next_step` | Step through repair execution queue |
| `swift_xcode_info` | Xcode Bridge — schemes, build settings, signing, destinations |

**Code quality:**

| Tool | What it does |
|------|-------------|
| `swift_format` | Format with swift-format |
| `swift_lint` | Lint with SwiftLint |
| `swift_symbol_search` | Find symbols across the codebase |

**Dependencies and preview:**

| Tool | What it does |
|------|-------------|
| `swift_preview` | Detect and generate SwiftUI `#Preview` blocks |
| `swift_package_search` | Search Swift Package Index |
| `swift_package_resolve` | Resolve package dependencies |

**Devices and simulators:**

| Tool | What it does |
|------|-------------|
| `swift_simulator_list` | List available simulators |
| `swift_simulator_run` | Build and run on simulator |
| `swift_device_list` | List connected devices |

**Verification (experimental, regex-based):**

| Tool | What it does | Limitation |
|------|-------------|------------|
| `swift_behavior_verify` | 24-pattern check: empty actions, unused state, Bool clusters, stale async, silent errors | Regex, not AST — false positives on complex expressions |
| `swift_deep_verify` | Architectural checks for AVFoundation/ScreenCaptureKit apps | Domain-specific; only useful for media/capture projects |
| `swift_runtime_check` | Build, launch on simulator, capture screenshot | Screenshot only — does not execute tap sequences |
| `swift_intent_check` | Check if code matches stated intent | Keyword matching, not semantic understanding |

### 6 Skills

| Skill | Trigger |
|-------|---------|
| **swift-explore** | "prototype this", "build a view", "try this out" |
| **swift-fix** | "fix errors", "won't compile", "build failed" |
| **swift-preview** | "preview", "show me what it looks like" |
| **swift-review** | "review this code", "PR review" |
| **swift-test** | "write tests", "add coverage", "run tests" |
| **swift-package** | "find a package", "add dependency" |

### 2 Lifecycle Hooks

- **SessionStart** — Auto-detects Swift projects and injects context
- **PostToolUse** — Triggers verification after `.swift` file edits (SwiftPM only; Xcode projects fall back to `swift_verify`)

## How it works

```
User: "build me a login screen"
              |
              v
    AI generates Swift code
              |
              v
  0. swift_preflight ------- invisible runtime issues?  ← NEW: runs BEFORE build
              |
         missing plist keys? --yes--> add Info.plist entries --> continue
         Bundle.module issue? -yes--> fix bundle refs --> continue
              |
              v
  1. swift_diagnostics ---- does it compile?
              |
         compile error? --yes--> swift_repair_plan --> fix --> loop
              |
              no
              v
  2. swift_behavior_verify - does it have obvious bugs? (regex-based)
              |
         empty actions?  --yes--> fix empty closures --> loop
         broken nav?
         unused state?
              |
              no
              v
  3. swift_intent_check --- does it have the right keywords? (not semantic)
              |
         missing pieces?  --yes--> implement missing features --> loop
              |
              no
              v
  4. swift_runtime_check -- does it render? (screenshot only)
              |
              v
         screenshot from simulator
              |
         blank screen?   --yes--> fix rendering --> loop
              |
              no
              v
           Done — preflight clean, compiles, passes pattern checks, renders.
           Manual testing still required for interactive behavior.
```

## Maturity

| Component | Status | What works | What doesn't yet |
|-----------|--------|------------|------------------|
| `swift_preflight` | **Solid** | 14 permission rules (camera, location, contacts, etc.), 5 Bundle.module patterns. Deterministic, zero false positives for known patterns. Returns readRanges per issue. | Only checks Info.plist XML format, not entitlements files. Doesn't detect all possible API patterns. |
| SourceKit-LSP diagnostics | **Solid** | ~1s incremental diagnostics, build fallback | stderr suppressed — LSP failures appear as "no diagnostics" |
| Build/test/verify loop | **Solid** | Staged verification, repair queue, stall detection | — |
| Repair execution queue | **Solid** | Failure fingerprinting, loop detection, escalation | — |
| Xcode Bridge | **Usable** | Schemes, build settings, signing, destinations | No workspace-level resolution |
| `swift_behavior_verify` | **Prototype** | Catches empty actions, unused state, common patterns | Regex-based; no type resolution; `.toggle()` false positive on multi-@State files |
| `swift_deep_verify` | **Prototype** | AVFoundation/ScreenCaptureKit pattern detection | Domain-specific only; regex-based |
| `swift_intent_check` | **Prototype** | Keyword-category matching (login, CRUD, navigation) | Not semantic; over-prescriptive (e.g., requires persistence for all login flows) |
| `swift_runtime_check` | **Prototype** | Build + launch + screenshot on simulator | No tap execution; no screenshot comparison; no accessibility inspection |
| Post-edit hook | **Usable** | Auto-verifies SwiftPM projects after edits | Xcode projects get "use swift_verify" message only |

## Setup for AI agents

Run one command to configure all major AI coding agents:

```bash
bash .agents/plugins/swift-agent/scripts/setup-project.sh
```

This creates instruction files that tell each agent to prefer the MCP tools over raw shell commands:

| File | Agent |
|------|-------|
| `CLAUDE.md` | Claude Code |
| `.codex/instructions.md` | Codex |
| `.cursorrules` | Cursor |
| `.github/copilot-instructions.md` | GitHub Copilot |
| `.swift-agent.json` | Plugin config |

> **Note:** Existing files are skipped, not overwritten. No backup or dry-run mode yet.

## Configuration

Create `.swift-agent.json` in your project root:

```json
{
  "defaultScheme": "MyApp",
  "excludePaths": ["DerivedData", ".build"],
  "timeouts": {
    "build": 180000,
    "test": 120000
  },
  "postEditVerify": true,
  "postEditVerifyTimeoutSeconds": 25
}
```

## Project structure

```
.codex-plugin/plugin.json    Plugin manifest
skills/                      6 skill definitions (SKILL.md)
mcp-servers/swift-toolchain/ MCP server (TypeScript)
hooks/                       SessionStart + PostToolUse hooks
templates/                   Agent instruction templates
scripts/setup-project.sh     One-command project setup for all AI agents
marketplace.json             Marketplace distribution config
AGENTS.md                    Agent instructions
assets/icon.svg              Plugin icon
```

## What's strong

- **Repair execution queue**: Failure fingerprinting, loop/stall detection, escalation — addresses the real problem of AI agents repeating the same failed fix.
- **SourceKit-LSP integration**: Direct LSP connection for sub-second diagnostics instead of full builds.
- **Multi-agent support**: Same toolchain works across Claude Code, Codex, Cursor, Copilot via per-agent instruction templates.
- **Post-edit verification hook**: Automatic build-after-edit catches regressions immediately.

## What needs work

- Verification tools need SwiftSyntax AST instead of regex for production use.
- Runtime check needs XCTest UI test generation or accessibility-based tap execution.
- Intent check should delegate to the calling LLM rather than keyword matching.
- Xcode project support (non-SwiftPM) is thin — post-edit hook doesn't auto-verify.
- No CI integration or automated test suite for the toolchain itself.
- `setup-project.sh` needs `--dry-run`, `--backup`, and append-mode for existing files.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
