import assert from "node:assert/strict";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverPath = resolve(__dirname, "../dist/index.js");
const goodFixturePath = resolve(__dirname, "fixtures/swiftpm-good");
const buildFailFixturePath = resolve(__dirname, "fixtures/swiftpm-build-fail");
const testFailFixturePath = resolve(__dirname, "fixtures/swiftpm-test-fail");
const noTestsFixturePath = resolve(__dirname, "fixtures/swiftpm-no-tests");

function startServer() {
  const proc = spawn(process.execPath, [serverPath], {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      HOME: process.env.SWIFT_AGENT_TEST_HOME ?? "/private/tmp/swift-agent-home",
      CLANG_MODULE_CACHE_PATH: process.env.SWIFT_AGENT_CLANG_CACHE ?? "/private/tmp/swift-agent-clang-cache",
    },
  });

  let buffer = "";
  const responses = [];
  proc.stdout.setEncoding("utf-8");
  proc.stdout.on("data", (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) responses.push(JSON.parse(line));
    }
  });

  return { proc, responses };
}

async function waitForResponse(responses, id, timeoutMs = 120_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const found = responses.find((response) => response.id === id);
    if (found) return found;
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  throw new Error(`Timed out waiting for JSON-RPC response id=${id}`);
}

function send(proc, message) {
  proc.stdin.write(`${JSON.stringify(message)}\n`);
}

async function withServer(run) {
  const { proc, responses } = startServer();
  const stderr = [];
  proc.stderr.setEncoding("utf-8");
  proc.stderr.on("data", (chunk) => stderr.push(chunk));

  try {
    send(proc, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "swiftpm-e2e", version: "0.1.0" },
      },
    });
    await waitForResponse(responses, 1);
    send(proc, { jsonrpc: "2.0", method: "notifications/initialized", params: {} });
    return await run({ proc, responses, stderr });
  } finally {
    proc.kill("SIGTERM");
    await Promise.race([
      once(proc, "exit"),
      new Promise((resolveWait) => setTimeout(resolveWait, 1000)),
    ]);
  }
}

async function callTool(proc, responses, id, name, args) {
  send(proc, {
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: {
      name,
      arguments: args,
    },
  });
  return waitForResponse(responses, id);
}

function assertIsoTimestamp(value, payload) {
  assert.equal(typeof value, "string", JSON.stringify(payload, null, 2));
  assert.equal(Number.isNaN(Date.parse(value)), false, JSON.stringify(payload, null, 2));
}

function findArtifact(step, kind) {
  return step.artifacts?.find((artifact) => artifact.kind === kind);
}

test("swift_verify passes build and test levels against a real SwiftPM fixture", async () => {
  await withServer(async ({ proc, responses, stderr }) => {
    const response = await callTool(proc, responses, 2, "swift_verify", {
      path: goodFixturePath,
      level: "test",
    });
    assert.equal(response.error, undefined, stderr.join(""));

    const payload = JSON.parse(response.result.content[0].text);
    assert.equal(payload.success, true, JSON.stringify(payload, null, 2));
    assert.equal(payload.schemaVersion, "swift-verify/v1");
    assert.equal(payload.capabilities.includes("structuredSteps"), true);
    assert.equal(payload.capabilities.includes("stepCommands"), true);
    assert.equal(payload.capabilities.includes("failureFocus"), true);
    assert.equal(payload.capabilities.includes("summary"), true);
    assert.equal(payload.capabilities.includes("timestamps"), true);
    assert.equal(payload.capabilities.includes("artifacts"), true);
    assert.equal(payload.capabilities.includes("loopTrace"), true);
    assert.equal(payload.capabilities.includes("strategyHints"), true);
    assert.equal(payload.capabilities.includes("inspectionOrder"), true);
    assert.equal(payload.capabilities.includes("nextInspectionActions"), true);
    assert.equal(payload.capabilities.includes("repairHypotheses"), true);
    assert.equal(payload.capabilities.includes("selectedHypothesis"), true);
    assert.equal(payload.capabilities.includes("editGuardrails"), true);
    assert.equal(payload.capabilities.includes("postEditVerification"), true);
    assert.equal(payload.capabilities.includes("repairLoopState"), true);
    assert.equal(payload.capabilities.includes("repairExecutionQueue"), true);
    assert.equal(payload.capabilities.includes("repairExecutionPolicies"), true);
    assert.equal(payload.capabilities.includes("repairNextStep"), true);
    assertIsoTimestamp(payload.startedAt, payload);
    assertIsoTimestamp(payload.endedAt, payload);
    assert.equal(payload.level, "test");
    assert.deepEqual(payload.steps.map((step) => step.phase), ["build", "test"]);
    assert.equal(payload.summary.success, true, JSON.stringify(payload, null, 2));
    assert.equal(payload.summary.totalSteps, 2);
    assert.deepEqual(payload.summary.completedPhases, ["build", "test"]);
    assert.equal(payload.summary.failedStepIndex, undefined);
    assert.equal(payload.summary.slowestStep.durationMs >= 0, true, JSON.stringify(payload, null, 2));
    assert.equal(payload.summary.totalStepDurationMs >= payload.steps[0].durationMs, true, JSON.stringify(payload, null, 2));
    assert.equal(payload.steps[0].success, true);
    assert.equal(payload.steps[0].exitCode, 0);
    assert.equal(Number.isInteger(payload.steps[0].durationMs), true, JSON.stringify(payload, null, 2));
    assert.equal(payload.steps[0].durationMs >= 0, true, JSON.stringify(payload, null, 2));
    assertIsoTimestamp(payload.steps[0].startedAt, payload);
    assertIsoTimestamp(payload.steps[0].endedAt, payload);
    assert.deepEqual(payload.steps[0].artifacts, []);
    assert.deepEqual(payload.steps[0].command, {
      executable: "swift",
      args: ["build"],
      cwd: goodFixturePath,
      timeoutMs: 300000,
    });
    assert.equal(payload.steps[1].success, true);
    assert.equal(payload.steps[1].exitCode, 0);
    assert.equal(Number.isInteger(payload.steps[1].durationMs), true, JSON.stringify(payload, null, 2));
    assert.equal(payload.steps[1].durationMs >= 0, true, JSON.stringify(payload, null, 2));
    assertIsoTimestamp(payload.steps[1].startedAt, payload);
    assertIsoTimestamp(payload.steps[1].endedAt, payload);
    assert.equal(payload.steps[1].passed >= 1, true);
    assert.deepEqual(findArtifact(payload.steps[1], "command-output"), {
      kind: "command-output",
      label: "Test output",
      storage: "inline",
      contentKey: "output",
      mediaType: "text/plain",
    });
    assert.deepEqual(payload.steps[1].command, {
      executable: "swift",
      args: ["test"],
      cwd: goodFixturePath,
      timeoutMs: 300000,
    });
    assert.equal(payload.recommendedNextRun.tool, "swift_verify");
    assert.equal(payload.recommendedNextRun.arguments.path, goodFixturePath);
    assert.equal(payload.recommendedNextRun.arguments.level, "simulator");
  });
});

test("swift_verify reports build failure with a concrete next action", async () => {
  await withServer(async ({ proc, responses, stderr }) => {
    const response = await callTool(proc, responses, 2, "swift_verify", {
      path: buildFailFixturePath,
      level: "test",
      includeRepairPlan: true,
      repairContextLines: 1,
    });
    assert.equal(response.error, undefined, stderr.join(""));

    const payload = JSON.parse(response.result.content[0].text);
    assert.equal(payload.success, false, JSON.stringify(payload, null, 2));
    assert.equal(payload.failedPhase, "build");
    assert.equal(payload.summary.success, false);
    assert.equal(payload.summary.failedPhase, "build");
    assert.equal(payload.summary.failedStepIndex, 0);
    assert.deepEqual(payload.summary.completedPhases, ["build"]);
    assert.equal(payload.steps.length, 1);
    assert.equal(payload.steps[0].phase, "build");
    assert.equal(payload.steps[0].success, false);
    assert.notEqual(payload.steps[0].exitCode, 0);
    assert.equal(Number.isInteger(payload.steps[0].durationMs), true, JSON.stringify(payload, null, 2));
    assert.equal(payload.steps[0].durationMs >= 0, true, JSON.stringify(payload, null, 2));
    assertIsoTimestamp(payload.startedAt, payload);
    assertIsoTimestamp(payload.endedAt, payload);
    assertIsoTimestamp(payload.steps[0].startedAt, payload);
    assertIsoTimestamp(payload.steps[0].endedAt, payload);
    assert.deepEqual(findArtifact(payload.steps[0], "diagnostics"), {
      kind: "diagnostics",
      label: "Compiler errors",
      storage: "inline",
      contentKey: "errors",
      mediaType: "application/json",
    });
    assert.deepEqual(payload.steps[0].command, {
      executable: "swift",
      args: ["build"],
      cwd: buildFailFixturePath,
      timeoutMs: 300000,
    });
    assert.equal(payload.steps[0].errors.length >= 1, true, JSON.stringify(payload, null, 2));
    assert.match(payload.steps[0].errors[0].file, /Broken\.swift$/);
    assert.match(payload.steps[0].errors[0].message, /missingValue/);
    assert.match(payload.nextAction, /Broken\.swift/);
    assert.equal(payload.focus.kind, "compilerError");
    assert.match(payload.focus.file, /Broken\.swift$/);
    assert.match(payload.focus.message, /missingValue/);
    assert.equal(payload.repairFocus.phase, "build");
    assert.equal(payload.repairFocus.action, "edit");
    assert.equal(payload.repairFocus.target.type, "file");
    assert.match(payload.repairFocus.target.file, /Broken\.swift$/);
    assert.equal(payload.repairFocus.evidence.kind, "diagnostics");
    assert.equal(payload.repairFocus.evidence.contentKey, "errors");
    assert.equal(payload.failureFingerprint.algorithm, "sha256");
    assert.match(payload.failureFingerprint.value, /^[a-f0-9]{16}$/);
    assert.equal(payload.loopStatus.state, "untracked");
    assert.equal(payload.loopStatus.currentFailureFingerprint, payload.failureFingerprint.value);
    assert.equal(payload.loopStatus.sameFailureCount, 1);
    assert.equal(payload.loopStatus.maxSameFailureCount, 3);
    assert.equal(payload.loopStatus.stalled, false);
    assert.equal(payload.loopRecommendation.action, "continue");
    assert.equal(payload.loopTrace.state, "untracked");
    assert.equal(payload.loopTrace.attemptNumber, 1);
    assert.equal(payload.loopTrace.maxSameFailureCount, 3);
    assert.equal(payload.loopTrace.action, "continue");
    assert.equal(payload.loopTrace.fingerprint, payload.failureFingerprint.value);
    assert.equal(payload.loopTrace.nextToolCall.tool, "swift_verify");
    assert.equal(payload.loopTrace.nextToolCall.arguments.level, "build");
    assert.equal(payload.strategyHints[0].id, "apply-focused-repair");
    assert.equal(payload.strategyHints[0].action, "edit");
    assert.match(payload.strategyHints[0].target.file, /Broken\.swift$/);
    assert.equal(payload.inspectionOrder[0].kind, "artifact");
    assert.equal(payload.inspectionOrder[0].artifactKind, "diagnostics");
    assert.equal(payload.nextInspectionActions[0].action, "inspect-inline-artifact");
    assert.equal(payload.nextInspectionActions[0].artifactKind, "diagnostics");
    assert.equal(payload.repairHypotheses[0].id, "build-diagnostic-direct-fix");
    assert.equal(payload.repairHypotheses[0].confidence, "high");
    assert.equal(payload.selectedHypothesis.id, "build-diagnostic-direct-fix");
    assert.equal(payload.selectedHypothesis.selected, true);
    assert.equal(payload.editGuardrails.mode, "minimal-edit");
    assert.match(payload.editGuardrails.targetFiles[0], /Broken\.swift$/);
    assert.equal(payload.postEditVerification.required, true);
    assert.equal(payload.postEditVerification.toolCall.arguments.level, "build");
    assert.equal(payload.postEditVerification.guardrailMode, "minimal-edit");
    assert.equal(payload.repairLoopState.action, "edit");
    assert.equal(payload.repairLoopState.selectedHypothesisId, "build-diagnostic-direct-fix");
    assert.equal(payload.repairLoopState.postEditToolCall.arguments.level, "build");
    assert.deepEqual(
      payload.repairExecutionQueue.map((step) => step.action),
      ["inspect", "edit", "verify"]
    );
    assert.deepEqual(
      payload.repairExecutionQueue.map((step) => step.runPolicy),
      ["read-only", "single-minimal-edit", "call-tool"]
    );
    assert.equal(payload.repairExecutionQueue[2].sequence, 3);
    assert.equal(payload.recommendedNextRun.tool, "swift_verify");
    assert.equal(payload.recommendedNextRun.arguments.path, buildFailFixturePath);
    assert.equal(payload.recommendedNextRun.arguments.level, "test");
    assert.equal(payload.repairPlan.schemaVersion, "swift-repair-plan/v1");
    assert.equal(payload.repairPlan.failedPhase, "build");
    assert.deepEqual(payload.repairPlan.failureFingerprint, payload.failureFingerprint);
    assert.equal(payload.repairPlan.loopRecommendation.action, "continue");
    assert.equal(payload.repairPlan.loopTrace.fingerprint, payload.failureFingerprint.value);
    assert.equal(payload.repairPlan.loopTrace.nextToolCall.arguments.level, "build");
    assert.equal(payload.repairPlan.strategyHints[0].id, "apply-focused-repair");
    assert.equal(payload.repairPlan.inspectionOrder[0].kind, "source");
    assert.match(payload.repairPlan.inspectionOrder[0].file, /Broken\.swift$/);
    assert.equal(payload.repairPlan.inspectionOrder[0].focusedSymbol, "add");
    assert.equal(payload.repairPlan.inspectionOrder[1].artifactKind, "diagnostics");
    assert.equal(payload.repairPlan.nextInspectionActions[0].action, "read-file");
    assert.match(payload.repairPlan.nextInspectionActions[0].path, /Broken\.swift$/);
    assert.equal(payload.repairPlan.nextInspectionActions[1].action, "inspect-inline-artifact");
    assert.equal(payload.repairPlan.repairHypotheses[0].id, "build-diagnostic-direct-fix");
    assert.match(payload.repairPlan.repairHypotheses[0].inspectFirst[0].path, /Broken\.swift$/);
    assert.equal(payload.repairPlan.selectedHypothesis.id, "build-diagnostic-direct-fix");
    assert.equal(payload.repairPlan.editGuardrails.mode, "minimal-edit");
    assert.match(payload.repairPlan.editGuardrails.mustInspectFirst[0].path, /Broken\.swift$/);
    assert.equal(payload.repairPlan.postEditVerification.toolCall.arguments.level, "build");
    assert.equal(payload.repairPlan.postEditVerification.failureFingerprint, payload.failureFingerprint.value);
    assert.equal(payload.repairPlan.repairLoopState.action, "edit");
    assert.equal(payload.repairPlan.repairLoopState.guardrailMode, "minimal-edit");
    assert.deepEqual(
      payload.repairPlan.repairExecutionQueue.map((step) => step.action),
      ["inspect", "inspect", "edit", "verify"]
    );
    assert.equal(payload.repairPlan.repairExecutionQueue[0].sequence, 1);
    assert.equal(payload.repairPlan.repairExecutionQueue[3].runPolicy, "call-tool");
    assert.match(payload.repairPlan.readTargets[0].sourcePath, /Broken\.swift$/);
    assert.equal(payload.repairPlan.readTargets[0].focusedSymbol.name, "add");
    assert.deepEqual(payload.repairPlan.commands[0], {
      executable: "swift",
      args: ["build"],
      cwd: buildFailFixturePath,
      timeoutMs: 300000,
    });
    assert.equal(payload.repairPlan.nextToolCalls[0].tool, "swift_verify");
    assert.equal(payload.repairPlan.nextToolCalls[0].arguments.level, "build");
    assert.equal(payload.repairPlan.nextToolCalls[0].arguments.includeRepairPlan, true);
    assert.equal(payload.repairPlan.nextToolCalls[0].arguments.previousFailureFingerprint, payload.failureFingerprint.value);
    assert.equal(payload.repairPlan.nextToolCalls[0].arguments.previousSameFailureCount, 1);
    assert.equal(payload.repairPlan.nextToolCalls[0].arguments.maxSameFailureCount, 3);

    const planResponse = await callTool(proc, responses, 3, "swift_repair_plan", {
      verificationResultJson: JSON.stringify(payload),
      path: buildFailFixturePath,
      contextLines: 1,
    });
    assert.equal(planResponse.error, undefined, stderr.join(""));
    const plan = JSON.parse(planResponse.result.content[0].text);
    assert.equal(plan.schemaVersion, "swift-repair-plan/v1");
    assert.equal(plan.actionable, true);
    assert.equal(plan.failedPhase, "build");
    assert.deepEqual(plan.failureFingerprint, payload.failureFingerprint);
    assert.equal(plan.readTargets[0].type, "file");
    assert.match(plan.readTargets[0].file, /Broken\.swift$/);
    assert.match(plan.readTargets[0].sourcePath, /Broken\.swift$/);
    assert.equal(plan.readTargets[0].sourceContext.highlightLine, 3);
    assert.match(plan.readTargets[0].sourceContext.text, /missingValue/);
    assert.equal(plan.readTargets[0].focusedSymbol.kind, "func");
    assert.equal(plan.readTargets[0].focusedSymbol.name, "add");
    assert.equal(plan.inspectionOrder[0].kind, "source");
    assert.match(plan.inspectionOrder[0].file, /Broken\.swift$/);
    assert.equal(plan.inspectionOrder[0].focusedSymbol, "add");
    assert.equal(plan.inspectionOrder[1].artifactKind, "diagnostics");
    assert.equal(plan.edits[0].type, "file");
    assert.match(plan.edits[0].file, /Broken\.swift$/);
    assert.equal(plan.artifacts[0].kind, "diagnostics");
    assert.equal(plan.rerun.tool, "swift_verify");
    assert.deepEqual(plan.commands[0], {
      executable: "swift",
      args: ["build"],
      cwd: buildFailFixturePath,
      timeoutMs: 300000,
    });
    assert.equal(plan.nextToolCalls[0].tool, "swift_verify");
    assert.equal(plan.nextToolCalls[0].arguments.level, "build");
    assert.equal(plan.nextToolCalls[0].arguments.includeRepairPlan, true);
    assert.equal(plan.nextToolCalls[0].arguments.previousFailureFingerprint, payload.failureFingerprint.value);
    assert.equal(plan.nextToolCalls[0].arguments.previousSameFailureCount, 1);
    assert.equal(plan.nextToolCalls[0].arguments.maxSameFailureCount, 3);

    const retryResponse = await callTool(proc, responses, 4, "swift_verify", {
      path: buildFailFixturePath,
      level: "test",
      previousFailureFingerprint: payload.failureFingerprint.value,
      previousSameFailureCount: 1,
      maxSameFailureCount: 2,
    });
    assert.equal(retryResponse.error, undefined, stderr.join(""));
    const retryPayload = JSON.parse(retryResponse.result.content[0].text);
    assert.equal(retryPayload.loopStatus.state, "same-failure");
    assert.equal(retryPayload.loopStatus.previousFailureFingerprint, payload.failureFingerprint.value);
    assert.equal(retryPayload.loopStatus.currentFailureFingerprint, payload.failureFingerprint.value);
    assert.equal(retryPayload.loopStatus.sameFailureCount, 2);
    assert.equal(retryPayload.loopStatus.maxSameFailureCount, 2);
    assert.equal(retryPayload.loopStatus.stalled, true);
    assert.equal(retryPayload.loopRecommendation.action, "stop-or-escalate");
    assert.equal(retryPayload.loopTrace.state, "same-failure");
    assert.equal(retryPayload.loopTrace.attemptNumber, 2);
    assert.equal(retryPayload.loopTrace.stalled, true);
    assert.equal(retryPayload.loopTrace.action, "stop-or-escalate");
    assert.equal(retryPayload.strategyHints[0].id, "change-repair-strategy");
    assert.equal(retryPayload.strategyHints[0].priority, "high");
    assert.equal(retryPayload.strategyHints[1].id, "compare-failure-evidence");
    assert.equal(retryPayload.strategyHints[2].id, "follow-inspection-order");
    assert.equal(retryPayload.inspectionOrder[0].artifactKind, "diagnostics");
    assert.equal(retryPayload.nextInspectionActions[0].action, "inspect-inline-artifact");
    assert.equal(retryPayload.repairHypotheses[0].id, "build-diagnostic-alternate-cause");
    assert.equal(retryPayload.repairHypotheses[0].confidence, "medium");
    assert.equal(retryPayload.selectedHypothesis.id, "build-diagnostic-alternate-cause");
    assert.match(retryPayload.selectedHypothesis.selectionReason, /stalled/);
    assert.equal(retryPayload.editGuardrails.mode, "inspect-before-edit");
    assert.equal(retryPayload.editGuardrails.avoid.some((item) => /stalled fingerprint/.test(item)), true);
    assert.equal(retryPayload.postEditVerification.guardrailMode, "inspect-before-edit");
    assert.match(retryPayload.postEditVerification.onSameFailure, /Do not edit again/);
    assert.equal(retryPayload.repairLoopState.action, "escalate");
    assert.equal(retryPayload.repairLoopState.stopOrEscalate, true);
    assert.equal(retryPayload.repairLoopState.selectedHypothesisId, "build-diagnostic-alternate-cause");
    assert.deepEqual(
      retryPayload.repairExecutionQueue.map((step) => step.action),
      ["inspect", "escalate"]
    );
    assert.deepEqual(
      retryPayload.repairExecutionQueue.map((step) => step.runPolicy),
      ["read-only", "manual-review"]
    );
  });
});

test("swift_verify reports test failure after a successful build", async () => {
  await withServer(async ({ proc, responses, stderr }) => {
    const response = await callTool(proc, responses, 2, "swift_verify", {
      path: testFailFixturePath,
      level: "test",
      includeRepairPlan: true,
      repairContextLines: 1,
    });
    assert.equal(response.error, undefined, stderr.join(""));

    const payload = JSON.parse(response.result.content[0].text);
    assert.equal(payload.success, false, JSON.stringify(payload, null, 2));
    assert.equal(payload.failedPhase, "test");
    assert.deepEqual(payload.steps.map((step) => step.phase), ["build", "test"]);
    assert.equal(payload.summary.failedPhase, "test");
    assert.equal(payload.summary.failedStepIndex, 1);
    assert.equal(payload.summary.totalSteps, 2);
    assert.equal(payload.steps[0].success, true);
    assert.equal(payload.steps[1].success, false);
    assert.notEqual(payload.steps[1].exitCode, 0);
    assert.equal(Number.isInteger(payload.steps[1].durationMs), true, JSON.stringify(payload, null, 2));
    assert.equal(payload.steps[1].durationMs >= 0, true, JSON.stringify(payload, null, 2));
    assertIsoTimestamp(payload.startedAt, payload);
    assertIsoTimestamp(payload.endedAt, payload);
    assertIsoTimestamp(payload.steps[1].startedAt, payload);
    assertIsoTimestamp(payload.steps[1].endedAt, payload);
    assert.deepEqual(findArtifact(payload.steps[1], "test-failures"), {
      kind: "test-failures",
      label: "Failed tests",
      storage: "inline",
      contentKey: "failedTests",
      mediaType: "application/json",
    });
    assert.deepEqual(payload.steps[1].command, {
      executable: "swift",
      args: ["test"],
      cwd: testFailFixturePath,
      timeoutMs: 300000,
    });
    assert.equal(payload.steps[1].failed >= 1, true, JSON.stringify(payload, null, 2));
    assert.equal(payload.steps[1].failedTests.length >= 1, true, JSON.stringify(payload, null, 2));
    assert.match(payload.steps[1].failedTests[0].name, /addReturnsWrongExpectation/);
    assert.match(payload.steps[1].firstFailure.name, /addReturnsWrongExpectation/);
    assert.match(payload.steps[1].output, /addReturnsWrongExpectation|Expectation failed|failed/i);
    assert.match(payload.nextAction, /addReturnsWrongExpectation/);
    assert.equal(payload.focus.kind, "testFailure");
    assert.match(payload.focus.testName, /addReturnsWrongExpectation/);
    assert.match(payload.focus.file, /CalculatorTests\.swift$/);
    assert.equal(payload.repairFocus.phase, "test");
    assert.equal(payload.repairFocus.action, "edit");
    assert.equal(payload.repairFocus.target.type, "file");
    assert.match(payload.repairFocus.target.file, /CalculatorTests\.swift$/);
    assert.equal(payload.repairFocus.target.testFilter, "addReturnsWrongExpectation");
    assert.equal(payload.repairFocus.evidence.kind, "test-failures");
    assert.equal(payload.failureFingerprint.algorithm, "sha256");
    assert.match(payload.failureFingerprint.value, /^[a-f0-9]{16}$/);
    assert.equal(payload.loopStatus.state, "untracked");
    assert.equal(payload.loopStatus.currentFailureFingerprint, payload.failureFingerprint.value);
    assert.equal(payload.loopStatus.sameFailureCount, 1);
    assert.equal(payload.loopStatus.maxSameFailureCount, 3);
    assert.equal(payload.loopStatus.stalled, false);
    assert.equal(payload.loopRecommendation.action, "continue");
    assert.equal(payload.loopTrace.state, "untracked");
    assert.equal(payload.loopTrace.attemptNumber, 1);
    assert.equal(payload.loopTrace.fingerprint, payload.failureFingerprint.value);
    assert.equal(payload.loopTrace.nextToolCall.arguments.testFilter, "addReturnsWrongExpectation");
    assert.equal(payload.strategyHints[0].id, "apply-focused-repair");
    assert.equal(payload.strategyHints[0].target.testFilter, "addReturnsWrongExpectation");
    assert.equal(payload.inspectionOrder[0].artifactKind, "command-output");
    assert.equal(payload.inspectionOrder[1].artifactKind, "test-failures");
    assert.equal(payload.nextInspectionActions[0].action, "inspect-inline-artifact");
    assert.equal(payload.nextInspectionActions[1].artifactKind, "test-failures");
    assert.equal(payload.repairHypotheses[0].id, "test-failure-contract-mismatch");
    assert.equal(payload.repairHypotheses[0].target.testFilter, "addReturnsWrongExpectation");
    assert.equal(payload.selectedHypothesis.id, "test-failure-contract-mismatch");
    assert.equal(payload.editGuardrails.mode, "minimal-edit");
    assert.equal(payload.postEditVerification.toolCall.arguments.testFilter, "addReturnsWrongExpectation");
    assert.equal(payload.recommendedNextRun.tool, "swift_verify");
    assert.equal(payload.recommendedNextRun.arguments.path, testFailFixturePath);
    assert.equal(payload.recommendedNextRun.arguments.level, "test");
    assert.equal(payload.recommendedNextRun.arguments.testFilter, "addReturnsWrongExpectation");
    assert.equal(payload.repairPlan.schemaVersion, "swift-repair-plan/v1");
    assert.equal(payload.repairPlan.failedPhase, "test");
    assert.deepEqual(payload.repairPlan.failureFingerprint, payload.failureFingerprint);
    assert.equal(payload.repairPlan.loopRecommendation.action, "continue");
    assert.match(payload.repairPlan.readTargets[0].sourcePath, /CalculatorTests\.swift$/);
    assert.equal(payload.repairPlan.readTargets[0].focusedSymbol.name, "addReturnsWrongExpectation");
    assert.deepEqual(payload.repairPlan.commands[0], {
      executable: "swift",
      args: ["test", "--filter", "addReturnsWrongExpectation"],
      cwd: testFailFixturePath,
      timeoutMs: 300000,
    });
    assert.equal(payload.repairPlan.nextToolCalls[0].tool, "swift_verify");
    assert.equal(payload.repairPlan.nextToolCalls[0].arguments.level, "test");
    assert.equal(payload.repairPlan.nextToolCalls[0].arguments.testFilter, "addReturnsWrongExpectation");
    assert.equal(payload.repairPlan.nextToolCalls[0].arguments.includeRepairPlan, true);
    assert.equal(payload.repairPlan.nextToolCalls[0].arguments.previousFailureFingerprint, payload.failureFingerprint.value);
    assert.equal(payload.repairPlan.nextToolCalls[0].arguments.previousSameFailureCount, 1);
    assert.equal(payload.repairPlan.nextToolCalls[0].arguments.maxSameFailureCount, 3);

    const planResponse = await callTool(proc, responses, 3, "swift_repair_plan", {
      verificationResultJson: JSON.stringify(payload),
      path: testFailFixturePath,
      contextLines: 1,
    });
    assert.equal(planResponse.error, undefined, stderr.join(""));
    const plan = JSON.parse(planResponse.result.content[0].text);
    assert.equal(plan.schemaVersion, "swift-repair-plan/v1");
    assert.equal(plan.actionable, true);
    assert.equal(plan.failedPhase, "test");
    assert.deepEqual(plan.failureFingerprint, payload.failureFingerprint);
    assert.equal(plan.readTargets[0].type, "file");
    assert.match(plan.readTargets[0].file, /CalculatorTests\.swift$/);
    assert.match(plan.readTargets[0].sourcePath, /CalculatorTests\.swift$/);
    assert.equal(plan.readTargets[0].sourceContext.highlightLine, 5);
    assert.match(plan.readTargets[0].sourceContext.text, /#expect/);
    assert.equal(plan.readTargets[0].focusedSymbol.kind, "func");
    assert.equal(plan.readTargets[0].focusedSymbol.name, "addReturnsWrongExpectation");
    assert.equal(plan.inspectionOrder[0].kind, "source");
    assert.match(plan.inspectionOrder[0].file, /CalculatorTests\.swift$/);
    assert.equal(plan.inspectionOrder[0].focusedSymbol, "addReturnsWrongExpectation");
    assert.equal(plan.inspectionOrder[1].artifactKind, "test-failures");
    assert.equal(plan.nextInspectionActions[0].action, "read-file");
    assert.match(plan.nextInspectionActions[0].path, /CalculatorTests\.swift$/);
    assert.equal(plan.nextInspectionActions[1].action, "inspect-inline-artifact");
    assert.equal(plan.repairHypotheses[0].id, "test-failure-contract-mismatch");
    assert.match(plan.repairHypotheses[0].inspectFirst[0].path, /CalculatorTests\.swift$/);
    assert.equal(plan.selectedHypothesis.id, "test-failure-contract-mismatch");
    assert.match(plan.editGuardrails.mustInspectFirst[0].path, /CalculatorTests\.swift$/);
    assert.equal(plan.postEditVerification.toolCall.arguments.testFilter, "addReturnsWrongExpectation");
    assert.equal(plan.edits[0].testFilter, "addReturnsWrongExpectation");
    assert.equal(plan.artifacts[0].kind, "test-failures");
    assert.equal(plan.rerun.arguments.testFilter, "addReturnsWrongExpectation");
    assert.deepEqual(plan.commands[0], {
      executable: "swift",
      args: ["test", "--filter", "addReturnsWrongExpectation"],
      cwd: testFailFixturePath,
      timeoutMs: 300000,
    });
    assert.equal(plan.nextToolCalls[0].tool, "swift_verify");
    assert.equal(plan.nextToolCalls[0].arguments.level, "test");
    assert.equal(plan.nextToolCalls[0].arguments.testFilter, "addReturnsWrongExpectation");
    assert.equal(plan.nextToolCalls[0].arguments.includeRepairPlan, true);
    assert.equal(plan.nextToolCalls[0].arguments.previousFailureFingerprint, payload.failureFingerprint.value);
    assert.equal(plan.nextToolCalls[0].arguments.previousSameFailureCount, 1);
    assert.equal(plan.nextToolCalls[0].arguments.maxSameFailureCount, 3);
  });
});

test("swift_verify applies testFilter and recommends the full suite after a focused pass", async () => {
  await withServer(async ({ proc, responses, stderr }) => {
    const response = await callTool(proc, responses, 2, "swift_verify", {
      path: testFailFixturePath,
      level: "test",
      testFilter: "addReturnsSum",
    });
    assert.equal(response.error, undefined, stderr.join(""));

    const payload = JSON.parse(response.result.content[0].text);
    assert.equal(payload.success, true, JSON.stringify(payload, null, 2));
    assert.equal(payload.level, "test");
    assert.deepEqual(payload.steps.map((step) => step.phase), ["build", "test"]);
    assert.equal(payload.steps[1].testFilter, "addReturnsSum");
    assert.equal(payload.steps[1].exitCode, 0);
    assert.equal(Number.isInteger(payload.steps[1].durationMs), true, JSON.stringify(payload, null, 2));
    assert.equal(payload.steps[1].durationMs >= 0, true, JSON.stringify(payload, null, 2));
    assert.deepEqual(payload.steps[1].command, {
      executable: "swift",
      args: ["test", "--filter", "addReturnsSum"],
      cwd: testFailFixturePath,
      timeoutMs: 300000,
    });
    assert.equal(payload.steps[1].passed >= 1, true, JSON.stringify(payload, null, 2));
    assert.equal(payload.steps[1].failed, 0);
    assert.equal(payload.recommendedNextRun.tool, "swift_verify");
    assert.equal(payload.recommendedNextRun.arguments.path, testFailFixturePath);
    assert.equal(payload.recommendedNextRun.arguments.level, "test");
    assert.equal("testFilter" in payload.recommendedNextRun.arguments, false);
  });
});

test("swift_verify rejects a package with no runnable tests", async () => {
  await withServer(async ({ proc, responses, stderr }) => {
    const response = await callTool(proc, responses, 2, "swift_verify", {
      path: noTestsFixturePath,
      level: "test",
    });
    assert.equal(response.error, undefined, stderr.join(""));

    const payload = JSON.parse(response.result.content[0].text);
    assert.equal(payload.success, false, JSON.stringify(payload, null, 2));
    assert.equal(payload.failedPhase, "test");
    assert.equal(payload.summary.failedPhase, "test");
    assert.equal(payload.summary.failedStepIndex, 1);
    assert.deepEqual(payload.steps.map((step) => step.phase), ["build", "test"]);
    assert.equal(payload.steps[0].success, true);
    assert.equal(payload.steps[1].success, false);
    assert.equal(payload.steps[1].noTests, true);
    assert.notEqual(payload.steps[1].exitCode, 0);
    assert.equal(Number.isInteger(payload.steps[1].durationMs), true, JSON.stringify(payload, null, 2));
    assert.equal(payload.steps[1].durationMs >= 0, true, JSON.stringify(payload, null, 2));
    assert.deepEqual(payload.steps[1].command, {
      executable: "swift",
      args: ["test"],
      cwd: noTestsFixturePath,
      timeoutMs: 300000,
    });
    assert.equal(payload.steps[1].passed, 0);
    assert.equal(payload.steps[1].failed, 0);
    assert.match(payload.nextAction, /Add at least one/);
    assert.equal(payload.focus.kind, "noRunnableTests");
    assert.equal(payload.repairFocus.phase, "test");
    assert.equal(payload.repairFocus.action, "add-tests");
    assert.equal(payload.repairFocus.target.type, "test-suite");
    assert.equal(payload.repairFocus.evidence.kind, "command-output");
    assert.equal(payload.recommendedNextRun.tool, "swift_verify");
    assert.equal(payload.recommendedNextRun.arguments.path, noTestsFixturePath);
    assert.equal(payload.recommendedNextRun.arguments.level, "test");
  });
});
