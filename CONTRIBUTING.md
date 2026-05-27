# Contributing

Contributions are welcome. Here's how to get started.

## Setup

```bash
git clone https://github.com/mameshivaa/codex-swift-plugin.git
cd codex-swift-plugin
npm run build
```

## Development

```bash
# Build the MCP server
npm run build

# Run the integration test (requires a Swift toolchain)
node mcp-servers/swift-toolchain/test/test-all-tools.mjs

# Test hooks manually
echo '{"cwd":"/path/to/swift-project","hook_event_name":"SessionStart"}' | bash hooks/session-start.sh
```

## Adding a new MCP tool

1. Add the tool definition in `mcp-servers/swift-toolchain/src/index.ts`
2. Register it in the `server.tool(...)` section
3. Update `AGENTS.md` with the new tool
4. Update relevant `skills/*/SKILL.md` to reference the tool
5. Add a test case in the test harness
6. Run the full test suite

## Adding a new skill

1. Create `skills/<skill-name>/SKILL.md`
2. Include YAML frontmatter with `name` and `description`
3. List which MCP tools the skill uses
4. Test with Codex to verify trigger matching

## Pull requests

- Keep changes focused. One feature or fix per PR.
- Run `npm run build` and the test suite before submitting.
- Describe what changed and why in the PR body.

## Reporting issues

Open a GitHub issue with:
- Your Swift/Xcode version (`swift --version`, `xcodebuild -version`)
- Your Node.js version (`node --version`)
- Steps to reproduce
- Expected vs actual behavior
