# Codex Swift Plugin

[OpenAI Codex](https://openai.com/codex) plugin that makes Swift vibe-coding actually work. 21 MCP tools, 6 skills. Goes beyond "does it compile" to catch the bugs that actually matter: empty UI actions, missing permissions, async state corruption, time-domain drift, render path divergence, and incomplete feature implementation.

## Install

### Option A: One command (recommended)

```bash
codex plugin marketplace add https://github.com/mameshivaa/codex-swift-plugin
```

### Option B: Clone into your project

```bash
# Per-project
git clone https://github.com/mameshivaa/codex-swift-plugin.git .agents/plugins/codex-swift
cd .agents/plugins/codex-swift && npm run build

# Or globally (all projects)
git clone https://github.com/mameshivaa/codex-swift-plugin.git ~/.agents/plugins/codex-swift
cd ~/.agents/plugins/codex-swift && npm run build
```

### Option C: Git submodule

```bash
git submodule add https://github.com/mameshivaa/codex-swift-plugin.git .agents/plugins/codex-swift
cd .agents/plugins/codex-swift && npm run build
```

### Prerequisites

| Required | Optional |
|----------|----------|
| Node.js 18+ | [SwiftLint](https://github.com/realm/SwiftLint) |
| Xcode + Command Line Tools | [swift-format](https://github.com/swiftlang/swift-format) |
| Swift 5.9+ toolchain | |

## Verify installation

Open a Swift project and start Codex. You should see:

```
Detecting Swift project...
Swift project detected: **YourApp** (SwiftPM)
```

Run any skill with `@codex-swift` or let Codex pick automatically:

```
Fix all compile errors in this project
```

## What's inside

### 21 MCP Tools

| Tool | What it does |
|------|-------------|
| `swift_project_describe` | Detect project type, targets, schemes, available tools |
| `swift_symbol_search` | Find symbols across the codebase |
| `swift_diagnostics` | **SourceKit-LSP diagnostics** (~1s) with build fallback |
| `swift_build` | Incremental build with `stopAfter: typecheck` support |
| `swift_test` | Run tests with filtering |
| `swift_format` | Format with swift-format |
| `swift_lint` | Lint with SwiftLint |
| `swift_preview` | Detect and generate SwiftUI `#Preview` blocks |
| `swift_package_search` | Search Swift Package Index |
| `swift_package_resolve` | Resolve package dependencies |
| `swift_simulator_list` | List available simulators |
| `swift_simulator_run` | Build and run on simulator |
| `swift_device_list` | List connected devices |
| `swift_xcode_info` | **Xcode Bridge** -- schemes, build settings, signing, destinations |
| `swift_verify` | Staged verification loop (diagnostics -> typecheck -> build -> test) |
| `swift_repair_plan` | Generate source-aware repair plan from failures |
| `swift_repair_next_step` | Select next step in repair execution queue |
| `swift_behavior_verify` | **Semantic bug detection** -- empty actions, unused state, broken navigation, placeholder data |
| `swift_deep_verify` | **Architectural bug detection** -- permissions, async state, time-domain, render divergence, implicit assumptions |
| `swift_runtime_check` | **Visual verification** -- build, launch on simulator, capture screenshot |
| `swift_intent_check` | **Intent fulfillment** -- verify code does what the user actually asked for |

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

- **SessionStart** -- Auto-detects Swift projects and injects context
- **PostToolUse** -- Triggers verification after `.swift` file edits

## Configuration

Create `.codex-swift.json` in your project root:

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

## How it works

```
User: "build me a login screen"
              |
              v
    AI generates Swift code
              |
              v
  1. swift_diagnostics ---- does it compile?
              |
         compile error? --yes--> swift_repair_plan --> fix --> loop
              |
              no
              v
  2. swift_behavior_verify - does it actually work?
              |
         empty actions?  --yes--> fix empty closures --> loop
         broken nav?
         unused state?
              |
              no
              v
  3. swift_intent_check --- does it do what was asked?
              |
         missing auth?   --yes--> implement missing features --> loop
         no error handling?
         no data persistence?
              |
              no
              v
  4. swift_runtime_check -- does it look right?
              |
              v
         screenshot from simulator
              |
         blank screen?   --yes--> fix rendering --> loop
              |
              no
              v
           Done. Working app.
```

## Setup for AI agents

Run one command in your Swift project to configure all major AI coding agents (Claude Code, Codex, Cursor, GitHub Copilot) to use the codex-swift tools:

```bash
bash .agents/plugins/codex-swift/scripts/setup-project.sh
# or if installed globally:
bash ~/.agents/plugins/codex-swift/scripts/setup-project.sh /path/to/your/project
```

This creates:

| File | Agent |
|------|-------|
| `CLAUDE.md` | Claude Code |
| `.codex/instructions.md` | Codex |
| `.cursorrules` | Cursor |
| `.github/copilot-instructions.md` | GitHub Copilot |
| `.codex-swift.json` | Plugin config |

Each file tells the respective agent to prefer the codex-swift MCP tools over raw shell commands for Swift development.

You can also copy individual template files from `templates/` manually.

## Project structure

```
.codex-plugin/plugin.json    Plugin manifest
skills/                      6 skill definitions (SKILL.md)
mcp-servers/swift-toolchain/ MCP server (TypeScript, 4191 lines)
hooks/                       SessionStart + PostToolUse hooks
templates/                   Agent instruction templates (CLAUDE.md, .cursorrules, etc.)
scripts/setup-project.sh     One-command project setup for all AI agents
marketplace.json             Marketplace distribution config
AGENTS.md                    Agent instructions (read by Codex and other agents)
assets/icon.svg              Plugin icon
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
