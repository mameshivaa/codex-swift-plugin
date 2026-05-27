import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const hookPath = new URL("../hooks/post-edit-verify.sh", import.meta.url).pathname;
const hasSwift = spawnSync("swift", ["--version"], { encoding: "utf8" }).status === 0;

function runHook(payload, env = {}) {
  return spawnSync("bash", [hookPath], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: {
      ...process.env,
      SWIFT_AGENT_POST_EDIT_VERIFY: "0",
      ...env,
    },
  });
}

test("post-edit hook ignores non-edit tools", () => {
  const result = runHook({
    tool_name: "Read",
    tool_input: { file_path: "Sources/App/App.swift" },
  });

  assert.equal(result.status, 0);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
});

test("post-edit hook reports Swift file edits with a swift_verify tool call", () => {
  const root = mkdtempSync(join(tmpdir(), "swift-agent-hook-"));
  const sourceDir = join(root, "Sources", "App");
  mkdirSync(sourceDir, { recursive: true });
  writeFileSync(join(root, "Package.swift"), 'let package = Package(name: "App")\n');
  const filePath = join(sourceDir, "App.swift");
  writeFileSync(filePath, "struct App {}\n");

  const result = runHook({
    tool_name: "Edit",
    tool_input: { file_path: filePath },
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.match(payload.additionalContext, /Swift post-edit verification/);
  assert.equal(payload.swiftPostEditVerification.projectRoot, root);
  assert.equal(payload.swiftPostEditVerification.projectType, "swiftpm");
  assert.equal(payload.swiftPostEditVerification.autoVerification.ran, false);
  assert.equal(payload.swiftPostEditVerification.recommendedToolCall.tool, "swift_verify");
  assert.equal(payload.swiftPostEditVerification.recommendedToolCall.arguments.includeRepairPlan, true);
  assert.deepEqual(
    payload.swiftPostEditVerification.repairExecutionQueue.map((step) => step.action),
    ["verify"]
  );
  assert.equal(payload.swiftPostEditVerification.repairExecutionQueue[0].runPolicy, "call-tool");
});

test("post-edit hook extracts Swift paths from apply_patch payloads", () => {
  const root = mkdtempSync(join(tmpdir(), "swift-agent-hook-"));
  const sourceDir = join(root, "Sources", "App");
  mkdirSync(sourceDir, { recursive: true });
  writeFileSync(join(root, "Package.swift"), 'let package = Package(name: "App")\n');
  writeFileSync(join(sourceDir, "Patched.swift"), "struct Patched {}\n");

  const result = runHook(
    {
      tool_name: "apply_patch",
      tool_input: {
        patch: "*** Begin Patch\n*** Update File: Sources/App/Patched.swift\n@@\n struct Patched {}\n*** End Patch\n",
      },
    },
    { CWD: root }
  );

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.deepEqual(payload.swiftPostEditVerification.changedSwiftFiles, ["Sources/App/Patched.swift"]);
  assert.equal(payload.swiftPostEditVerification.projectRoot, root);
});

test("post-edit hook returns a repair queue for failing SwiftPM builds", { skip: !hasSwift }, () => {
  const root = mkdtempSync(join(tmpdir(), "swift-agent-hook-"));
  const sourceDir = join(root, "Sources", "BrokenApp");
  mkdirSync(sourceDir, { recursive: true });
  writeFileSync(
    join(root, "Package.swift"),
    `// swift-tools-version: 6.0
import PackageDescription
let package = Package(name: "BrokenApp", products: [.library(name: "BrokenApp", targets: ["BrokenApp"])], targets: [.target(name: "BrokenApp")])
`
  );
  const filePath = join(sourceDir, "BrokenApp.swift");
  writeFileSync(filePath, "public func broken() -> Int { \"not an int\" }\n");

  const result = runHook(
    {
      tool_name: "Edit",
      tool_input: { file_path: filePath },
    },
    {
      SWIFT_AGENT_POST_EDIT_VERIFY: "1",
      SWIFT_AGENT_POST_EDIT_TIMEOUT: "30",
    }
  );

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.swiftPostEditVerification.autoVerification.ran, true);
  assert.equal(payload.swiftPostEditVerification.autoVerification.success, false);
  assert.match(payload.swiftPostEditVerification.autoVerification.command, /swift build --disable-sandbox/);
  assert.deepEqual(
    payload.swiftPostEditVerification.repairExecutionQueue.map((step) => step.action),
    ["inspect", "verify"]
  );
  assert.equal(payload.swiftPostEditVerification.repairExecutionQueue[0].runPolicy, "read-only");
  assert.equal(payload.swiftPostEditVerification.repairExecutionQueue[1].toolCall.tool, "swift_verify");
  assert.equal(payload.swiftPostEditVerification.repairExecutionQueue[1].toolCall.arguments.includeRepairPlan, true);
});
