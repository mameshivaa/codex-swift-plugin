# Codex Swift Plugin

You have access to the `swift-toolchain` MCP server with 17 specialized Swift development tools. **Use these tools instead of raw shell commands** whenever you work on Swift code. They are faster, safer, and produce structured output you can act on directly.

## When to use this plugin

Use the swift-toolchain tools whenever you:
- Edit, create, or review `.swift` files
- Need to build, test, or diagnose a Swift/SwiftPM/Xcode project
- Search for Swift symbols or packages
- Work with SwiftUI Previews or simulators
- Fix compile errors or type-checker failures

## Tool selection guide

**Diagnosing problems** -- start here, not with `swift build` in a shell:
- `swift_diagnostics` -- SourceKit-LSP diagnostics in ~1s. Pass specific file paths for LSP mode. Pass empty array for full-project build-based diagnostics.
- `swift_behavior_verify` -- **catches bugs the compiler misses** (24 patterns): empty button actions, unused @State, missing @Published, broken navigation, placeholder data, deprecated patterns, Bool flag clusters (impossible states), String-as-enum, stale async without cancellation, @StateObject misuse, singleton ObservableObject, silent error swallowing (try?/guard-return), deeply nested View bodies. Run this after every code generation.
- `swift_deep_verify` -- **catches architectural bugs in media/capture/recording apps**: missing permission checks (ScreenCaptureKit, camera, accessibility), async state machine errors (finishWriting sync, state mutation off main thread, leaked streams), time-domain mistakes (Double for media time, mixed CMTime timescales, wall-clock sync), preview/export render divergence, and implicit assumptions (hardcoded track index, fps, screen order). **Run this on any project using AVFoundation, ScreenCaptureKit, CoreMedia, or real-time capture.**
- `swift_intent_check` -- **verifies code fulfills the user's request**: pass the user's intent in natural language, get back a checklist of missing features. Catches "compiles but doesn't do what was asked" problems.
- `swift_verify` -- staged verification (diagnostics -> typecheck -> build -> test). Use after edits to confirm correctness at every level.

**Visual verification:**
- `swift_runtime_check` -- build, launch on simulator, capture screenshot. Use to verify the app actually looks correct, not just that it compiles.

**Fixing problems:**
- `swift_repair_plan` -- feed a failed `swift_verify` result to get a source-aware repair plan with an execution queue.
- `swift_repair_next_step` -- step through the repair queue (inspect -> edit -> verify -> escalate).

**Building and testing:**
- `swift_build` -- incremental build. Use `stopAfter: "typecheck"` for fast cross-file type checking without full compilation.
- `swift_test` -- run tests with optional filter. Prefer this over `swift test` in shell because it returns structured pass/fail data.

**Code quality:**
- `swift_format` -- format with swift-format. Run on changed files after edits.
- `swift_lint` -- lint with SwiftLint. Run on changed files before committing.
- `swift_symbol_search` -- find type/func/var/protocol/enum definitions.

**Project understanding:**
- `swift_project_describe` -- call this first when entering a new project. Returns project type, targets, schemes, available tools, and config.
- `swift_xcode_info` -- Xcode schemes, build settings, signing identity, available destinations. Essential for iOS/macOS app projects.

**Dependencies:**
- `swift_package_search` -- search Swift Package Index. Better than guessing package names.
- `swift_package_resolve` -- resolve and verify dependencies after editing Package.swift.

**Preview and devices:**
- `swift_preview` -- detect and generate SwiftUI `#Preview` blocks.
- `swift_simulator_list` / `swift_simulator_run` -- list and run on simulators.
- `swift_device_list` -- list connected physical devices.

## Verification order (fastest feedback first)

After every Swift file edit, run this triple-check. **All three are required** — code that passes step 1 often fails step 2 or 3:

1. `swift_diagnostics` with specific files (SourceKit-LSP, ~1s) — **does it compile?**
2. `swift_behavior_verify` on changed files — **does it actually work?** (empty actions, broken navigation, unused state)
3. `swift_intent_check` with the user's request — **does it do what was asked?**

Then, as needed:
4. `swift_build` with `stopAfter: "typecheck"` (cross-file, ~seconds)
5. `swift_build` (full compile)
6. `swift_test` (runtime correctness)
7. `swift_runtime_check` (visual verification via simulator screenshot)

Or use `swift_verify` which runs the build cascade automatically and returns a repair plan on failure.

## Rules

- **Never run raw `swift build` or `swift test` in a shell** when these MCP tools are available.
- **Always call `swift_project_describe` first** when you enter an unfamiliar Swift project.
- **Use `swift_diagnostics` for the edit-verify loop**, not full builds.
- **Always run `swift_behavior_verify` after generating code** — compiling is not enough. Empty button actions, EmptyView destinations, and .constant() bindings are the most common vibe-coding failures.
- **Run `swift_deep_verify` on media/recording/capture projects** — permission checks, async state machines, time-domain arithmetic, and render path consistency are where AVFoundation apps silently break.
- **Always run `swift_intent_check` before presenting results** — verify the code actually fulfills the user's request. Don't deliver code that compiles but is missing features the user asked for.
- **Follow the repair queue** when `swift_verify` fails.
- **Run `swift_format` and `swift_lint` on changed files** before presenting results.
- **Use `swift_runtime_check`** when the user asks to see the app or when you need to verify visual layout.
