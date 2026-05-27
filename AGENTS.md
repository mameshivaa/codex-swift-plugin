# Codex Swift Plugin

This is an OpenAI Codex plugin that bridges Codex to the Swift toolchain.

## Available Skills

- **swift-explore** — Rapid prototyping with incremental verification (Preview/Playground)
- **swift-fix** — Fix compile errors with minimal changes, guided by SourceKit diagnostics
- **swift-preview** — Generate and manage SwiftUI #Preview blocks
- **swift-review** — Swift-specific code review (concurrency, retain cycles, availability)
- **swift-test** — Generate and run tests using Swift Testing (@Test macro)
- **swift-package** — Search Swift Package Index and manage dependencies

## MCP Tools

The `swift-toolchain` MCP server (v0.3.0) exposes 17 tools:

| Tool | Purpose |
|------|---------|
| `swift_project_describe` | Detect project type, targets, schemes, tool availability |
| `swift_symbol_search` | Find symbols across the codebase |
| `swift_diagnostics` | Get diagnostics via SourceKit-LSP (~1s) or build fallback |
| `swift_build` | Incremental build with stopAfter support |
| `swift_test` | Run tests with filtering |
| `swift_format` | Format with swift-format |
| `swift_lint` | Lint with SwiftLint |
| `swift_preview` | Check/generate #Preview blocks |
| `swift_package_search` | Search Swift Package Index |
| `swift_package_resolve` | Resolve package dependencies |
| `swift_simulator_list` | List available simulators |
| `swift_simulator_run` | Build and run on simulator |
| `swift_device_list` | List connected devices |
| `swift_xcode_info` | Xcode project details, schemes, signing, destinations |
| `swift_verify` | Run staged build/test/simulator verification with repair queue output |
| `swift_repair_plan` | Convert a failed `swift_verify` result into a source-aware repair plan |
| `swift_repair_next_step` | Select the next queue step for inspect/edit/verify/escalate repair loops |

## Verification Order

When editing Swift files, verify in this order for fastest feedback:
1. `swift_diagnostics` with specific files (SourceKit-LSP, ~1s)
2. `swift_build --stop-after typecheck` (cross-file, ~seconds)
3. `swift_build` (full compile, ~10s+)
4. `swift_test` (runtime correctness)
5. `swift_preview` / simulator (visual/runtime)

## Configuration

Create `.codex-swift.json` in the project root for project-specific settings:

```json
{
  "defaultScheme": "MyApp",
  "excludePaths": ["DerivedData", ".build"],
  "timeouts": {
    "build": 180000,
    "test": 120000
  }
}
```
