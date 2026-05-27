# Codex Swift Plugin

[OpenAI Codex](https://openai.com/codex) plugin that bridges Codex to the Swift toolchain. 17 MCP tools, 6 skills, SourceKit-LSP diagnostics, Xcode Bridge, and automated repair loops.

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

### 17 MCP Tools

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
You edit Swift code
        |
        v
PostToolUse hook fires
        |
        v
swift_diagnostics (SourceKit-LSP, ~1s)
        |
    errors? ----no----> done
        |
       yes
        |
        v
swift_verify (staged: diagnostics -> typecheck -> build -> test)
        |
    fails? ----no----> done
        |
       yes
        |
        v
swift_repair_plan -> swift_repair_next_step
        |
        v
Codex edits code (minimal diff)
        |
        v
Loop back to verify
```

## Project structure

```
.codex-plugin/plugin.json    Plugin manifest
skills/                      6 skill definitions (SKILL.md)
mcp-servers/swift-toolchain/ MCP server (TypeScript, 4191 lines)
hooks/                       SessionStart + PostToolUse hooks
marketplace.json             Marketplace distribution config
AGENTS.md                    Agent instructions
assets/icon.svg              Plugin icon
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
