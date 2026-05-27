import assert from "node:assert/strict";
import test from "node:test";
import {
  commandInvocation,
  detectsNoRunnableTests,
  editGuardrailsFromHypothesis,
  failureFingerprintFromFocus,
  inspectionOrderFromEvidence,
  inspectProjectFiles,
  loopRecommendationFromStatus,
  loopStatusFromFingerprint,
  loopTraceFromState,
  nextInspectionActionsFromOrder,
  parseDiagnostics,
  parseLaunchPID,
  parseTestCounts,
  postEditVerificationFromState,
  repairNextStepFromQueue,
  repairExecutionQueueFromPayload,
  repairExecutionQueueFromState,
  repairHypothesesFromState,
  repairLoopStateFromState,
  repairPlanCommandsFromRerun,
  repairPlanFromVerificationResult,
  repairPlanToolCallsFromRerun,
  simulatorDestination,
  simulatorEvidencePaths,
  simulatorLogPredicate,
  selectedHypothesisFromState,
  sourceExcerptForLine,
  focusedSwiftSymbol,
  strategyHintsFromState,
  swiftPMBuildPlan,
  swiftSymbolsInSource,
  swiftVerifyMetadata,
  swiftVerifyRecommendation,
  summarizeTestFailures,
  summarizeRuntimeLog,
  testFilterFromFailureName,
  toolRecommendation,
  verificationArtifact,
  verificationFocus,
  verificationNextAction,
  verificationRepairFocus,
  verificationSummary,
  xcodeBuildPlan,
  xcodeSimulatorBuildPlan,
  xcodeProjectArgs,
} from "../dist/index.js";

test("inspectProjectFiles detects SwiftPM and Xcode project files", () => {
  const files = inspectProjectFiles(["Package.swift", "App.xcodeproj", "App.xcworkspace"]);

  assert.equal(files.hasPackageSwift, true);
  assert.equal(files.xcodeproj, "App.xcodeproj");
  assert.equal(files.xcworkspace, "App.xcworkspace");
});

test("swiftVerifyMetadata exposes stable payload capabilities", () => {
  const metadata = swiftVerifyMetadata();

  assert.equal(metadata.schemaVersion, "swift-verify/v1");
  assert.equal(metadata.capabilities.includes("structuredSteps"), true);
  assert.equal(metadata.capabilities.includes("stepCommands"), true);
  assert.equal(metadata.capabilities.includes("failureFocus"), true);
  assert.equal(metadata.capabilities.includes("summary"), true);
  assert.equal(metadata.capabilities.includes("timestamps"), true);
  assert.equal(metadata.capabilities.includes("artifacts"), true);
  assert.equal(metadata.capabilities.includes("repairFocus"), true);
  assert.equal(metadata.capabilities.includes("failureFingerprint"), true);
  assert.equal(metadata.capabilities.includes("loopStatus"), true);
  assert.equal(metadata.capabilities.includes("loopRecommendation"), true);
  assert.equal(metadata.capabilities.includes("loopTrace"), true);
  assert.equal(metadata.capabilities.includes("strategyHints"), true);
  assert.equal(metadata.capabilities.includes("inspectionOrder"), true);
  assert.equal(metadata.capabilities.includes("nextInspectionActions"), true);
  assert.equal(metadata.capabilities.includes("repairHypotheses"), true);
  assert.equal(metadata.capabilities.includes("selectedHypothesis"), true);
  assert.equal(metadata.capabilities.includes("editGuardrails"), true);
  assert.equal(metadata.capabilities.includes("postEditVerification"), true);
  assert.equal(metadata.capabilities.includes("repairLoopState"), true);
  assert.equal(metadata.capabilities.includes("repairExecutionQueue"), true);
  assert.equal(metadata.capabilities.includes("repairExecutionPolicies"), true);
  assert.equal(metadata.capabilities.includes("repairNextStep"), true);
  assert.equal(metadata.capabilities.includes("configurableStallThreshold"), true);
});

test("commandInvocation copies args and includes cwd/timeout when present", () => {
  const args = ["test"];
  const invocation = commandInvocation("swift", args, "/tmp/App", 120000);
  args.push("--filter", "ChangedTest");

  assert.deepEqual(invocation, {
    executable: "swift",
    args: ["test"],
    cwd: "/tmp/App",
    timeoutMs: 120000,
  });
  assert.deepEqual(commandInvocation("swift", ["--version"]), {
    executable: "swift",
    args: ["--version"],
  });
});

test("verificationArtifact describes inline and file-backed evidence", () => {
  assert.deepEqual(
    verificationArtifact("command-output", "Build raw output", {
      storage: "inline",
      contentKey: "rawOutput",
      mediaType: "text/plain",
    }),
    {
      kind: "command-output",
      label: "Build raw output",
      storage: "inline",
      contentKey: "rawOutput",
      mediaType: "text/plain",
    }
  );

  assert.deepEqual(
    verificationArtifact("screenshot", "Simulator screenshot", {
      storage: "file",
      path: "/tmp/App/.swift-agent/simulator/App-screenshot.png",
      mediaType: "image/png",
    }),
    {
      kind: "screenshot",
      label: "Simulator screenshot",
      storage: "file",
      path: "/tmp/App/.swift-agent/simulator/App-screenshot.png",
      mediaType: "image/png",
    }
  );
});

test("xcodeProjectArgs prefers workspaces and can return absolute paths", () => {
  const files = inspectProjectFiles(["App.xcodeproj", "App.xcworkspace"]);

  assert.deepEqual(xcodeProjectArgs(files), ["-workspace", "App.xcworkspace"]);
  assert.deepEqual(xcodeProjectArgs(files, true, "/tmp/MyApp"), [
    "-workspace",
    "/tmp/MyApp/App.xcworkspace",
  ]);
});

test("swiftPMBuildPlan is honest about typecheck fallback", () => {
  const plan = swiftPMBuildPlan("release", "typecheck");

  assert.deepEqual(plan.args, ["build", "-c", "release"]);
  assert.equal(plan.stage, "build");
  assert.match(plan.note, /SwiftPM does not expose/);
});

test("xcodeBuildPlan keeps typecheck-style build settings on xcodebuild only", () => {
  const args = xcodeBuildPlan(["-project", "App.xcodeproj"], "App", "build", "debug", "typecheck");

  assert.deepEqual(args, [
    "-project",
    "App.xcodeproj",
    "-scheme",
    "App",
    "-configuration",
    "Debug",
    "build",
    "SWIFT_COMPILATION_MODE=singlefile",
    "COMPILER_INDEX_STORE_ENABLE=NO",
  ]);
});

test("xcodeSimulatorBuildPlan includes destination and derived data path", () => {
  const args = xcodeSimulatorBuildPlan(
    ["-workspace", "App.xcworkspace"],
    "App",
    simulatorDestination("iPhone 16"),
    "/tmp/DerivedData"
  );

  assert.deepEqual(args, [
    "-workspace",
    "App.xcworkspace",
    "-scheme",
    "App",
    "-destination",
    "platform=iOS Simulator,name=iPhone 16",
    "-derivedDataPath",
    "/tmp/DerivedData",
    "build",
  ]);
});

test("simulatorEvidencePaths creates stable safe artifact paths", () => {
  const paths = simulatorEvidencePaths("/tmp/MyApp", "My App/Debug");

  assert.equal(paths.derivedDataPath, "/tmp/MyApp/.swift-agent/simulator/DerivedData/My_App_Debug");
  assert.equal(paths.screenshotPath, "/tmp/MyApp/.swift-agent/simulator/My_App_Debug-screenshot.png");
  assert.equal(paths.logPath, "/tmp/MyApp/.swift-agent/simulator/My_App_Debug-runtime.log");
});

test("parseLaunchPID extracts simctl launch process id", () => {
  assert.equal(parseLaunchPID("com.example.App: 4242\n"), 4242);
  assert.equal(parseLaunchPID("launch failed"), null);
});

test("simulatorLogPredicate escapes bundle identifiers for log show", () => {
  assert.equal(
    simulatorLogPredicate('com.example."Quoted"'),
    'eventMessage CONTAINS[c] "com.example.\\"Quoted\\"" OR process CONTAINS[c] "com.example.\\"Quoted\\""'
  );
});

test("summarizeRuntimeLog flags crash-like evidence", () => {
  const summary = summarizeRuntimeLog("Fatal error: unexpectedly found nil while unwrapping an Optional value");

  assert.equal(summary.issueDetected, true);
  assert.deepEqual(summary.matchedPatterns, ["Fatal error"]);
});

test("parseTestCounts handles XCTest and Swift Testing output", () => {
  const output = [
    "Test Case '-[AppTests testExample]' passed",
    "Test Case '-[AppTests testFailure]' failed",
    "Test feature passed",
    "✔ Test addReturnsSum() passed after 0.001 seconds.",
    "Test behavior failed",
  ].join("\n");

  assert.deepEqual(parseTestCounts(output), { passed: 3, failed: 2 });
});

test("detectsNoRunnableTests handles zero-count and SwiftPM no-test output", () => {
  assert.equal(detectsNoRunnableTests("", { passed: 0, failed: 0 }, 0), true);
  assert.equal(
    detectsNoRunnableTests("error: no tests found; create a target in the 'Tests' directory", { passed: 0, failed: 0 }, 1),
    true
  );
  assert.equal(detectsNoRunnableTests("Test Case '-[AppTests testExample]' passed", { passed: 1, failed: 0 }, 0), false);
});

test("summarizeTestFailures extracts the first Swift Testing failure", () => {
  const output = [
    "✘ Test addReturnsWrongExpectation() failed after 0.001 seconds.",
    "/tmp/App/Tests/AppTests/CalculatorTests.swift:5: error: Expectation failed: Calculator.add(2, 3) == 6",
  ].join("\n");

  assert.deepEqual(summarizeTestFailures(output), {
    failedTests: [
      {
        name: "addReturnsWrongExpectation()",
        file: "/tmp/App/Tests/AppTests/CalculatorTests.swift",
        line: 5,
        message: "Expectation failed: Calculator.add(2, 3) == 6",
      },
    ],
    firstFailure: {
      name: "addReturnsWrongExpectation()",
      file: "/tmp/App/Tests/AppTests/CalculatorTests.swift",
      line: 5,
      message: "Expectation failed: Calculator.add(2, 3) == 6",
    },
  });
});

test("summarizeTestFailures extracts location from Swift Testing issue lines", () => {
  const output = [
    "✘ Test addReturnsWrongExpectation() recorded an issue at CalculatorTests.swift:5:5: Expectation failed: Calculator.add(2, 3) == 6",
    "✘ Test addReturnsWrongExpectation() failed after 0.001 seconds with 1 issue.",
  ].join("\n");

  assert.deepEqual(summarizeTestFailures(output), {
    failedTests: [
      {
        name: "addReturnsWrongExpectation()",
        file: "CalculatorTests.swift",
        line: 5,
        message: "Expectation failed: Calculator.add(2, 3) == 6",
      },
    ],
    firstFailure: {
      name: "addReturnsWrongExpectation()",
      file: "CalculatorTests.swift",
      line: 5,
      message: "Expectation failed: Calculator.add(2, 3) == 6",
    },
  });
});

test("verificationNextAction points to the first compiler error", () => {
  assert.equal(
    verificationNextAction("build", { errors: [{ file: "Sources/App/View.swift", line: 42 }] }),
    "Fix Sources/App/View.swift:42 first, then run swift_verify again."
  );
});

test("verificationNextAction points to the first failing test", () => {
  assert.equal(
    verificationNextAction("test", {
      firstFailure: {
        name: "addReturnsWrongExpectation()",
        file: "Tests/AppTests/CalculatorTests.swift",
        line: 5,
      },
    }),
    "Fix failing test addReturnsWrongExpectation() at Tests/AppTests/CalculatorTests.swift:5, then run swift_verify with level=\"test\"."
  );
});

test("verificationNextAction rejects empty test suites", () => {
  assert.equal(
    verificationNextAction("test", { noTests: true }),
    "Add at least one Swift Testing @Test or XCTestCase test, then run swift_verify with level=\"test\"."
  );
});

test("verificationNextAction reports an empty filtered test run", () => {
  assert.equal(
    verificationNextAction("test", { noTests: true, testFilter: "DoesNotExist" }),
    'No tests matched testFilter "DoesNotExist". Remove or adjust the filter, then run swift_verify with level="test".'
  );
});

test("verificationFocus points to the first build diagnostic", () => {
  assert.deepEqual(
    verificationFocus("build", {
      errors: [
        {
          file: "Sources/App/View.swift",
          line: 42,
          column: 8,
          severity: "error",
          message: "cannot find 'foo' in scope",
        },
      ],
    }),
    {
      kind: "compilerError",
      file: "Sources/App/View.swift",
      line: 42,
      column: 8,
      severity: "error",
      message: "cannot find 'foo' in scope",
    }
  );
});

test("verificationFocus points to the first failing test", () => {
  assert.deepEqual(
    verificationFocus("test", {
      firstFailure: {
        name: "addReturnsWrongExpectation()",
        file: "Tests/AppTests/CalculatorTests.swift",
        line: 5,
        message: "Expectation failed",
      },
    }),
    {
      kind: "testFailure",
      testName: "addReturnsWrongExpectation()",
      file: "Tests/AppTests/CalculatorTests.swift",
      line: 5,
      message: "Expectation failed",
    }
  );
});

test("verificationFocus distinguishes no-test and empty filtered runs", () => {
  assert.deepEqual(verificationFocus("test", { noTests: true }), {
    kind: "noRunnableTests",
    testFilter: undefined,
    message: "No runnable tests were found.",
  });
  assert.deepEqual(verificationFocus("test", { noTests: true, testFilter: "MissingTest" }), {
    kind: "emptyFilteredTests",
    testFilter: "MissingTest",
    message: 'No tests matched testFilter "MissingTest".',
  });
});

test("verificationRepairFocus points build failures at the editable file", () => {
  assert.deepEqual(
    verificationRepairFocus("build", {
      errors: [
        {
          file: "Sources/App/View.swift",
          line: 42,
          column: 8,
          message: "cannot find 'foo' in scope",
        },
      ],
      artifacts: [
        {
          kind: "diagnostics",
          label: "Compiler errors",
          storage: "inline",
          contentKey: "errors",
          mediaType: "application/json",
        },
      ],
    }),
    {
      phase: "build",
      action: "edit",
      target: {
        type: "file",
        file: "Sources/App/View.swift",
        line: 42,
        column: 8,
      },
      evidence: {
        kind: "diagnostics",
        label: "Compiler errors",
        storage: "inline",
        contentKey: "errors",
        mediaType: "application/json",
      },
      message: "cannot find 'foo' in scope",
    }
  );
});

test("verificationRepairFocus carries the focused test filter for test failures", () => {
  assert.deepEqual(
    verificationRepairFocus("test", {
      firstFailure: {
        name: "addReturnsWrongExpectation()",
        file: "Tests/AppTests/CalculatorTests.swift",
        line: 5,
        message: "Expectation failed",
      },
      artifacts: [
        {
          kind: "test-failures",
          label: "Failed tests",
          storage: "inline",
          contentKey: "failedTests",
          mediaType: "application/json",
        },
      ],
    }),
    {
      phase: "test",
      action: "edit",
      target: {
        type: "file",
        file: "Tests/AppTests/CalculatorTests.swift",
        line: 5,
        testName: "addReturnsWrongExpectation()",
        testFilter: "addReturnsWrongExpectation",
      },
      evidence: {
        kind: "test-failures",
        label: "Failed tests",
        storage: "inline",
        contentKey: "failedTests",
        mediaType: "application/json",
      },
      message: "Expectation failed",
    }
  );
});

test("verificationSummary condenses step results", () => {
  assert.deepEqual(
    verificationSummary(
      [
        { phase: "build", success: true, durationMs: 10 },
        { phase: "test", success: false, durationMs: 25 },
      ],
      { success: false, failedPhase: "test" }
    ),
    {
      success: false,
      failedPhase: "test",
      totalSteps: 2,
      completedPhases: ["build", "test"],
      failedStepIndex: 1,
      slowestStep: { phase: "test", index: 1, durationMs: 25 },
      totalStepDurationMs: 35,
    }
  );
});

test("verificationSummary ignores skipped steps for failedStepIndex", () => {
  assert.deepEqual(
    verificationSummary([{ phase: "simulator", success: false, skipped: true, durationMs: 3 }], {
      success: false,
      failedPhase: "simulator",
    }),
    {
      success: false,
      failedPhase: "simulator",
      totalSteps: 1,
      completedPhases: ["simulator"],
      failedStepIndex: undefined,
      slowestStep: { phase: "simulator", index: 0, durationMs: 3 },
      totalStepDurationMs: 3,
    }
  );
});

test("testFilterFromFailureName creates a SwiftPM-friendly filter", () => {
  assert.equal(testFilterFromFailureName("addReturnsWrongExpectation()"), "addReturnsWrongExpectation");
  assert.equal(testFilterFromFailureName("-[AppTests testExample]"), "-[AppTests testExample]");
  assert.equal(testFilterFromFailureName(undefined), undefined);
});

test("toolRecommendation removes undefined arguments", () => {
  assert.deepEqual(toolRecommendation("swift_verify", { path: "/tmp/App", scheme: undefined }, "retry"), {
    tool: "swift_verify",
    arguments: { path: "/tmp/App" },
    reason: "retry",
  });
});

test("swiftVerifyRecommendation returns a replayable verification call", () => {
  assert.deepEqual(
    swiftVerifyRecommendation(
      "/tmp/App",
      "simulator",
      { scheme: "App", simulator: "iPhone 16 Pro", bundleIdentifier: undefined },
      "collect evidence"
    ),
    {
      tool: "swift_verify",
      arguments: {
        path: "/tmp/App",
        level: "simulator",
        scheme: "App",
        simulator: "iPhone 16 Pro",
      },
      reason: "collect evidence",
    }
  );
});

test("repairPlanCommandsFromRerun materializes SwiftPM verification commands", () => {
  assert.deepEqual(
    repairPlanCommandsFromRerun({
      tool: "swift_verify",
      arguments: { path: "/tmp/App", level: "test", testFilter: "addReturnsWrongExpectation" },
      reason: "retry",
    }),
    [
      {
        executable: "swift",
        args: ["test", "--filter", "addReturnsWrongExpectation"],
        cwd: "/tmp/App",
        timeoutMs: 300000,
      },
    ]
  );
  assert.deepEqual(
    repairPlanCommandsFromRerun(
      {
        tool: "swift_verify",
        arguments: { path: "/tmp/App", level: "test" },
        reason: "retry",
      },
      "build"
    ),
    [
      {
        executable: "swift",
        args: ["build"],
        cwd: "/tmp/App",
        timeoutMs: 300000,
      },
    ]
  );
  assert.deepEqual(
    repairPlanCommandsFromRerun({
      tool: "swift_verify",
      arguments: { path: "/tmp/App", level: "build", configuration: "release" },
      reason: "retry",
    }),
    [
      {
        executable: "swift",
        args: ["build", "-c", "release"],
        cwd: "/tmp/App",
        timeoutMs: 300000,
      },
    ]
  );
});

test("repairPlanToolCallsFromRerun materializes next MCP verification calls", () => {
  assert.deepEqual(
    repairPlanToolCallsFromRerun(
      {
        tool: "swift_verify",
        arguments: { path: "/tmp/App", level: "test" },
        reason: "retry",
      },
      "build",
      { value: "abc123" },
      { sameFailureCount: 1, maxSameFailureCount: 3 }
    ),
    [
      {
        tool: "swift_verify",
        arguments: {
          path: "/tmp/App",
          level: "build",
          includeRepairPlan: true,
          repairContextLines: 4,
          previousFailureFingerprint: "abc123",
          previousSameFailureCount: 1,
          maxSameFailureCount: 3,
        },
        reason: "After editing, verify the build phase before continuing to deeper checks.",
      },
    ]
  );
  assert.deepEqual(
    repairPlanToolCallsFromRerun(
      {
        tool: "swift_verify",
        arguments: { path: "/tmp/App", level: "test", testFilter: "addReturnsWrongExpectation" },
        reason: "retry focused test",
      },
      undefined,
      { value: "def456" },
      { sameFailureCount: 2, maxSameFailureCount: 4 }
    ),
    [
      {
        tool: "swift_verify",
        arguments: {
          path: "/tmp/App",
          level: "test",
          testFilter: "addReturnsWrongExpectation",
          includeRepairPlan: true,
          repairContextLines: 4,
          previousFailureFingerprint: "def456",
          previousSameFailureCount: 2,
          maxSameFailureCount: 4,
        },
        reason: "retry focused test",
      },
    ]
  );
});

test("failureFingerprintFromFocus is stable and sensitive to target changes", () => {
  const focus = {
    phase: "test",
    action: "edit",
    target: {
      type: "file",
      file: "Tests/AppTests/CalculatorTests.swift",
      line: 5,
      testName: "addReturnsWrongExpectation()",
      testFilter: "addReturnsWrongExpectation",
    },
    message: "Expectation failed",
  };
  const first = failureFingerprintFromFocus("test", focus);
  const second = failureFingerprintFromFocus("test", {
    message: "Expectation failed",
    target: {
      testFilter: "addReturnsWrongExpectation",
      testName: "addReturnsWrongExpectation()",
      line: 5,
      file: "Tests/AppTests/CalculatorTests.swift",
      type: "file",
    },
    action: "edit",
    phase: "test",
  });
  const changed = failureFingerprintFromFocus("test", {
    ...focus,
    target: { ...focus.target, line: 6 },
  });

  assert.equal(first?.algorithm, "sha256");
  assert.match(first?.value ?? "", /^[a-f0-9]{16}$/);
  assert.equal(first?.value, second?.value);
  assert.notEqual(first?.value, changed?.value);
});

test("loopStatusFromFingerprint reports retry progress", () => {
  const current = { value: "abc123" };

  assert.deepEqual(loopStatusFromFingerprint(undefined, current, false), {
    state: "untracked",
    previousFailureFingerprint: undefined,
    currentFailureFingerprint: "abc123",
    sameFailureCount: 1,
    maxSameFailureCount: 3,
    stalled: false,
  });
  assert.deepEqual(loopStatusFromFingerprint("abc123", current, false, 1), {
    state: "same-failure",
    previousFailureFingerprint: "abc123",
    currentFailureFingerprint: "abc123",
    sameFailureCount: 2,
    maxSameFailureCount: 3,
    stalled: false,
  });
  assert.deepEqual(loopStatusFromFingerprint("abc123", current, false, 2), {
    state: "same-failure",
    previousFailureFingerprint: "abc123",
    currentFailureFingerprint: "abc123",
    sameFailureCount: 3,
    maxSameFailureCount: 3,
    stalled: true,
  });
  assert.deepEqual(loopStatusFromFingerprint("abc123", current, false, 1, 2), {
    state: "same-failure",
    previousFailureFingerprint: "abc123",
    currentFailureFingerprint: "abc123",
    sameFailureCount: 2,
    maxSameFailureCount: 2,
    stalled: true,
  });
  assert.deepEqual(loopStatusFromFingerprint("old", current, false), {
    state: "new-failure",
    previousFailureFingerprint: "old",
    currentFailureFingerprint: "abc123",
    sameFailureCount: 1,
    maxSameFailureCount: 3,
    stalled: false,
  });
  assert.deepEqual(loopStatusFromFingerprint("abc123", undefined, true), {
    state: "resolved",
    previousFailureFingerprint: "abc123",
    currentFailureFingerprint: undefined,
    sameFailureCount: 0,
    maxSameFailureCount: 3,
    stalled: false,
  });
});

test("loopRecommendationFromStatus guides automated repair loops", () => {
  assert.deepEqual(loopRecommendationFromStatus({ state: "resolved" }), {
    action: "done",
    reason: "Verification passed.",
  });
  assert.deepEqual(loopRecommendationFromStatus({ state: "new-failure" }), {
    action: "continue",
    reason: "The previous failure changed; continue with the new repair focus.",
  });
  assert.deepEqual(loopRecommendationFromStatus({ state: "same-failure", sameFailureCount: 2, stalled: false }), {
    action: "change-strategy",
    reason: "The same failure is still present after a repair attempt.",
    nextStep: "Use repairPlan.readTargets and artifacts to choose a different fix strategy.",
  });
  assert.deepEqual(loopRecommendationFromStatus({ state: "same-failure", sameFailureCount: 3, stalled: true }), {
    action: "stop-or-escalate",
    reason: "The same failure has repeated 3 times.",
    nextStep: "Stop applying the same style of fix; inspect repairPlan evidence, sourceContext, and focusedSymbol before changing strategy.",
  });
});

test("loopTraceFromState summarizes the next automated verification step", () => {
  const nextToolCall = {
    tool: "swift_verify",
    arguments: {
      path: "/tmp/App",
      level: "build",
      previousFailureFingerprint: "abc123",
      previousSameFailureCount: 2,
      maxSameFailureCount: 3,
    },
    reason: "retry build",
  };

  assert.deepEqual(
    loopTraceFromState(
      {
        state: "same-failure",
        previousFailureFingerprint: "abc123",
        currentFailureFingerprint: "abc123",
        sameFailureCount: 2,
        maxSameFailureCount: 3,
        stalled: false,
      },
      {
        action: "change-strategy",
        reason: "The same failure is still present after a repair attempt.",
        nextStep: "Use repairPlan.readTargets and artifacts to choose a different fix strategy.",
      },
      { value: "abc123" },
      [nextToolCall]
    ),
    {
      state: "same-failure",
      attemptNumber: 2,
      maxSameFailureCount: 3,
      stalled: false,
      action: "change-strategy",
      fingerprint: "abc123",
      previousFingerprint: "abc123",
      nextToolCall,
      message: "Use repairPlan.readTargets and artifacts to choose a different fix strategy.",
    }
  );
});

test("strategyHintsFromState guides focused, repeated, and stalled repair loops", () => {
  const repairFocus = {
    action: "edit",
    target: {
      type: "file",
      file: "Sources/App/Broken.swift",
      line: 3,
    },
    message: "Cannot find missingValue in scope",
  };

  const focusedHints = strategyHintsFromState(
    { state: "untracked", sameFailureCount: 1, stalled: false },
    repairFocus
  );
  assert.equal(focusedHints[0].id, "apply-focused-repair");
  assert.equal(focusedHints[0].action, "edit");
  assert.equal(focusedHints[0].target.file, "Sources/App/Broken.swift");

  const repeatedHints = strategyHintsFromState(
    { state: "same-failure", sameFailureCount: 2, stalled: false },
    repairFocus
  );
  assert.equal(repeatedHints[0].id, "avoid-repeat-edit");
  assert.equal(repeatedHints[0].action, "change-strategy");

  const stalledHints = strategyHintsFromState(
    { state: "same-failure", sameFailureCount: 3, stalled: true },
    repairFocus,
    [{ file: "Sources/App/Broken.swift", sourcePath: "/tmp/App/Sources/App/Broken.swift", line: 3, focusedSymbol: { name: "add" } }],
    [{ kind: "diagnostics", contentKey: "errors" }]
  );
  assert.equal(stalledHints[0].id, "change-repair-strategy");
  assert.equal(stalledHints[0].priority, "high");
  assert.equal(stalledHints[1].id, "reread-source-context");
  assert.equal(stalledHints[1].targets[0].focusedSymbol, "add");
  assert.equal(stalledHints[2].id, "compare-failure-evidence");
  assert.equal(stalledHints[2].artifacts[0].kind, "diagnostics");
  assert.equal(stalledHints[3].id, "follow-inspection-order");
  assert.equal(stalledHints[3].inspectionOrder[0].kind, "source");

  assert.deepEqual(strategyHintsFromState({ state: "resolved" }, repairFocus), []);
});

test("inspectionOrderFromEvidence prioritizes source context before artifacts", () => {
  assert.deepEqual(
    inspectionOrderFromEvidence(
      [
        {
          file: "Sources/App/Broken.swift",
          sourcePath: "/tmp/App/Sources/App/Broken.swift",
          line: 3,
          focusedSymbol: { name: "add" },
          reason: "Cannot find missingValue in scope",
        },
      ],
      [
        { kind: "diagnostics", contentKey: "errors" },
        { kind: "command-output", contentKey: "rawOutput" },
      ]
    ),
    [
      {
        step: 1,
        kind: "source",
        action: "read-source-context",
        file: "/tmp/App/Sources/App/Broken.swift",
        line: 3,
        focusedSymbol: "add",
        reason: "Cannot find missingValue in scope",
      },
      {
        step: 2,
        kind: "artifact",
        action: "inspect-artifact",
        artifactKind: "diagnostics",
        path: undefined,
        contentKey: "errors",
        priority: "high",
        reason: "Compare the primary failure evidence against the attempted fix.",
      },
      {
        step: 3,
        kind: "artifact",
        action: "inspect-artifact",
        artifactKind: "command-output",
        path: undefined,
        contentKey: "rawOutput",
        priority: "normal",
        reason: "Inspect supporting evidence if the source context is inconclusive.",
      },
    ]
  );
});

test("nextInspectionActionsFromOrder materializes host-readable inspection actions", () => {
  assert.deepEqual(
    nextInspectionActionsFromOrder([
      {
        step: 1,
        kind: "source",
        file: "/tmp/App/Sources/App/Broken.swift",
        line: 3,
        focusedSymbol: "add",
        reason: "Inspect source",
      },
      {
        step: 2,
        kind: "artifact",
        artifactKind: "diagnostics",
        contentKey: "errors",
        reason: "Inspect diagnostics",
      },
      {
        step: 3,
        kind: "artifact",
        artifactKind: "runtime-log",
        path: "/tmp/App/runtime.log",
        reason: "Inspect runtime log",
      },
    ]),
    [
      {
        step: 1,
        action: "read-file",
        path: "/tmp/App/Sources/App/Broken.swift",
        line: 3,
        focusedSymbol: "add",
        reason: "Inspect source",
      },
      {
        step: 2,
        action: "inspect-inline-artifact",
        artifactKind: "diagnostics",
        contentKey: "errors",
        reason: "Inspect diagnostics",
      },
      {
        step: 3,
        action: "read-file",
        path: "/tmp/App/runtime.log",
        artifactKind: "runtime-log",
        reason: "Inspect runtime log",
      },
    ]
  );
});

test("repairHypothesesFromState proposes focused repair hypotheses", () => {
  const sourceAction = {
    step: 1,
    action: "read-file",
    path: "/tmp/App/Sources/App/Broken.swift",
    line: 3,
    focusedSymbol: "add",
    reason: "Inspect source",
  };

  const buildHypotheses = repairHypothesesFromState(
    {
      phase: "build",
      action: "edit",
      target: { type: "file", file: "Sources/App/Broken.swift", line: 3 },
      message: "Cannot find missingValue in scope",
    },
    { state: "untracked", sameFailureCount: 1, stalled: false },
    [],
    [sourceAction]
  );
  assert.equal(buildHypotheses[0].id, "build-diagnostic-direct-fix");
  assert.equal(buildHypotheses[0].confidence, "high");
  assert.equal(buildHypotheses[0].inspectFirst[0].path, "/tmp/App/Sources/App/Broken.swift");

  const stalledTestHypotheses = repairHypothesesFromState(
    {
      phase: "test",
      action: "edit",
      target: {
        type: "file",
        file: "Tests/AppTests/CalculatorTests.swift",
        line: 5,
        testName: "addReturnsWrongExpectation()",
      },
      message: "Expectation failed",
    },
    { state: "same-failure", sameFailureCount: 3, stalled: true },
    [],
    [sourceAction, { step: 2, action: "inspect-inline-artifact", artifactKind: "test-failures", contentKey: "failedTests" }]
  );
  assert.equal(stalledTestHypotheses[0].id, "test-failure-alternate-cause");
  assert.equal(stalledTestHypotheses[0].confidence, "medium");
  assert.equal(stalledTestHypotheses[0].inspectFirst.length, 2);

  assert.deepEqual(
    repairHypothesesFromState(
      { phase: "test", action: "add-tests", target: { type: "test-suite" }, message: "No runnable tests were found." },
      { state: "untracked" },
      [],
      []
    )[0].id,
    "missing-runnable-tests"
  );
});

test("selectedHypothesisFromState chooses the current repair hypothesis", () => {
  const direct = {
    id: "build-diagnostic-direct-fix",
    confidence: "high",
  };
  const alternate = {
    id: "build-diagnostic-alternate-cause",
    confidence: "medium",
  };

  assert.deepEqual(selectedHypothesisFromState([alternate, direct], { stalled: false }), {
    ...direct,
    selected: true,
    selectionReason: "Highest-confidence focused hypothesis for the current repair target.",
  });

  assert.deepEqual(selectedHypothesisFromState([direct, alternate], { stalled: true }), {
    ...alternate,
    selected: true,
    selectionReason: "The same failure is stalled; prefer an alternate-cause hypothesis before editing again.",
  });

  assert.equal(selectedHypothesisFromState([], { stalled: false }), undefined);
});

test("editGuardrailsFromHypothesis constrains automated edits", () => {
  const hypothesis = {
    id: "build-diagnostic-direct-fix",
    target: { type: "file", file: "Sources/App/Broken.swift", line: 3 },
    inspectFirst: [{ action: "read-file", path: "/tmp/App/Sources/App/Broken.swift", line: 3 }],
    editStrategy: "Make the smallest source edit that satisfies the compiler diagnostic without changing unrelated behavior.",
    verifyWith: "Run loopTrace.nextToolCall after applying the smallest fix.",
  };

  const normal = editGuardrailsFromHypothesis(hypothesis, { stalled: false });
  assert.equal(normal?.mode, "minimal-edit");
  assert.deepEqual(normal?.targetFiles, ["Sources/App/Broken.swift"]);
  assert.equal(normal?.mustInspectFirst[0].action, "read-file");
  assert.equal(normal?.avoid.includes("Do not rewrite unrelated code."), true);

  const stalled = editGuardrailsFromHypothesis(hypothesis, { stalled: true });
  assert.equal(stalled?.mode, "inspect-before-edit");
  assert.equal(stalled?.avoid.some((item) => /stalled fingerprint/.test(item)), true);
  assert.equal(editGuardrailsFromHypothesis(undefined, { stalled: false }), undefined);
});

test("postEditVerificationFromState requires the next focused verification", () => {
  const nextToolCall = {
    tool: "swift_verify",
    arguments: {
      path: "/tmp/App",
      level: "build",
      previousFailureFingerprint: "abc123",
      previousSameFailureCount: 1,
      maxSameFailureCount: 3,
    },
    reason: "retry build",
  };

  assert.deepEqual(
    postEditVerificationFromState(
      [nextToolCall],
      { value: "abc123" },
      { sameFailureCount: 1, maxSameFailureCount: 3, stalled: false },
      { mode: "minimal-edit" }
    ),
    {
      required: true,
      toolCall: nextToolCall,
      successCondition: "The verification rerun succeeds or reports a different failureFingerprint.",
      failureFingerprint: "abc123",
      previousSameFailureCount: 1,
      maxSameFailureCount: 3,
      guardrailMode: "minimal-edit",
      onSameFailure: "Increment previousSameFailureCount and choose a different repair strategy if the same fingerprint remains.",
    }
  );

  assert.equal(postEditVerificationFromState([], { value: "abc123" }), undefined);
});

test("repairLoopStateFromState summarizes the next orchestration decision", () => {
  const nextToolCall = {
    tool: "swift_verify",
    arguments: { path: "/tmp/App", level: "build" },
  };
  const postEditVerification = {
    required: true,
    toolCall: nextToolCall,
    failureFingerprint: "abc123",
  };

  const editable = repairLoopStateFromState(
    { state: "untracked", sameFailureCount: 1, maxSameFailureCount: 3, stalled: false, fingerprint: "abc123" },
    { action: "continue" },
    { state: "untracked", nextToolCall },
    { id: "build-diagnostic-direct-fix", confidence: "high" },
    { mode: "minimal-edit" },
    postEditVerification,
    [{ action: "read-file", path: "Sources/App/Broken.swift" }]
  );

  assert.equal(editable?.action, "edit");
  assert.equal(editable?.stalled, false);
  assert.equal(editable?.selectedHypothesisId, "build-diagnostic-direct-fix");
  assert.equal(editable?.guardrailMode, "minimal-edit");
  assert.deepEqual(editable?.postEditToolCall, nextToolCall);

  const stalled = repairLoopStateFromState(
    { state: "stalled", sameFailureCount: 3, maxSameFailureCount: 3, stalled: true, fingerprint: "abc123" },
    { action: "stop-or-escalate" },
    { state: "stalled", nextToolCall },
    { id: "build-diagnostic-alternate-cause", confidence: "medium" },
    { mode: "inspect-before-edit" },
    postEditVerification,
    [{ action: "inspect-inline-artifact", artifactKind: "diagnostics" }]
  );

  assert.equal(stalled?.action, "escalate");
  assert.equal(stalled?.stalled, true);
  assert.equal(stalled?.stopOrEscalate, true);
  assert.equal(stalled?.nextInspectionActions[0].action, "inspect-inline-artifact");
  assert.match(stalled?.summary, /Stop repeating edits/);
});

test("repairExecutionQueueFromState produces inspect/edit/verify or escalation steps", () => {
  const toolCall = {
    tool: "swift_verify",
    arguments: { path: "/tmp/App", level: "build" },
  };
  const editableQueue = repairExecutionQueueFromState(
    {
      action: "edit",
      nextInspectionActions: [{ action: "read-file", path: "Sources/App/Broken.swift" }],
    },
    { id: "build-diagnostic-direct-fix" },
    {
      mode: "minimal-edit",
      targetFiles: ["Sources/App/Broken.swift"],
      editStrategy: "Make the smallest compiler fix.",
      avoid: ["Do not rewrite unrelated code."],
    },
    {
      toolCall,
      successCondition: "The focused rerun succeeds.",
      onSameFailure: "Choose a different strategy.",
    }
  );

  assert.deepEqual(
    editableQueue.map((step) => step.action),
    ["inspect", "edit", "verify"]
  );
  assert.equal(editableQueue[0].target.path, "Sources/App/Broken.swift");
  assert.equal(editableQueue[0].sequence, 1);
  assert.equal(editableQueue[0].runPolicy, "read-only");
  assert.match(editableQueue[0].stopCondition, /contradicts/);
  assert.equal(editableQueue[1].hypothesisId, "build-diagnostic-direct-fix");
  assert.equal(editableQueue[1].sequence, 2);
  assert.equal(editableQueue[1].runPolicy, "single-minimal-edit");
  assert.match(editableQueue[1].stopCondition, /one focused edit/);
  assert.deepEqual(editableQueue[1].targetFiles, ["Sources/App/Broken.swift"]);
  assert.deepEqual(editableQueue[2].toolCall, toolCall);
  assert.equal(editableQueue[2].sequence, 3);
  assert.equal(editableQueue[2].runPolicy, "call-tool");
  assert.match(editableQueue[2].stopCondition, /different failureFingerprint/);

  const escalatedQueue = repairExecutionQueueFromState(
    {
      action: "escalate",
      fingerprint: "abc123",
      nextInspectionActions: [{ action: "inspect-inline-artifact", artifactKind: "diagnostics" }],
    },
    { id: "build-diagnostic-alternate-cause" },
    { mode: "inspect-before-edit" },
    { toolCall }
  );

  assert.deepEqual(
    escalatedQueue.map((step) => step.action),
    ["inspect", "escalate"]
  );
  assert.equal(escalatedQueue[1].fingerprint, "abc123");
  assert.equal(escalatedQueue[1].runPolicy, "manual-review");
  assert.match(escalatedQueue[1].stopCondition, /Always stop/);
});

test("repairNextStepFromQueue selects the next executable repair step", () => {
  const queue = [
    {
      sequence: 2,
      id: "apply-selected-edit",
      action: "edit",
      runPolicy: "single-minimal-edit",
      targetFiles: ["Sources/App/Broken.swift"],
      stopCondition: "Stop after one focused edit.",
    },
    {
      sequence: 1,
      id: "inspect-1",
      action: "inspect",
      runPolicy: "read-only",
      target: { action: "read-file", path: "Sources/App/Broken.swift" },
    },
    {
      sequence: 3,
      id: "verify-focused-rerun",
      action: "verify",
      runPolicy: "call-tool",
      toolCall: { tool: "swift_verify", arguments: { path: "/tmp/App", level: "build" } },
      stopCondition: "Stop on success.",
    },
  ];

  const first = repairNextStepFromQueue(queue);
  assert.equal(first.state, "ready");
  assert.equal(first.shouldStop, false);
  assert.equal(first.nextStep.id, "inspect-1");
  assert.equal(first.execution.shouldInspect, true);

  const edit = repairNextStepFromQueue(queue, ["inspect-1"]);
  assert.equal(edit.nextStep.id, "apply-selected-edit");
  assert.equal(edit.execution.shouldEdit, true);
  assert.deepEqual(edit.execution.targetFiles, ["Sources/App/Broken.swift"]);

  const verify = repairNextStepFromQueue(queue, ["inspect-1", "apply-selected-edit"]);
  assert.equal(verify.nextStep.id, "verify-focused-rerun");
  assert.equal(verify.execution.shouldCallTool, true);
  assert.equal(verify.execution.toolCall.tool, "swift_verify");

  const complete = repairNextStepFromQueue(queue, ["inspect-1", "apply-selected-edit", "verify-focused-rerun"]);
  assert.equal(complete.state, "complete");
  assert.equal(complete.shouldStop, true);

  const escalation = repairNextStepFromQueue([
    {
      sequence: 1,
      id: "stop-or-escalate",
      action: "escalate",
      runPolicy: "manual-review",
      instruction: "Stop automated edits.",
    },
  ]);
  assert.equal(escalation.state, "blocked-for-manual-review");
  assert.equal(escalation.shouldStop, true);
});

test("repairExecutionQueueFromPayload accepts verify, repairPlan, and hook payloads", () => {
  const queue = [{ sequence: 1, id: "verify-focused-rerun", action: "verify" }];

  assert.deepEqual(repairExecutionQueueFromPayload({ repairExecutionQueue: queue }), queue);
  assert.deepEqual(repairExecutionQueueFromPayload({ repairPlan: { repairExecutionQueue: queue } }), queue);
  assert.deepEqual(
    repairExecutionQueueFromPayload({ swiftPostEditVerification: { repairExecutionQueue: queue } }),
    queue
  );
  assert.deepEqual(repairExecutionQueueFromPayload({ repairPlan: {} }), []);
});

test("repairPlanFromVerificationResult turns repairFocus into read/edit/rerun targets", () => {
  const plan = repairPlanFromVerificationResult({
    success: false,
    failedPhase: "test",
    nextAction: "Fix failing test addReturnsWrongExpectation()",
    repairFocus: {
      phase: "test",
      action: "edit",
      target: {
        type: "file",
        file: "Tests/AppTests/CalculatorTests.swift",
        line: 5,
        testName: "addReturnsWrongExpectation()",
        testFilter: "addReturnsWrongExpectation",
      },
      evidence: {
        kind: "test-failures",
        storage: "inline",
        contentKey: "failedTests",
      },
      message: "Expectation failed",
    },
    recommendedNextRun: {
      tool: "swift_verify",
      arguments: { path: "/tmp/App", level: "test", testFilter: "addReturnsWrongExpectation" },
      reason: "Re-run only the first failing test after applying the fix.",
    },
    loopStatus: {
      state: "untracked",
      sameFailureCount: 1,
      maxSameFailureCount: 5,
      stalled: false,
    },
  });

  assert.equal(plan.schemaVersion, "swift-repair-plan/v1");
  assert.equal(plan.actionable, true);
  assert.equal(plan.failureFingerprint.algorithm, "sha256");
  assert.match(plan.failureFingerprint.value, /^[a-f0-9]{16}$/);
  assert.equal(plan.loopRecommendation.action, "continue");
  assert.equal(plan.loopTrace.state, "untracked");
  assert.equal(plan.loopTrace.attemptNumber, 1);
  assert.equal(plan.loopTrace.maxSameFailureCount, 5);
  assert.equal(plan.loopTrace.stalled, false);
  assert.equal(plan.loopTrace.action, "continue");
  assert.equal(plan.loopTrace.fingerprint, plan.failureFingerprint.value);
  assert.equal(plan.loopTrace.nextToolCall.tool, "swift_verify");
  assert.equal(plan.loopTrace.nextToolCall.arguments.previousFailureFingerprint, plan.failureFingerprint.value);
  assert.equal(plan.loopTrace.nextToolCall.arguments.maxSameFailureCount, 5);
  assert.equal(plan.strategyHints[0].id, "apply-focused-repair");
  assert.equal(plan.strategyHints[0].action, "edit");
  assert.equal(plan.strategyHints[0].target.testFilter, "addReturnsWrongExpectation");
  assert.equal(plan.inspectionOrder[0].kind, "source");
  assert.equal(plan.inspectionOrder[0].file, "Tests/AppTests/CalculatorTests.swift");
  assert.equal(plan.inspectionOrder[1].artifactKind, "test-failures");
  assert.equal(plan.inspectionOrder[1].priority, "high");
  assert.equal(plan.nextInspectionActions[0].action, "read-file");
  assert.equal(plan.nextInspectionActions[0].path, "Tests/AppTests/CalculatorTests.swift");
  assert.equal(plan.nextInspectionActions[1].action, "inspect-inline-artifact");
  assert.equal(plan.nextInspectionActions[1].artifactKind, "test-failures");
  assert.equal(plan.repairHypotheses[0].id, "test-failure-contract-mismatch");
  assert.equal(plan.repairHypotheses[0].inspectFirst[0].action, "read-file");
  assert.equal(plan.repairHypotheses[0].target.testFilter, "addReturnsWrongExpectation");
  assert.equal(plan.selectedHypothesis.id, "test-failure-contract-mismatch");
  assert.equal(plan.selectedHypothesis.selected, true);
  assert.equal(plan.editGuardrails.mode, "minimal-edit");
  assert.deepEqual(plan.editGuardrails.targetFiles, ["Tests/AppTests/CalculatorTests.swift"]);
  assert.equal(plan.postEditVerification.required, true);
  assert.equal(plan.postEditVerification.toolCall.tool, "swift_verify");
  assert.equal(plan.postEditVerification.guardrailMode, "minimal-edit");
  assert.equal(plan.repairLoopState.action, "edit");
  assert.equal(plan.repairLoopState.selectedHypothesisId, "test-failure-contract-mismatch");
  assert.equal(plan.repairLoopState.postEditToolCall.arguments.testFilter, "addReturnsWrongExpectation");
  assert.deepEqual(
    plan.repairExecutionQueue.map((step) => step.action),
    ["inspect", "inspect", "edit", "verify"]
  );
  assert.equal(plan.repairExecutionQueue[2].hypothesisId, "test-failure-contract-mismatch");
  assert.deepEqual(plan.readTargets, [
    {
      type: "file",
      file: "Tests/AppTests/CalculatorTests.swift",
      line: 5,
      column: undefined,
      reason: "Expectation failed",
    },
  ]);
  assert.deepEqual(plan.edits, [
    {
      type: "file",
      file: "Tests/AppTests/CalculatorTests.swift",
      line: 5,
      column: undefined,
      testName: "addReturnsWrongExpectation()",
      testFilter: "addReturnsWrongExpectation",
      instruction: "Expectation failed",
    },
  ]);
  assert.equal(plan.artifacts[0].kind, "test-failures");
  assert.equal(plan.rerun.tool, "swift_verify");
  assert.equal(plan.rerun.arguments.testFilter, "addReturnsWrongExpectation");
  assert.deepEqual(plan.commands, [
    {
      executable: "swift",
      args: ["test", "--filter", "addReturnsWrongExpectation"],
      cwd: "/tmp/App",
      timeoutMs: 300000,
    },
  ]);
  assert.deepEqual(plan.nextToolCalls, [
    {
      tool: "swift_verify",
      arguments: {
        path: "/tmp/App",
        level: "test",
        testFilter: "addReturnsWrongExpectation",
        includeRepairPlan: true,
        repairContextLines: 4,
        previousFailureFingerprint: plan.failureFingerprint.value,
        previousSameFailureCount: 1,
        maxSameFailureCount: 5,
      },
      reason: "Re-run only the first failing test after applying the fix.",
    },
  ]);
});

test("sourceExcerptForLine returns a bounded highlighted source window", () => {
  assert.deepEqual(sourceExcerptForLine("one\ntwo\nthree\nfour\nfive", 3, 1), {
    startLine: 2,
    endLine: 4,
    highlightLine: 3,
    text: "2: two\n3: three\n4: four",
    lines: [
      { number: 2, text: "two", highlight: false },
      { number: 3, text: "three", highlight: true },
      { number: 4, text: "four", highlight: false },
    ],
  });
});

test("swiftSymbolsInSource and focusedSwiftSymbol find nearby Swift declarations", () => {
  const source = [
    "public enum BrokenCalculator {",
    "    public static func add(_ lhs: Int, _ rhs: Int) -> Int {",
    "        lhs + missingValue",
    "    }",
    "}",
    "",
    "@Test func addReturnsWrongExpectation() {",
    "    #expect(false)",
    "}",
  ].join("\n");

  assert.deepEqual(swiftSymbolsInSource(source), [
    { kind: "enum", name: "BrokenCalculator", line: 1, text: "public enum BrokenCalculator {" },
    {
      kind: "func",
      name: "add",
      line: 2,
      text: "public static func add(_ lhs: Int, _ rhs: Int) -> Int {",
    },
    { kind: "func", name: "addReturnsWrongExpectation", line: 7, text: "@Test func addReturnsWrongExpectation() {" },
  ]);
  assert.deepEqual(focusedSwiftSymbol(source, 3), {
    kind: "func",
    name: "add",
    line: 2,
    text: "public static func add(_ lhs: Int, _ rhs: Int) -> Int {",
  });
  assert.deepEqual(focusedSwiftSymbol(source, 8), {
    kind: "func",
    name: "addReturnsWrongExpectation",
    line: 7,
    text: "@Test func addReturnsWrongExpectation() {",
  });
});

test("parseDiagnostics normalizes private tmp paths and filters by file", () => {
  const output = [
    "/private/tmp/MyApp/Sources/App/View.swift:12:8: error: cannot find 'foo' in scope",
    "/private/tmp/MyApp/Sources/App/Other.swift:3:1: warning: immutable value was never used",
  ].join("\n");

  const diagnostics = parseDiagnostics(output, "/tmp/MyApp", ["View.swift"]);

  assert.deepEqual(diagnostics, [
    {
      file: "Sources/App/View.swift",
      line: 12,
      column: 8,
      severity: "error",
      message: "cannot find 'foo' in scope",
    },
  ]);
});
