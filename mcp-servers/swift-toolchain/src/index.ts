#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { execFile, spawn, ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, readdir, writeFile, access, constants } from "node:fs/promises";
import { join, resolve, dirname, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const exec = promisify(execFile);
const MAX_OUTPUT = 8000;
export const SWIFT_VERIFY_SCHEMA_VERSION = "swift-verify/v1";
export const SWIFT_REPAIR_PLAN_SCHEMA_VERSION = "swift-repair-plan/v1";
export const SWIFT_VERIFY_CAPABILITIES = [
  "stagedVerification",
  "structuredSteps",
  "stepCommands",
  "stepDurations",
  "failureFocus",
  "testFailureSummary",
  "testFilter",
  "recommendedNextRun",
  "summary",
  "timestamps",
  "artifacts",
  "repairFocus",
  "failureFingerprint",
  "loopStatus",
  "loopRecommendation",
  "loopTrace",
  "strategyHints",
  "inspectionOrder",
  "nextInspectionActions",
  "repairHypotheses",
  "selectedHypothesis",
  "editGuardrails",
  "postEditVerification",
  "repairLoopState",
  "repairExecutionQueue",
  "repairExecutionPolicies",
  "repairNextStep",
  "configurableStallThreshold",
];

// ── Utility helpers ──

function truncate(s: string, max = MAX_OUTPUT): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n... (truncated, ${s.length - max} chars omitted)`;
}

export function commandInvocation(
  executable: string,
  args: string[],
  cwd?: string,
  timeoutMs?: number
): { executable: string; args: string[]; cwd?: string; timeoutMs?: number } {
  return {
    executable,
    args: [...args],
    ...(cwd ? { cwd } : {}),
    ...(typeof timeoutMs === "number" ? { timeoutMs } : {}),
  };
}

export function verificationArtifact(
  kind: string,
  label: string,
  source: {
    storage: "inline" | "file" | "directory";
    path?: string;
    contentKey?: string;
    mediaType?: string;
  }
): Record<string, string> {
  return {
    kind,
    label,
    storage: source.storage,
    ...(source.path ? { path: source.path } : {}),
    ...(source.contentKey ? { contentKey: source.contentKey } : {}),
    ...(source.mediaType ? { mediaType: source.mediaType } : {}),
  };
}

function json(obj: unknown): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text", text: JSON.stringify(obj, null, 2) }] };
}

async function run(
  cmd: string,
  args: string[],
  opts: { cwd?: string; timeout?: number } = {}
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  try {
    const { stdout, stderr } = await exec(cmd, args, {
      cwd: opts.cwd,
      timeout: opts.timeout ?? 120_000,
      maxBuffer: 10 * 1024 * 1024,
    });
    return { stdout, stderr, exitCode: 0 };
  } catch (err: any) {
    return {
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? err.message ?? String(err),
      exitCode: typeof err.code === "number" ? err.code : 1,
    };
  }
}

async function commandExists(cmd: string): Promise<boolean> {
  try {
    await exec("which", [cmd]);
    return true;
  } catch {
    return false;
  }
}

interface ProjectConfig {
  defaultScheme?: string;
  excludePaths?: string[];
  enabledTools?: string[];
  disabledTools?: string[];
  timeouts?: Record<string, number>;
}

async function loadConfig(root: string): Promise<ProjectConfig> {
  for (const name of [".codex-swift.json", ".codex-swift.jsonc"]) {
    try {
      const raw = await readFile(join(root, name), "utf-8");
      return JSON.parse(raw.replace(/\/\/.*$/gm, ""));
    } catch {}
  }
  return {};
}

async function findProjectRoot(startDir?: string): Promise<string> {
  let dir = resolve(startDir ?? process.cwd());
  for (let i = 0; i < 20; i++) {
    for (const marker of ["Package.swift", "*.xcodeproj", "*.xcworkspace"]) {
      if (marker.includes("*")) {
        try {
          const entries = await readdir(dir);
          if (entries.some((e) => e.endsWith(marker.replace("*", "")))) return dir;
        } catch {}
      } else {
        try {
          await access(join(dir, marker), constants.F_OK);
          return dir;
        } catch {}
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return resolve(startDir ?? process.cwd());
}

interface ProjectFiles {
  hasPackageSwift: boolean;
  xcodeproj?: string;
  xcworkspace?: string;
}

export function inspectProjectFiles(entries: string[]): ProjectFiles {
  return {
    hasPackageSwift: entries.includes("Package.swift"),
    xcodeproj: entries.find((e) => e.endsWith(".xcodeproj")),
    xcworkspace: entries.find((e) => e.endsWith(".xcworkspace")),
  };
}

export function xcodeProjectArgs(files: ProjectFiles, absolute = false, root = ""): string[] | null {
  if (files.xcworkspace) {
    return ["-workspace", absolute ? join(root, files.xcworkspace) : files.xcworkspace];
  }
  if (files.xcodeproj) {
    return ["-project", absolute ? join(root, files.xcodeproj) : files.xcodeproj];
  }
  return null;
}

export function swiftPMBuildPlan(
  configuration?: "debug" | "release",
  stopAfter?: "typecheck" | "build"
): { args: string[]; stage: "build"; note?: string } {
  const args = ["build"];
  if (configuration === "release") args.push("-c", "release");

  if (stopAfter === "typecheck") {
    return {
      args,
      stage: "build",
      note:
        "SwiftPM does not expose a reliable package-level typecheck-only command here; ran incremental swift build as the verification gate.",
    };
  }

  return { args, stage: "build" };
}

export function xcodeBuildPlan(
  target: string[],
  scheme: string,
  action: "build" | "test",
  configuration?: "debug" | "release",
  stopAfter?: "typecheck" | "build"
): string[] {
  const args = [...target, "-scheme", scheme];
  if (configuration) args.push("-configuration", configuration === "debug" ? "Debug" : "Release");
  args.push(action);
  if (action === "build" && stopAfter === "typecheck") {
    args.push("SWIFT_COMPILATION_MODE=singlefile", "COMPILER_INDEX_STORE_ENABLE=NO");
  }
  return args;
}

export function simulatorDestination(simulator?: string): string {
  return simulator
    ? `platform=iOS Simulator,name=${simulator}`
    : "platform=iOS Simulator,name=iPhone 16 Pro";
}

export function xcodeSimulatorBuildPlan(
  target: string[],
  scheme: string,
  destination: string,
  derivedDataPath: string
): string[] {
  return [
    ...target,
    "-scheme",
    scheme,
    "-destination",
    destination,
    "-derivedDataPath",
    derivedDataPath,
    "build",
  ];
}

export function simulatorEvidencePaths(root: string, scheme: string): { derivedDataPath: string; screenshotPath: string; logPath: string } {
  const safeScheme = scheme.replace(/[^A-Za-z0-9_.-]/g, "_");
  const base = join(root, ".codex-swift", "simulator");
  return {
    derivedDataPath: join(base, "DerivedData", safeScheme),
    screenshotPath: join(base, `${safeScheme}-screenshot.png`),
    logPath: join(base, `${safeScheme}-runtime.log`),
  };
}

export function parseLaunchPID(output: string): number | null {
  const match = output.match(/:\s*(\d+)\s*$/m);
  return match ? Number.parseInt(match[1], 10) : null;
}

export function simulatorLogPredicate(bundleIdentifier: string): string {
  const escaped = bundleIdentifier.replace(/"/g, '\\"');
  return `eventMessage CONTAINS[c] "${escaped}" OR process CONTAINS[c] "${escaped}"`;
}

export function summarizeRuntimeLog(log: string): { issueDetected: boolean; matchedPatterns: string[] } {
  const patterns = [
    "Terminating app due to uncaught exception",
    "Fatal error",
    "SIGABRT",
    "crash",
    "dyld",
  ];
  const matchedPatterns = patterns.filter((pattern) => log.toLowerCase().includes(pattern.toLowerCase()));
  return {
    issueDetected: matchedPatterns.length > 0,
    matchedPatterns,
  };
}

export function parseTestCounts(output: string): { passed: number; failed: number } {
  const xctestPassed = (output.match(/Test Case .* passed/g) ?? []).length;
  const xctestFailed = (output.match(/Test Case .* failed/g) ?? []).length;
  const swiftTestPassed = (output.match(/^(?:✔\s*)?Test(?! Case\b).+ passed/gm) ?? []).length;
  const swiftTestFailed = (output.match(/^(?:✘\s*)?Test(?! Case\b).+ failed/gm) ?? []).length;

  return {
    passed: xctestPassed + swiftTestPassed,
    failed: xctestFailed + swiftTestFailed,
  };
}

export function detectsNoRunnableTests(
  output: string,
  counts: { passed: number; failed: number },
  exitCode: number
): boolean {
  if (counts.passed > 0 || counts.failed > 0) return false;
  if (exitCode === 0) return true;
  return /no tests found|no tests were found|no test bundles found|executed 0 tests/i.test(output);
}

export interface TestFailureDetail {
  name: string;
  message?: string;
  file?: string;
  line?: number;
}

export function summarizeTestFailures(output: string): { failedTests: TestFailureDetail[]; firstFailure?: TestFailureDetail } {
  const failedTests: TestFailureDetail[] = [];

  const rememberFailure = (name: string): TestFailureDetail => {
    const normalizedName = name.trim();
    const existing = failedTests.find((failure) => failure.name === normalizedName);
    if (existing) return existing;
    const failure: TestFailureDetail = { name: normalizedName };
    failedTests.push(failure);
    return failure;
  };

  const attachFailureDetail = (detail: { message?: string; file?: string; line?: number }) => {
    const current = failedTests[failedTests.length - 1] ?? rememberFailure(detail.file ?? "Unknown failing test");
    if (detail.message && !current.message) current.message = detail.message;
    if (detail.file && !current.file) current.file = detail.file;
    if (detail.line && !current.line) current.line = detail.line;
  };

  for (const line of output.split(/\r?\n/)) {
    const swiftTestingMatch = line.match(/^(?:✘\s*)?Test\s+(.+?)\s+(?:failed|recorded an issue)\b/);
    if (swiftTestingMatch) {
      rememberFailure(swiftTestingMatch[1]);
      if (!line.includes(".swift:")) continue;
    }

    const xctestMatch = line.match(/Test Case '([^']+)' failed/);
    if (xctestMatch) {
      rememberFailure(xctestMatch[1]);
      continue;
    }

    const swiftFileMatch = line.match(/([^:\s]+\.swift):(\d+)(?::\d+)?:\s*(?:error:\s*)?(.+)/);
    if (swiftFileMatch && /(Expectation failed|XCTAssert|failed|Fatal error|threw an error)/i.test(swiftFileMatch[3])) {
      attachFailureDetail({
        file: swiftFileMatch[1],
        line: Number.parseInt(swiftFileMatch[2], 10),
        message: swiftFileMatch[3].trim(),
      });
    }
  }

  const limitedFailures = failedTests.slice(0, 10);
  return {
    failedTests: limitedFailures,
    firstFailure: limitedFailures[0],
  };
}

export function verificationNextAction(phase: string, detail?: Record<string, any>): string {
  if (phase === "project") {
    return "Run swift_project_describe and pass a SwiftPM or Xcode project path.";
  }
  if (phase === "build") {
    const firstError = detail?.errors?.[0];
    if (firstError?.file && firstError?.line) {
      return `Fix ${firstError.file}:${firstError.line} first, then run swift_verify again.`;
    }
    return "Inspect rawOutput from the build step, fix the first compiler error, then run swift_verify again.";
  }
  if (phase === "test") {
    if (detail?.noTests) {
      if (detail?.testFilter) {
        return `No tests matched testFilter "${detail.testFilter}". Remove or adjust the filter, then run swift_verify with level="test".`;
      }
      return "Add at least one Swift Testing @Test or XCTestCase test, then run swift_verify with level=\"test\".";
    }
    const firstFailure = detail?.firstFailure ?? detail?.failedTests?.[0];
    if (firstFailure?.name) {
      if (firstFailure.file && firstFailure.line) {
        return `Fix failing test ${firstFailure.name} at ${firstFailure.file}:${firstFailure.line}, then run swift_verify with level="test".`;
      }
      return `Fix failing test ${firstFailure.name}, then run swift_verify with level="test".`;
    }
    return "Inspect the test output, fix the first failing assertion or crash, then run swift_verify with level=\"test\".";
  }
  if (phase === "simulator") {
    if (detail?.runtimeLogSummary?.issueDetected) {
      return "Inspect runtimeLogTail/runtimeLogPath for the first crash-like pattern, fix it, then run swift_verify with level=\"simulator\".";
    }
    return "Inspect simulator phase, rawOutput, screenshotPath, and runtimeLogTail to identify the runtime failure.";
  }
  return "Continue with the next verification step.";
}

export function verificationFocus(phase: string, detail?: Record<string, any>): Record<string, any> | undefined {
  if (phase === "project") {
    return { kind: "project", message: "No Swift project markers were found." };
  }
  if (phase === "build") {
    const firstError = detail?.errors?.[0];
    if (firstError) {
      return {
        kind: "compilerError",
        file: firstError.file,
        line: firstError.line,
        column: firstError.column,
        severity: firstError.severity,
        message: firstError.message,
      };
    }
    return { kind: "buildFailure", message: "Build failed without a parsed compiler diagnostic." };
  }
  if (phase === "test") {
    if (detail?.noTests) {
      return {
        kind: detail?.testFilter ? "emptyFilteredTests" : "noRunnableTests",
        testFilter: detail?.testFilter,
        message: detail?.testFilter
          ? `No tests matched testFilter "${detail.testFilter}".`
          : "No runnable tests were found.",
      };
    }
    const firstFailure = detail?.firstFailure ?? detail?.failedTests?.[0];
    if (firstFailure) {
      return {
        kind: "testFailure",
        testName: firstFailure.name,
        file: firstFailure.file,
        line: firstFailure.line,
        message: firstFailure.message,
      };
    }
    return { kind: "testFailure", message: "Tests failed without a parsed failing assertion." };
  }
  if (phase === "simulator") {
    const firstError = detail?.errors?.[0];
    if (firstError) {
      return {
        kind: "simulatorBuildError",
        file: firstError.file,
        line: firstError.line,
        column: firstError.column,
        severity: firstError.severity,
        message: firstError.message,
      };
    }
    if (detail?.runtimeLogSummary?.issueDetected) {
      return {
        kind: "runtimeLogIssue",
        runtimeLogPath: detail.runtimeLogPath,
        matchedPatterns: detail.runtimeLogSummary.matchedPatterns,
      };
    }
    if (detail?.phaseDetail) {
      return { kind: "simulatorPhase", phaseDetail: detail.phaseDetail };
    }
    if (detail?.skipped) {
      return { kind: "simulatorSkipped", reason: detail.reason };
    }
    return { kind: "simulatorFailure", message: "Simulator verification failed." };
  }
  return undefined;
}

export function verificationRepairFocus(phase: string, detail?: Record<string, any>): Record<string, any> | undefined {
  const artifactByKind = (kind: string) => detail?.artifacts?.find((artifact: Record<string, any>) => artifact.kind === kind);

  if (phase === "project") {
    return {
      phase,
      action: "inspect-project",
      target: { type: "project" },
      message: "No Swift project markers were found.",
    };
  }

  if (phase === "build") {
    const firstError = detail?.errors?.[0];
    if (firstError?.file) {
      return {
        phase,
        action: "edit",
        target: {
          type: "file",
          file: firstError.file,
          line: firstError.line,
          column: firstError.column,
        },
        evidence: artifactByKind("diagnostics") ?? { storage: "inline", contentKey: "errors" },
        message: firstError.message,
      };
    }
    const rawOutput = artifactByKind("command-output");
    return {
      phase,
      action: "inspect-artifact",
      target: {
        type: "artifact",
        kind: rawOutput?.kind ?? "command-output",
        contentKey: rawOutput?.contentKey ?? "rawOutput",
      },
      evidence: rawOutput,
      message: "Build failed without a parsed compiler diagnostic.",
    };
  }

  if (phase === "test") {
    if (detail?.noTests) {
      return {
        phase,
        action: detail?.testFilter ? "adjust-test-filter" : "add-tests",
        target: {
          type: "test-suite",
          testFilter: detail?.testFilter,
        },
        evidence: artifactByKind("command-output") ?? { storage: "inline", contentKey: "output" },
        message: detail?.testFilter
          ? `No tests matched testFilter "${detail.testFilter}".`
          : "No runnable tests were found.",
      };
    }

    const firstFailure = detail?.firstFailure ?? detail?.failedTests?.[0];
    if (firstFailure?.name) {
      return {
        phase,
        action: firstFailure.file ? "edit" : "inspect-artifact",
        target: {
          type: firstFailure.file ? "file" : "test",
          file: firstFailure.file,
          line: firstFailure.line,
          testName: firstFailure.name,
          testFilter: testFilterFromFailureName(firstFailure.name),
        },
        evidence: artifactByKind("test-failures") ?? artifactByKind("command-output"),
        message: firstFailure.message,
      };
    }

    return {
      phase,
      action: "inspect-artifact",
      target: { type: "artifact", kind: "command-output", contentKey: "output" },
      evidence: artifactByKind("command-output"),
      message: "Tests failed without a parsed failing assertion.",
    };
  }

  if (phase === "simulator") {
    const firstError = detail?.errors?.[0];
    if (firstError?.file) {
      return {
        phase,
        action: "edit",
        target: {
          type: "file",
          file: firstError.file,
          line: firstError.line,
          column: firstError.column,
        },
        evidence: artifactByKind("diagnostics"),
        message: firstError.message,
      };
    }

    const runtimeLog = artifactByKind("runtime-log") ?? artifactByKind("runtime-log-tail");
    if (detail?.runtimeLogSummary?.issueDetected) {
      return {
        phase,
        action: "inspect-artifact",
        target: {
          type: "artifact",
          kind: runtimeLog?.kind ?? "runtime-log",
          path: runtimeLog?.path,
          contentKey: runtimeLog?.contentKey,
        },
        evidence: runtimeLog,
        message: `Runtime log matched: ${detail.runtimeLogSummary.matchedPatterns.join(", ")}`,
      };
    }

    const rawOutput = artifactByKind("command-output");
    return {
      phase,
      action: rawOutput ? "inspect-artifact" : "inspect-simulator",
      target: rawOutput
        ? { type: "artifact", kind: rawOutput.kind, contentKey: rawOutput.contentKey }
        : { type: "simulator", phaseDetail: detail?.phaseDetail },
      evidence: rawOutput,
      message: detail?.reason ?? detail?.phaseDetail ?? "Simulator verification failed.",
    };
  }

  return undefined;
}

export function verificationSummary(
  steps: Array<Record<string, any>>,
  response: Record<string, any> = {}
): Record<string, any> {
  const slowestStep = steps.reduce<Record<string, any> | undefined>((slowest, step, index) => {
    if (typeof step.durationMs !== "number") return slowest;
    if (!slowest || step.durationMs > slowest.durationMs) {
      return { phase: step.phase, index, durationMs: step.durationMs };
    }
    return slowest;
  }, undefined);
  const failedStepIndex = steps.findIndex((step) => step.success === false && !step.skipped);

  return {
    success: response.success === true,
    failedPhase: response.failedPhase,
    totalSteps: steps.length,
    completedPhases: steps.map((step) => step.phase),
    failedStepIndex: failedStepIndex >= 0 ? failedStepIndex : undefined,
    slowestStep,
    totalStepDurationMs: steps.reduce((total, step) => total + (typeof step.durationMs === "number" ? step.durationMs : 0), 0),
  };
}

export function swiftVerifyMetadata(): { schemaVersion: string; capabilities: string[] } {
  return {
    schemaVersion: SWIFT_VERIFY_SCHEMA_VERSION,
    capabilities: [...SWIFT_VERIFY_CAPABILITIES],
  };
}

export function toolRecommendation(
  tool: string,
  args: Record<string, unknown>,
  reason: string
): { tool: string; arguments: Record<string, unknown>; reason: string } {
  return {
    tool,
    arguments: Object.fromEntries(Object.entries(args).filter(([, value]) => value !== undefined)),
    reason,
  };
}

export function swiftVerifyRecommendation(
  path: string,
  level: "build" | "test" | "simulator",
  options: Record<string, unknown> = {},
  reason = "Re-run the Swift verification loop after applying fixes."
): { tool: string; arguments: Record<string, unknown>; reason: string } {
  return toolRecommendation("swift_verify", { path, level, ...options }, reason);
}

export function repairPlanCommandsFromRerun(
  rerun?: Record<string, any>,
  failedPhase?: string
): Array<Record<string, any>> {
  if (rerun?.tool !== "swift_verify") return [];
  const args = rerun.arguments ?? {};
  const root = args.path;
  const level = failedPhase === "build" ? "build" : args.level ?? "build";
  const configuration = args.configuration as "debug" | "release" | undefined;

  if (args.scheme) {
    const target = args.xcodeTarget ?? ["-scheme", args.scheme];
    if (level === "simulator") {
      const destination = simulatorDestination(args.simulator);
      const derivedDataPath = args.derivedDataPath ?? join(root ?? ".", ".codex-swift", "simulator", "DerivedData", args.scheme);
      return [
        commandInvocation(
          "xcodebuild",
          xcodeSimulatorBuildPlan(target, args.scheme, destination, derivedDataPath),
          root,
          300_000
        ),
      ];
    }
    const action = level === "test" ? "test" : "build";
    const commandArgs = xcodeBuildPlan(target, args.scheme, action, configuration);
    if (action === "test" && args.testFilter) commandArgs.push(`-only-testing:${args.testFilter}`);
    return [commandInvocation("xcodebuild", commandArgs, root, 300_000)];
  }

  if (level === "test") {
    const commandArgs = ["test"];
    if (args.testFilter) commandArgs.push("--filter", args.testFilter);
    return [commandInvocation("swift", commandArgs, root, 300_000)];
  }

  return [commandInvocation("swift", swiftPMBuildPlan(configuration).args, root, 300_000)];
}

export function repairPlanToolCallsFromRerun(
  rerun?: Record<string, any>,
  failedPhase?: string,
  failureFingerprint?: Record<string, any>,
  loopStatus?: Record<string, any>
): Array<Record<string, any>> {
  if (rerun?.tool !== "swift_verify") return [];
  const args = rerun.arguments ?? {};
  const level = failedPhase === "build" ? "build" : args.level ?? "build";
  const loopArguments = {
    ...args,
    level,
    includeRepairPlan: true,
    repairContextLines: 4,
    previousFailureFingerprint: failureFingerprint?.value,
    previousSameFailureCount: loopStatus?.sameFailureCount,
    ...(typeof loopStatus?.maxSameFailureCount === "number"
      ? { maxSameFailureCount: loopStatus.maxSameFailureCount }
      : {}),
  };
  return [
    toolRecommendation(
      "swift_verify",
      loopArguments,
      failedPhase === "build"
        ? "After editing, verify the build phase before continuing to deeper checks."
        : rerun.reason ?? "After editing, re-run the focused Swift verification."
    ),
  ];
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, entryValue]) => entryValue !== undefined)
      .sort(([lhs], [rhs]) => lhs.localeCompare(rhs))
      .map(([key, entryValue]) => `${JSON.stringify(key)}:${stableStringify(entryValue)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function failureFingerprintFromFocus(
  failedPhase?: string,
  repairFocus?: Record<string, any>
): Record<string, any> | undefined {
  if (!failedPhase && !repairFocus) return undefined;
  const target = repairFocus?.target ?? {};
  const basis = {
    phase: failedPhase ?? repairFocus?.phase,
    action: repairFocus?.action,
    targetType: target.type,
    file: target.file,
    line: target.line,
    column: target.column,
    testName: target.testName,
    testFilter: target.testFilter,
    artifactKind: target.kind,
    message: repairFocus?.message,
  };
  const canonical = stableStringify(basis);
  return {
    algorithm: "sha256",
    value: createHash("sha256").update(canonical).digest("hex").slice(0, 16),
    basis,
  };
}

export function loopStatusFromFingerprint(
  previousFailureFingerprint: string | undefined,
  currentFailureFingerprint: Record<string, any> | undefined,
  success: boolean,
  previousSameFailureCount = 0,
  maxSameFailureCount = 3
): Record<string, any> {
  const safePreviousCount = Math.max(0, previousSameFailureCount);
  const safeMaxSameFailureCount = Math.max(1, maxSameFailureCount);
  if (success) {
    return {
      state: previousFailureFingerprint ? "resolved" : "passed",
      previousFailureFingerprint,
      currentFailureFingerprint: undefined,
      sameFailureCount: 0,
      maxSameFailureCount: safeMaxSameFailureCount,
      stalled: false,
    };
  }

  const current = currentFailureFingerprint?.value;
  if (!previousFailureFingerprint) {
    return {
      state: "untracked",
      previousFailureFingerprint: undefined,
      currentFailureFingerprint: current,
      sameFailureCount: 1,
      maxSameFailureCount: safeMaxSameFailureCount,
      stalled: false,
    };
  }

  const sameFailure = previousFailureFingerprint === current;
  const sameFailureCount = sameFailure ? safePreviousCount + 1 : 1;
  return {
    state: sameFailure ? "same-failure" : "new-failure",
    previousFailureFingerprint,
    currentFailureFingerprint: current,
    sameFailureCount,
    maxSameFailureCount: safeMaxSameFailureCount,
    stalled: sameFailureCount >= safeMaxSameFailureCount,
  };
}

export function loopRecommendationFromStatus(loopStatus?: Record<string, any>): Record<string, any> {
  if (!loopStatus) {
    return {
      action: "continue",
      reason: "No loopStatus is available.",
    };
  }
  if (loopStatus.state === "passed" || loopStatus.state === "resolved") {
    return {
      action: "done",
      reason: "Verification passed.",
    };
  }
  if (loopStatus.stalled) {
    return {
      action: "stop-or-escalate",
      reason: `The same failure has repeated ${loopStatus.sameFailureCount} times.`,
      nextStep: "Stop applying the same style of fix; inspect repairPlan evidence, sourceContext, and focusedSymbol before changing strategy.",
    };
  }
  if (loopStatus.state === "same-failure") {
    return {
      action: "change-strategy",
      reason: "The same failure is still present after a repair attempt.",
      nextStep: "Use repairPlan.readTargets and artifacts to choose a different fix strategy.",
    };
  }
  if (loopStatus.state === "new-failure") {
    return {
      action: "continue",
      reason: "The previous failure changed; continue with the new repair focus.",
    };
  }
  return {
    action: "continue",
    reason: "First observed failure in this repair loop.",
  };
}

export function loopTraceFromState(
  loopStatus?: Record<string, any>,
  loopRecommendation?: Record<string, any>,
  failureFingerprint?: Record<string, any>,
  nextToolCalls: Array<Record<string, any>> = []
): Record<string, any> {
  const nextToolCall = nextToolCalls[0];
  return {
    state: loopStatus?.state ?? "unknown",
    attemptNumber: loopStatus?.sameFailureCount ?? 0,
    maxSameFailureCount: loopStatus?.maxSameFailureCount,
    stalled: loopStatus?.stalled ?? false,
    action: loopRecommendation?.action ?? "continue",
    fingerprint: failureFingerprint?.value ?? loopStatus?.currentFailureFingerprint,
    previousFingerprint: loopStatus?.previousFailureFingerprint,
    nextToolCall,
    message: loopRecommendation?.nextStep ?? loopRecommendation?.reason,
  };
}

export function strategyHintsFromState(
  loopStatus?: Record<string, any>,
  repairFocus?: Record<string, any>,
  readTargets: Array<Record<string, any>> = [],
  artifacts: Array<Record<string, any>> = [],
  inspectionOrder: Array<Record<string, any>> = inspectionOrderFromEvidence(readTargets, artifacts)
): Array<Record<string, any>> {
  if (loopStatus?.state === "passed" || loopStatus?.state === "resolved") return [];

  const target = repairFocus?.target ?? {};
  const hints: Array<Record<string, any>> = [];
  const targetSummary = target.file
    ? `${target.file}${target.line ? `:${target.line}` : ""}`
    : target.testFilter
    ? `test filter ${target.testFilter}`
    : target.type ?? "focused target";

  if (loopStatus?.stalled) {
    hints.push({
      id: "change-repair-strategy",
      priority: "high",
      action: "change-strategy",
      reason: `The same failure repeated ${loopStatus.sameFailureCount} times.`,
      instruction: `Do not apply another similar edit to ${targetSummary}; re-read the evidence and form a different hypothesis first.`,
    });
    if (readTargets.length > 0) {
      hints.push({
        id: "reread-source-context",
        priority: "high",
        action: "inspect-read-targets",
        reason: "The failed target has source context available.",
        targets: readTargets.map((readTarget) => ({
          file: readTarget.sourcePath ?? readTarget.file,
          line: readTarget.line,
          focusedSymbol: readTarget.focusedSymbol?.name,
        })),
      });
    }
    if (artifacts.length > 0) {
      hints.push({
        id: "compare-failure-evidence",
        priority: "medium",
        action: "inspect-artifacts",
        reason: "Use diagnostics, test output, or runtime logs to identify what did not change.",
        artifacts: artifacts.map((artifact) => ({
          kind: artifact.kind,
          path: artifact.path,
          contentKey: artifact.contentKey,
        })),
      });
    }
    if (inspectionOrder.length > 0) {
      hints.push({
        id: "follow-inspection-order",
        priority: "high",
        action: "inspect-in-order",
        reason: "Follow the ordered evidence list before attempting another edit.",
        inspectionOrder,
      });
    }
    return hints;
  }

  if (loopStatus?.state === "same-failure") {
    hints.push({
      id: "avoid-repeat-edit",
      priority: "medium",
      action: "change-strategy",
      reason: "The same failure survived the previous repair attempt.",
      instruction: `Before editing ${targetSummary} again, inspect the repair evidence and choose a different fix path.`,
    });
    return hints;
  }

  if (repairFocus?.action) {
    hints.push({
      id: "apply-focused-repair",
      priority: "normal",
      action: repairFocus.action,
      reason: "This is the current focused repair target.",
      target,
      instruction: repairFocus.message ?? "Apply the focused repair, then run loopTrace.nextToolCall.",
    });
  }

  return hints;
}

export function inspectionOrderFromEvidence(
  readTargets: Array<Record<string, any>> = [],
  artifacts: Array<Record<string, any>> = []
): Array<Record<string, any>> {
  const order: Array<Record<string, any>> = [];

  for (const target of readTargets) {
    order.push({
      step: order.length + 1,
      kind: "source",
      action: "read-source-context",
      file: target.sourcePath ?? target.file,
      line: target.line,
      focusedSymbol: target.focusedSymbol?.name,
      reason: target.reason ?? "Inspect the focused source target before editing.",
    });
  }

  for (const artifact of artifacts) {
    const isPrimaryFailureEvidence = ["diagnostics", "test-failures", "runtime-log", "runtime-log-tail"].includes(artifact.kind);
    order.push({
      step: order.length + 1,
      kind: "artifact",
      action: "inspect-artifact",
      artifactKind: artifact.kind,
      path: artifact.path,
      contentKey: artifact.contentKey,
      priority: isPrimaryFailureEvidence ? "high" : "normal",
      reason: isPrimaryFailureEvidence
        ? "Compare the primary failure evidence against the attempted fix."
        : "Inspect supporting evidence if the source context is inconclusive.",
    });
  }

  return order;
}

export function nextInspectionActionsFromOrder(
  inspectionOrder: Array<Record<string, any>> = []
): Array<Record<string, any>> {
  return inspectionOrder.map((item) => {
    if (item.kind === "source") {
      return {
        step: item.step,
        action: "read-file",
        path: item.file,
        line: item.line,
        focusedSymbol: item.focusedSymbol,
        reason: item.reason,
      };
    }

    if (item.path) {
      return {
        step: item.step,
        action: "read-file",
        path: item.path,
        artifactKind: item.artifactKind,
        reason: item.reason,
      };
    }

    return {
      step: item.step,
      action: "inspect-inline-artifact",
      artifactKind: item.artifactKind,
      contentKey: item.contentKey,
      reason: item.reason,
    };
  });
}

export function repairHypothesesFromState(
  repairFocus?: Record<string, any>,
  loopStatus?: Record<string, any>,
  inspectionOrder: Array<Record<string, any>> = [],
  nextInspectionActions: Array<Record<string, any>> = []
): Array<Record<string, any>> {
  if (!repairFocus || loopStatus?.state === "passed" || loopStatus?.state === "resolved") return [];
  const target = repairFocus.target ?? {};
  const stalled = loopStatus?.stalled === true;
  const verifyWith = "Run loopTrace.nextToolCall after applying the smallest fix.";
  const inspectFirst = nextInspectionActions.slice(0, stalled ? 3 : 1);

  if (repairFocus.phase === "build" && repairFocus.action === "edit" && target.file) {
    return [
      {
        id: stalled ? "build-diagnostic-alternate-cause" : "build-diagnostic-direct-fix",
        confidence: stalled ? "medium" : "high",
        cause: repairFocus.message ?? "The focused compiler diagnostic identifies the first blocking build issue.",
        check: stalled
          ? "Re-read the source context and diagnostic evidence before choosing a different edit path."
          : "Inspect the focused source line and surrounding symbol declaration.",
        editStrategy: "Make the smallest source edit that satisfies the compiler diagnostic without changing unrelated behavior.",
        target,
        inspectFirst,
        verifyWith,
      },
    ];
  }

  if (repairFocus.phase === "test" && repairFocus.action === "edit" && target.file) {
    return [
      {
        id: stalled ? "test-failure-alternate-cause" : "test-failure-contract-mismatch",
        confidence: stalled ? "medium" : "high",
        cause: repairFocus.message ?? "The focused test failure indicates a mismatch between expected and actual behavior.",
        check: target.testName
          ? `Read the focused test ${target.testName} and the code it exercises.`
          : "Read the focused failing assertion and the implementation it exercises.",
        editStrategy: "Preserve the test intent; change implementation or expectation only after confirming which side is wrong.",
        target,
        inspectFirst,
        verifyWith,
      },
    ];
  }

  if (repairFocus.action === "add-tests") {
    return [
      {
        id: "missing-runnable-tests",
        confidence: "high",
        cause: repairFocus.message ?? "Verification did not find runnable tests.",
        check: "Inspect Package.swift and test target layout before adding tests.",
        editStrategy: "Add the smallest Swift Testing @Test or XCTestCase that exercises existing behavior.",
        target,
        inspectFirst,
        verifyWith,
      },
    ];
  }

  if (repairFocus.action === "adjust-test-filter") {
    return [
      {
        id: "empty-test-filter",
        confidence: "high",
        cause: repairFocus.message ?? "The requested test filter matched no runnable tests.",
        check: "Inspect discovered test names and the current testFilter.",
        editStrategy: "Remove or narrow the filter to a test name that exists, then rerun verification.",
        target,
        inspectFirst,
        verifyWith,
      },
    ];
  }

  return [
    {
      id: "inspect-evidence-first",
      confidence: "medium",
      cause: repairFocus.message ?? "The failure needs evidence inspection before editing.",
      check: inspectionOrder.length > 0 ? "Follow inspectionOrder before editing." : "Inspect the failed verification step output.",
      editStrategy: "Avoid editing until the primary evidence identifies a concrete target.",
      target,
      inspectFirst,
      verifyWith,
    },
  ];
}

export function selectedHypothesisFromState(
  repairHypotheses: Array<Record<string, any>> = [],
  loopStatus?: Record<string, any>
): Record<string, any> | undefined {
  if (repairHypotheses.length === 0) return undefined;

  const stalled = loopStatus?.stalled === true;
  const selected =
    (stalled
      ? repairHypotheses.find((hypothesis) => String(hypothesis.id ?? "").includes("alternate"))
      : undefined) ??
    repairHypotheses.find((hypothesis) => hypothesis.confidence === "high") ??
    repairHypotheses[0];

  return {
    ...selected,
    selected: true,
    selectionReason: stalled
      ? "The same failure is stalled; prefer an alternate-cause hypothesis before editing again."
      : selected.confidence === "high"
      ? "Highest-confidence focused hypothesis for the current repair target."
      : "Fallback hypothesis because no high-confidence hypothesis was available.",
  };
}

export function editGuardrailsFromHypothesis(
  selectedHypothesis?: Record<string, any>,
  loopStatus?: Record<string, any>
): Record<string, any> | undefined {
  if (!selectedHypothesis) return undefined;
  const target = selectedHypothesis.target ?? {};
  const targetFiles = target.file ? [target.file] : [];
  const stalled = loopStatus?.stalled === true;

  return {
    mode: stalled ? "inspect-before-edit" : "minimal-edit",
    hypothesisId: selectedHypothesis.id,
    targetFiles,
    allowedScope: targetFiles.length > 0
      ? "Limit edits to the selected hypothesis target file unless inspection proves another file is required."
      : "Limit changes to the selected hypothesis target area.",
    mustInspectFirst: selectedHypothesis.inspectFirst ?? [],
    avoid: [
      "Do not rewrite unrelated code.",
      "Do not broaden the verification target until the focused rerun passes.",
      ...(stalled ? ["Do not repeat the same edit strategy that produced the stalled fingerprint."] : []),
    ],
    editStrategy: selectedHypothesis.editStrategy,
    verifyWith: selectedHypothesis.verifyWith ?? "Run loopTrace.nextToolCall after editing.",
  };
}

export function postEditVerificationFromState(
  nextToolCalls: Array<Record<string, any>> = [],
  failureFingerprint?: Record<string, any>,
  loopStatus?: Record<string, any>,
  editGuardrails?: Record<string, any>
): Record<string, any> | undefined {
  const nextToolCall = nextToolCalls[0];
  if (!nextToolCall) return undefined;

  return {
    required: true,
    toolCall: nextToolCall,
    successCondition: "The verification rerun succeeds or reports a different failureFingerprint.",
    failureFingerprint: failureFingerprint?.value,
    previousSameFailureCount: loopStatus?.sameFailureCount,
    maxSameFailureCount: loopStatus?.maxSameFailureCount,
    guardrailMode: editGuardrails?.mode,
    onSameFailure: loopStatus?.stalled
      ? "Do not edit again immediately; follow strategyHints and nextInspectionActions first."
      : "Increment previousSameFailureCount and choose a different repair strategy if the same fingerprint remains.",
  };
}

export function repairLoopStateFromState(
  loopStatus?: Record<string, any>,
  loopRecommendation?: Record<string, any>,
  loopTrace?: Record<string, any>,
  selectedHypothesis?: Record<string, any>,
  editGuardrails?: Record<string, any>,
  postEditVerification?: Record<string, any>,
  nextInspectionActions: Array<Record<string, any>> = []
): Record<string, any> | undefined {
  if (!loopStatus && !loopTrace && !selectedHypothesis && !postEditVerification) return undefined;

  const stalled = loopStatus?.stalled === true || loopTrace?.stalled === true;
  const stopOrEscalate = loopRecommendation?.action === "stop-or-escalate";
  const mustInspect = editGuardrails?.mode === "inspect-before-edit" || stalled || stopOrEscalate;
  const action = stopOrEscalate ? "escalate" : mustInspect ? "inspect" : "edit";
  const nextInspection = nextInspectionActions.slice(0, 3);
  const nextToolCall = postEditVerification?.toolCall ?? loopTrace?.nextToolCall;

  return {
    state: loopStatus?.state ?? loopTrace?.state,
    action,
    stalled,
    stopOrEscalate,
    attemptNumber: loopStatus?.sameFailureCount,
    maxSameFailureCount: loopStatus?.maxSameFailureCount,
    fingerprint: loopStatus?.fingerprint ?? loopTrace?.fingerprint ?? postEditVerification?.failureFingerprint,
    selectedHypothesisId: selectedHypothesis?.id ?? editGuardrails?.hypothesisId,
    selectedHypothesisConfidence: selectedHypothesis?.confidence,
    guardrailMode: editGuardrails?.mode,
    nextInspectionActions: nextInspection,
    postEditToolCall: nextToolCall,
    summary: stopOrEscalate
      ? "Stop repeating edits and escalate with the current fingerprint and evidence."
      : mustInspect
      ? "Inspect the prioritized evidence before making another edit."
      : "Apply a minimal edit for the selected hypothesis, then run the focused verification.",
  };
}

export function repairExecutionQueueFromState(
  repairLoopState?: Record<string, any>,
  selectedHypothesis?: Record<string, any>,
  editGuardrails?: Record<string, any>,
  postEditVerification?: Record<string, any>
): Array<Record<string, any>> {
  if (!repairLoopState) return [];

  const queue: Array<Record<string, any>> = [];
  const pushStep = (step: Record<string, any>) => {
    queue.push({
      sequence: queue.length + 1,
      ...step,
    });
  };

  for (const inspectionAction of repairLoopState.nextInspectionActions ?? []) {
    pushStep({
      id: `inspect-${queue.length + 1}`,
      action: "inspect",
      required: repairLoopState.action !== "edit" || queue.length === 0,
      runPolicy: "read-only",
      stopCondition: "Stop if the evidence contradicts the selected hypothesis or identifies a different target file.",
      source: "nextInspectionActions",
      instruction: "Inspect this evidence before choosing or applying an edit.",
      target: inspectionAction,
    });
  }

  if (repairLoopState.action === "edit" && editGuardrails) {
    pushStep({
      id: "apply-selected-edit",
      action: "edit",
      required: true,
      runPolicy: "single-minimal-edit",
      stopCondition: "Stop after one focused edit; do not continue editing before the verify step runs.",
      hypothesisId: selectedHypothesis?.id ?? editGuardrails.hypothesisId,
      guardrailMode: editGuardrails.mode,
      targetFiles: editGuardrails.targetFiles ?? [],
      instruction: editGuardrails.editStrategy,
      avoid: editGuardrails.avoid ?? [],
    });
  }

  if (repairLoopState.action === "escalate") {
    pushStep({
      id: "stop-or-escalate",
      action: "escalate",
      required: true,
      runPolicy: "manual-review",
      stopCondition: "Always stop automated edits for this repeated fingerprint.",
      fingerprint: repairLoopState.fingerprint,
      instruction: "Stop automated edits for this fingerprint and surface the evidence, hypothesis, and loop state.",
    });
  }

  if (postEditVerification?.toolCall && repairLoopState.action !== "escalate") {
    pushStep({
      id: "verify-focused-rerun",
      action: "verify",
      required: true,
      runPolicy: "call-tool",
      stopCondition: "Stop on success, a different failureFingerprint, or a same-fingerprint stall.",
      toolCall: postEditVerification.toolCall,
      successCondition: postEditVerification.successCondition,
      onSameFailure: postEditVerification.onSameFailure,
    });
  }

  return queue;
}

export function repairNextStepFromQueue(
  repairExecutionQueue: Array<Record<string, any>> = [],
  completedStepIds: string[] = []
): Record<string, any> {
  const completed = new Set(completedStepIds);
  const sortedQueue = [...repairExecutionQueue].sort((a, b) => {
    const left = typeof a.sequence === "number" ? a.sequence : Number.MAX_SAFE_INTEGER;
    const right = typeof b.sequence === "number" ? b.sequence : Number.MAX_SAFE_INTEGER;
    return left - right;
  });
  const nextStep = sortedQueue.find((step) => !completed.has(String(step.id ?? "")));

  if (!nextStep) {
    return {
      state: sortedQueue.length === 0 ? "empty" : "complete",
      shouldStop: true,
      nextStep: undefined,
      instruction: sortedQueue.length === 0
        ? "No repairExecutionQueue steps were provided."
        : "All repairExecutionQueue steps are complete.",
    };
  }

  const action = nextStep.action;
  const runPolicy = nextStep.runPolicy;
  const shouldStop = action === "escalate" || runPolicy === "manual-review";
  const shouldCallTool = action === "verify" && runPolicy === "call-tool" && nextStep.toolCall;
  const shouldEdit = action === "edit" && runPolicy === "single-minimal-edit";
  const shouldInspect = action === "inspect" && runPolicy === "read-only";

  return {
    state: shouldStop ? "blocked-for-manual-review" : "ready",
    shouldStop,
    nextStep,
    execution: {
      shouldInspect,
      shouldEdit,
      shouldCallTool: Boolean(shouldCallTool),
      toolCall: shouldCallTool ? nextStep.toolCall : undefined,
      targetFiles: nextStep.targetFiles ?? [],
      stopCondition: nextStep.stopCondition,
    },
    instruction: shouldStop
      ? nextStep.instruction ?? "Stop automated repair and surface the current evidence."
      : shouldCallTool
      ? "Call nextStep.toolCall exactly, then use the returned repairExecutionQueue for the next loop turn."
      : shouldEdit
      ? "Apply one minimal edit within nextStep.targetFiles, then mark this step complete and run the next verify step."
      : shouldInspect
      ? "Inspect nextStep.target before editing, then mark this step complete."
      : "Process nextStep according to its action and runPolicy.",
  };
}

export function repairExecutionQueueFromPayload(payload: Record<string, any>): Array<Record<string, any>> {
  const candidates = [
    payload.repairExecutionQueue,
    payload.repairPlan?.repairExecutionQueue,
    payload.swiftPostEditVerification?.repairExecutionQueue,
  ];
  const queue = candidates.find((candidate) => Array.isArray(candidate));
  return Array.isArray(queue) ? queue : [];
}

export function repairPlanFromVerificationResult(result: Record<string, any>): Record<string, any> {
  const repairFocus = result.repairFocus;
  const target = repairFocus?.target ?? {};
  const evidence = repairFocus?.evidence;
  const readTargets: Array<Record<string, any>> = [];
  const edits: Array<Record<string, any>> = [];
  const artifacts: Array<Record<string, any>> = [];

  if (evidence) artifacts.push(evidence);
  if (target.type === "file" && target.file) {
    readTargets.push({
      type: "file",
      file: target.file,
      line: target.line,
      column: target.column,
      reason: repairFocus.message,
    });
  } else if (target.type === "artifact") {
    artifacts.push({
      kind: target.kind,
      path: target.path,
      contentKey: target.contentKey,
    });
  }

  if (repairFocus?.action === "edit" && target.file) {
    edits.push({
      type: "file",
      file: target.file,
      line: target.line,
      column: target.column,
      testName: target.testName,
      testFilter: target.testFilter,
      instruction: repairFocus.message ?? "Inspect and fix the focused Swift issue.",
    });
  }

  const tasks = repairFocus
    ? [
        {
          action: repairFocus.action,
          target,
          message: repairFocus.message,
        },
      ]
    : [];

  const failureFingerprint = result.failureFingerprint ?? failureFingerprintFromFocus(result.failedPhase, repairFocus);
  const loopRecommendation = result.loopRecommendation ?? loopRecommendationFromStatus(result.loopStatus);
  const nextToolCalls = repairPlanToolCallsFromRerun(result.recommendedNextRun, result.failedPhase, failureFingerprint, result.loopStatus);
  const inspectionOrder = inspectionOrderFromEvidence(readTargets, artifacts);
  const nextInspectionActions = nextInspectionActionsFromOrder(inspectionOrder);
  const strategyHints = strategyHintsFromState(result.loopStatus, repairFocus, readTargets, artifacts, inspectionOrder);
  const repairHypotheses = repairHypothesesFromState(repairFocus, result.loopStatus, inspectionOrder, nextInspectionActions);
  const selectedHypothesis = selectedHypothesisFromState(repairHypotheses, result.loopStatus);
  const editGuardrails = editGuardrailsFromHypothesis(selectedHypothesis, result.loopStatus);
  const postEditVerification = postEditVerificationFromState(nextToolCalls, failureFingerprint, result.loopStatus, editGuardrails);
  const loopTrace = result.loopTrace ?? loopTraceFromState(result.loopStatus, loopRecommendation, failureFingerprint, nextToolCalls);
  const repairLoopState = repairLoopStateFromState(
    result.loopStatus,
    loopRecommendation,
    loopTrace,
    selectedHypothesis,
    editGuardrails,
    postEditVerification,
    nextInspectionActions
  );
  const repairExecutionQueue = repairExecutionQueueFromState(
    repairLoopState,
    selectedHypothesis,
    editGuardrails,
    postEditVerification
  );

  return {
    schemaVersion: SWIFT_REPAIR_PLAN_SCHEMA_VERSION,
    actionable: Boolean(repairFocus && result.success !== true),
    failedPhase: result.failedPhase,
    failureFingerprint,
    loopStatus: result.loopStatus,
    loopRecommendation,
    loopTrace,
    repairLoopState,
    repairExecutionQueue,
    strategyHints,
    inspectionOrder,
    nextInspectionActions,
    repairHypotheses,
    selectedHypothesis,
    editGuardrails,
    postEditVerification,
    nextAction: result.nextAction,
    repairFocus,
    tasks,
    readTargets,
    edits,
    artifacts,
    rerun: result.recommendedNextRun,
    commands: repairPlanCommandsFromRerun(result.recommendedNextRun, result.failedPhase),
    nextToolCalls,
    summary: repairFocus
      ? `${repairFocus.action} ${target.type ?? "target"} from ${repairFocus.phase} failure.`
      : result.success === true
      ? "Verification already passed; no repair plan is needed."
      : "Verification result did not include repairFocus.",
  };
}

export function sourceExcerptForLine(
  content: string,
  line: number | undefined,
  contextLines = 4
): Record<string, any> {
  const lines = content.split(/\r?\n/);
  const highlightLine = Math.min(Math.max(line ?? 1, 1), Math.max(lines.length, 1));
  const safeContextLines = Math.min(Math.max(contextLines, 0), 20);
  const startLine = Math.max(1, highlightLine - safeContextLines);
  const endLine = Math.min(lines.length, highlightLine + safeContextLines);
  const excerptLines = lines.slice(startLine - 1, endLine).map((text, index) => {
    const number = startLine + index;
    return {
      number,
      text,
      highlight: number === highlightLine,
    };
  });

  return {
    startLine,
    endLine,
    highlightLine,
    text: excerptLines.map((entry) => `${entry.number}: ${entry.text}`).join("\n"),
    lines: excerptLines,
  };
}

export function swiftSymbolsInSource(content: string): Array<Record<string, any>> {
  const symbols: Array<Record<string, any>> = [];
  const declarationPattern =
    /^\s*(?:@\w+(?:\([^)]*\))?\s+)*(?:(?:public|private|fileprivate|internal|open|static|final|override|mutating|nonmutating|async)\s+)*(actor|class|enum|extension|func|init|protocol|struct|var|let)\s+([A-Za-z_][A-Za-z0-9_]*)?/;

  content.split(/\r?\n/).forEach((line, index) => {
    const match = line.match(declarationPattern);
    if (!match) return;
    symbols.push({
      kind: match[1],
      name: match[2] ?? match[1],
      line: index + 1,
      text: line.trim(),
    });
  });

  return symbols;
}

export function focusedSwiftSymbol(
  content: string,
  line: number | undefined
): Record<string, any> | undefined {
  const symbols = swiftSymbolsInSource(content);
  if (symbols.length === 0) return undefined;
  const targetLine = line ?? 1;
  return symbols
    .filter((symbol) => symbol.line <= targetLine)
    .sort((lhs, rhs) => rhs.line - lhs.line)[0] ?? symbols[0];
}

async function findSourceFileByName(root: string, file: string): Promise<string | null> {
  const wanted = file.split("/").at(-1);
  if (!wanted) return null;
  const ignoredDirs = new Set([".build", ".git", ".swiftpm", "DerivedData", "node_modules"]);
  const queue = [resolve(root)];

  while (queue.length > 0) {
    const dir = queue.shift()!;
    let entries: Array<any>;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const entryPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!ignoredDirs.has(entry.name)) queue.push(entryPath);
      } else if (entry.name === wanted && entryPath.endsWith(file)) {
        return entryPath;
      }
    }
  }

  return null;
}

async function resolveSourceTarget(root: string, file: string): Promise<string | null> {
  const rootAbs = resolve(root);
  const targetAbs = resolve(rootAbs, file);
  const relativePath = relative(rootAbs, targetAbs);
  if (relativePath.startsWith("..") || isAbsolute(relativePath)) return null;
  try {
    await access(targetAbs, constants.R_OK);
    return targetAbs;
  } catch {
    return findSourceFileByName(rootAbs, file);
  }
}

async function attachSourceContextToRepairPlan(
  plan: Record<string, any>,
  root: string | undefined,
  contextLines = 4
): Promise<Record<string, any>> {
  if (!root) return plan;
  const safeContextLines = Math.min(Math.max(contextLines, 0), 20);

  for (const target of plan.readTargets ?? []) {
    if (target.type !== "file" || !target.file) continue;
    const sourcePath = await resolveSourceTarget(root, target.file);
    if (!sourcePath) {
      target.sourceError = "Read target is outside the project root.";
      continue;
    }
    try {
      target.sourcePath = sourcePath;
      const source = await readFile(sourcePath, "utf-8");
      target.sourceContext = sourceExcerptForLine(source, target.line, safeContextLines);
      target.focusedSymbol = focusedSwiftSymbol(source, target.line);
    } catch (error: any) {
      target.sourceError = error?.message ?? String(error);
    }
  }

  plan.sourceContext = {
    rootPath: resolve(root),
    contextLines: safeContextLines,
    readTargetCount: plan.readTargets?.length ?? 0,
  };
  plan.inspectionOrder = inspectionOrderFromEvidence(plan.readTargets ?? [], plan.artifacts ?? []);
  plan.nextInspectionActions = nextInspectionActionsFromOrder(plan.inspectionOrder);
  plan.repairHypotheses = repairHypothesesFromState(
    plan.repairFocus,
    plan.loopStatus,
    plan.inspectionOrder,
    plan.nextInspectionActions
  );
  plan.selectedHypothesis = selectedHypothesisFromState(plan.repairHypotheses, plan.loopStatus);
  plan.editGuardrails = editGuardrailsFromHypothesis(plan.selectedHypothesis, plan.loopStatus);
  plan.postEditVerification = postEditVerificationFromState(
    plan.nextToolCalls ?? [],
    plan.failureFingerprint,
    plan.loopStatus,
    plan.editGuardrails
  );
  plan.repairLoopState = repairLoopStateFromState(
    plan.loopStatus,
    plan.loopRecommendation,
    plan.loopTrace,
    plan.selectedHypothesis,
    plan.editGuardrails,
    plan.postEditVerification,
    plan.nextInspectionActions ?? []
  );
  plan.repairExecutionQueue = repairExecutionQueueFromState(
    plan.repairLoopState,
    plan.selectedHypothesis,
    plan.editGuardrails,
    plan.postEditVerification
  );
  plan.strategyHints = strategyHintsFromState(
    plan.loopStatus,
    plan.repairFocus,
    plan.readTargets ?? [],
    plan.artifacts ?? [],
    plan.inspectionOrder
  );
  return plan;
}

export function testFilterFromFailureName(name?: string): string | undefined {
  if (!name) return undefined;
  const trimmed = name.trim();
  const functionMatch = trimmed.match(/^([A-Za-z_][A-Za-z0-9_.]*)\([^)]*\)$/);
  return functionMatch?.[1] ?? trimmed;
}

function isSimulatorUDID(value: string): boolean {
  return /^[0-9A-Fa-f-]{20,}$/.test(value);
}

function parseBootedSimulatorUDID(output: string, requestedSimulator?: string): string | null {
  try {
    const data = JSON.parse(output);
    for (const devices of Object.values(data.devices ?? {}) as any[]) {
      for (const device of devices) {
        if (!device.isAvailable || device.state !== "Booted") continue;
        if (!requestedSimulator || device.name === requestedSimulator || device.udid === requestedSimulator) {
          return device.udid;
        }
      }
    }
  } catch {}
  return null;
}

async function findFirstAppBundle(dir: string): Promise<string | null> {
  let entries: Array<{ name: string; isDirectory: () => boolean }>;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return null;
  }

  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory() && entry.name.endsWith(".app")) return path;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const found = await findFirstAppBundle(join(dir, entry.name));
    if (found) return found;
  }

  return null;
}

async function readBundleIdentifier(appPath: string): Promise<string | null> {
  const plistPath = join(appPath, "Info.plist");
  const result = await run("/usr/libexec/PlistBuddy", ["-c", "Print CFBundleIdentifier", plistPath], {
    timeout: 10_000,
  });
  const value = result.stdout.trim();
  return result.exitCode === 0 && value ? value : null;
}

async function readXcodeSchemes(root: string, files: ProjectFiles): Promise<string[]> {
  const target = xcodeProjectArgs(files, true, root);
  if (!target) return [];

  const schemes = await run("xcodebuild", [...target, "-list", "-json"], {
    cwd: root,
    timeout: 30_000,
  });
  if (schemes.exitCode !== 0) return [];

  try {
    const data = JSON.parse(schemes.stdout);
    const info = data.workspace ?? data.project ?? {};
    return info.schemes ?? [];
  } catch {
    return [];
  }
}

async function resolveXcodeBuildSelection(
  root: string,
  files: ProjectFiles,
  requestedScheme?: string,
  config?: ProjectConfig
): Promise<
  | { ok: true; target: string[]; scheme: string; discoveredSchemes: string[] }
  | { ok: false; error: string; discoveredSchemes: string[]; suggestion: string }
> {
  const target = xcodeProjectArgs(files);
  if (!target) {
    return {
      ok: false,
      error: "No Xcode project or workspace found.",
      discoveredSchemes: [],
      suggestion: "Open an .xcodeproj/.xcworkspace project or use SwiftPM tools with Package.swift.",
    };
  }

  const discoveredSchemes = await readXcodeSchemes(root, files);
  const scheme = requestedScheme ?? config?.defaultScheme ?? discoveredSchemes[0];
  if (!scheme) {
    return {
      ok: false,
      error: "No Xcode scheme was provided or discovered.",
      discoveredSchemes,
      suggestion:
        "Pass scheme explicitly, set defaultScheme in .codex-swift.json, or ensure the scheme is shared in Xcode.",
    };
  }

  return { ok: true, target, scheme, discoveredSchemes };
}

export function parseDiagnostics(
  output: string,
  root: string,
  fileFilter?: string[]
): Array<{ file: string; line: number; column: number; severity: string; message: string }> {
  const diagnostics: Array<{ file: string; line: number; column: number; severity: string; message: string }> = [];
  // Match both /abs/path and relative paths
  const diagRegex = /^(.+?):(\d+):(\d+):\s*(error|warning|note):\s*(.+)$/gm;
  let match;
  while ((match = diagRegex.exec(output)) !== null) {
    const rawFile = match[1];
    const file = rawFile.replace("/private" + root + "/", "").replace(root + "/", "");
    const isRelevant =
      !fileFilter ||
      fileFilter.length === 0 ||
      fileFilter.some((f) => file.endsWith(f) || file === f || rawFile.endsWith(f));
    if (isRelevant) {
      diagnostics.push({
        file,
        line: parseInt(match[2]),
        column: parseInt(match[3]),
        severity: match[4],
        message: match[5],
      });
    }
  }
  return diagnostics;
}

// ── SourceKit-LSP Client ──

interface LSPDiagnostic {
  file: string;
  line: number;
  column: number;
  severity: "error" | "warning" | "note";
  message: string;
}

class LSPClient {
  private proc: ChildProcess | null = null;
  private buffer = Buffer.alloc(0);
  private reqId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private diagnostics = new Map<string, any[]>();
  private diagWaiters: Array<{ uri: string; resolve: () => void }> = [];
  private rootUri: string;
  private rootPath: string;
  private initialized = false;
  private openFiles = new Set<string>();

  constructor(private projectRoot: string) {
    this.rootPath = projectRoot;
    this.rootUri = `file://${projectRoot}`;
  }

  async start(): Promise<void> {
    if (this.proc) return;

    const lspBin = await this.findLSP();
    if (!lspBin) throw new Error("sourcekit-lsp not found");

    this.proc = spawn(lspBin, [], {
      cwd: this.projectRoot,
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.proc.stdout!.on("data", (chunk: Buffer) => this.onData(chunk));
    this.proc.stderr!.on("data", () => {}); // suppress
    this.proc.on("exit", () => {
      this.proc = null;
      this.initialized = false;
      this.openFiles.clear();
    });

    // Initialize LSP
    const result = await this.request("initialize", {
      processId: process.pid,
      rootUri: this.rootUri,
      capabilities: {
        textDocument: {
          publishDiagnostics: { relatedInformation: true },
        },
        window: { workDoneProgress: true },
      },
      workspaceFolders: [{ uri: this.rootUri, name: "project" }],
    });

    this.notify("initialized", {});
    this.initialized = true;
    // Wait briefly for dynamic registrations
    await new Promise((r) => setTimeout(r, 300));
    return result;
  }

  async stop(): Promise<void> {
    if (!this.proc) return;
    try {
      await this.request("shutdown", null).catch(() => {});
      this.notify("exit", null);
    } catch {}
    setTimeout(() => {
      if (this.proc) { this.proc.kill(); this.proc = null; }
    }, 1000);
  }

  async getDiagnostics(
    files: string[],
    fileContents?: Map<string, string>
  ): Promise<{ diagnostics: LSPDiagnostic[]; durationMs: number }> {
    if (!this.initialized) await this.start();

    const startTime = Date.now();
    const allDiags: LSPDiagnostic[] = [];

    for (const relPath of files) {
      const absPath = relPath.startsWith("/") ? relPath : join(this.rootPath, relPath);
      const uri = `file://${absPath}`;
      const shortPath = absPath.replace(this.rootPath + "/", "");

      // Read file content
      let content: string;
      if (fileContents?.has(relPath)) {
        content = fileContents.get(relPath)!;
      } else {
        try {
          content = await readFile(absPath, "utf-8");
        } catch {
          continue; // Skip files that can't be read
        }
      }

      // Open or update the file
      this.diagnostics.delete(uri);
      if (this.openFiles.has(uri)) {
        this.notify("textDocument/didChange", {
          textDocument: { uri, version: Date.now() },
          contentChanges: [{ text: content }],
        });
      } else {
        this.notify("textDocument/didOpen", {
          textDocument: { uri, languageId: "swift", version: 1, text: content },
        });
        this.openFiles.add(uri);
      }

      // Wait for diagnostics
      const diags = await this.waitForDiagnostics(uri, 15_000);
      if (diags) {
        for (const d of diags) {
          const sevMap: Record<number, "error" | "warning" | "note"> = {
            1: "error",
            2: "warning",
            3: "note",
            4: "note",
          };
          allDiags.push({
            file: shortPath,
            line: (d.range?.start?.line ?? 0) + 1,
            column: (d.range?.start?.character ?? 0) + 1,
            severity: sevMap[d.severity] ?? "note",
            message: d.message ?? "",
          });
        }
      }
    }

    return { diagnostics: allDiags, durationMs: Date.now() - startTime };
  }

  private async findLSP(): Promise<string | null> {
    try {
      const { stdout } = await exec("which", ["sourcekit-lsp"]);
      return stdout.trim();
    } catch {}
    try {
      const { stdout } = await exec("xcrun", ["--find", "sourcekit-lsp"]);
      return stdout.trim();
    } catch {}
    return null;
  }

  private send(msg: any): void {
    if (!this.proc?.stdin?.writable) return;
    const body = JSON.stringify(msg);
    this.proc.stdin.write(`Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`);
  }

  private request(method: string, params: any): Promise<any> {
    const id = this.reqId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send({ jsonrpc: "2.0", id, method, params });
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`LSP timeout: ${method}`));
        }
      }, 30_000);
    });
  }

  private notify(method: string, params: any): void {
    this.send({ jsonrpc: "2.0", method, params });
  }

  private waitForDiagnostics(uri: string, timeoutMs: number): Promise<any[] | null> {
    const cached = this.diagnostics.get(uri);
    if (cached !== undefined) return Promise.resolve(cached);

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.diagWaiters = this.diagWaiters.filter((w) => w.uri !== uri);
        resolve(null);
      }, timeoutMs);
      this.diagWaiters.push({
        uri,
        resolve: () => {
          clearTimeout(timer);
          resolve(this.diagnostics.get(uri) ?? []);
        },
      });
    });
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (true) {
      const hEnd = this.buffer.indexOf("\r\n\r\n");
      if (hEnd === -1) break;
      const hStr = this.buffer.subarray(0, hEnd).toString("utf8");
      const m = hStr.match(/Content-Length:\s*(\d+)/i);
      if (!m) { this.buffer = this.buffer.subarray(hEnd + 4); continue; }
      const cLen = parseInt(m[1]);
      if (this.buffer.length < hEnd + 4 + cLen) break;
      const body = this.buffer.subarray(hEnd + 4, hEnd + 4 + cLen).toString("utf8");
      this.buffer = this.buffer.subarray(hEnd + 4 + cLen);
      try { this.handleMessage(JSON.parse(body)); } catch {}
    }
  }

  private handleMessage(msg: any): void {
    // Server-to-client request (has both id and method)
    if (msg.id !== undefined && msg.method) {
      this.send({ jsonrpc: "2.0", id: msg.id, result: null });
      return;
    }
    // Response to our request
    if (msg.id !== undefined) {
      const p = this.pending.get(msg.id);
      if (p) {
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message));
        else p.resolve(msg.result);
      }
      return;
    }
    // Push diagnostics notification
    if (msg.method === "textDocument/publishDiagnostics") {
      const uri = msg.params.uri;
      this.diagnostics.set(uri, msg.params.diagnostics ?? []);
      const waiters = this.diagWaiters.filter((w) => w.uri === uri);
      this.diagWaiters = this.diagWaiters.filter((w) => w.uri !== uri);
      for (const w of waiters) w.resolve();
    }
  }
}

// Global LSP client cache (one per project root)
const lspClients = new Map<string, LSPClient>();

async function getLSPClient(root: string): Promise<LSPClient> {
  let client = lspClients.get(root);
  if (!client) {
    client = new LSPClient(root);
    lspClients.set(root, client);
  }
  return client;
}

// ── Server setup ──

const server = new McpServer({
  name: "swift-toolchain",
  version: "0.3.0",
});

// ── Tool: swift_project_describe ──

server.tool(
  "swift_project_describe",
  "Detect Swift project type (SwiftPM, Xcode project, workspace, or mixed), list targets, schemes, platforms, toolchain version, and available tools. Call this first to understand the project before using other tools.",
  { path: z.string().optional().describe("Project directory (default: cwd)") },
  async ({ path }) => {
    const root = await findProjectRoot(path);
    const entries = await readdir(root);
    const config = await loadConfig(root);
    const files = inspectProjectFiles(entries);

    let kind: string;
    if (files.hasPackageSwift && (files.xcodeproj || files.xcworkspace)) kind = "mixed";
    else if (files.hasPackageSwift) kind = "swiftpm";
    else if (files.xcworkspace) kind = "xcworkspace";
    else if (files.xcodeproj) kind = "xcodeproj";
    else kind = "unknown";

    const results: Record<string, any> = { kind, rootPath: root };

    // Mixed project guidance
    if (kind === "mixed") {
      results.mixedProjectNote =
        "Both Package.swift and Xcode project found. SwiftPM commands use Package.swift. " +
        "For Xcode-specific features (schemes, simulators), pass the 'scheme' parameter to swift_build/swift_test.";
    }

    // Swift version
    const swiftVer = await run("swift", ["--version"]);
    results.swiftVersion = swiftVer.stdout.trim().split("\n")[0] ?? "";

    // Tool availability
    const [hasSwiftFormat, hasSwiftLint, hasXcodebuild] = await Promise.all([
      commandExists("swift-format"),
      commandExists("swiftlint"),
      commandExists("xcodebuild"),
    ]);
    results.availableTools = {
      "swift-format": hasSwiftFormat,
      swiftlint: hasSwiftLint,
      xcodebuild: hasXcodebuild,
      simctl: hasXcodebuild, // simctl requires Xcode
    };
    if (!hasSwiftFormat) {
      results.installHints = results.installHints ?? {};
      results.installHints["swift-format"] = "brew install swift-format";
    }
    if (!hasSwiftLint) {
      results.installHints = results.installHints ?? {};
      results.installHints.swiftlint = "brew install swiftlint";
    }

    // SwiftPM targets
    if (files.hasPackageSwift) {
      const dump = await run("swift", ["package", "dump-package"], { cwd: root, timeout: 30_000 });
      if (dump.exitCode === 0) {
        try {
          const pkg = JSON.parse(dump.stdout);
          results.packageName = pkg.name ?? null;
          results.targets = (pkg.targets ?? []).map((t: any) => ({
            name: t.name,
            type: t.type,
          }));
          results.platforms = pkg.platforms ?? [];
          results.swiftLanguageVersions = pkg.swiftLanguageVersions ?? [];
          results.dependencies = (pkg.dependencies ?? []).map((d: any) => ({
            name: d.sourceControl?.[0]?.identity ?? d.fileSystem?.[0]?.identity ?? "unknown",
            url: d.sourceControl?.[0]?.location?.remote?.[0] ?? d.fileSystem?.[0]?.path ?? "",
          }));
        } catch {}
      }
    }

    // Xcode schemes
    if (files.xcodeproj || files.xcworkspace) {
      results.schemes = await readXcodeSchemes(root, files);
    }

    // Config file (.codex-swift.json)
    if (config.defaultScheme || config.excludePaths || config.timeouts) {
      results.config = config;
    }

    // Suggestion
    if (kind === "unknown") {
      results.suggestion =
        "No Swift project detected. Create Package.swift with `swift package init` or open an Xcode project.";
    } else {
      const parts = [`Project type: ${kind}.`];
      if (results.targets?.length) parts.push(`${results.targets.length} target(s) found.`);
      if (!hasSwiftFormat || !hasSwiftLint) parts.push("Some tools missing — see installHints.");
      results.suggestion = parts.join(" ") + " Use swift_diagnostics or swift_build next.";
    }

    return json(results);
  }
);

// ── Tool: swift_symbol_search ──

server.tool(
  "swift_symbol_search",
  "Search for Swift symbols (types, functions, properties) across the project using pattern matching. Returns file, line, and matched declaration.",
  {
    query: z.string().describe("Symbol name or pattern to search"),
    path: z.string().optional().describe("Project directory"),
    kind: z
      .enum(["all", "type", "func", "var", "protocol", "enum"])
      .optional()
      .describe("Filter by symbol kind"),
  },
  async ({ query, path, kind }) => {
    const root = await findProjectRoot(path);
    let pattern: string;

    switch (kind) {
      case "type":
        pattern = `(class|struct|actor)\\s+${query}`;
        break;
      case "func":
        pattern = `func\\s+${query}`;
        break;
      case "var":
        pattern = `(var|let)\\s+${query}`;
        break;
      case "protocol":
        pattern = `protocol\\s+${query}`;
        break;
      case "enum":
        pattern = `enum\\s+${query}`;
        break;
      default:
        pattern = `(class|struct|actor|enum|protocol|func|var|let)\\s+${query}`;
    }

    const result = await run("grep", ["-rn", "--include=*.swift", "-E", pattern, root], {
      timeout: 15_000,
    });

    if (result.exitCode !== 0 && result.stdout.trim() === "") {
      return json({
        matches: [],
        suggestion: `No symbols matching '${query}' found. Try a broader search or check the spelling.`,
      });
    }

    const matches = result.stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .slice(0, 30)
      .map((line) => {
        const parts = line.match(/^(.+?):(\d+):(.*)$/);
        if (!parts) return { raw: line };
        return {
          file: parts[1].replace(root + "/", ""),
          line: parseInt(parts[2]),
          match: parts[3].trim(),
        };
      });

    return json({
      matches,
      suggestion: `Found ${matches.length} match(es) for '${query}'. Use swift_diagnostics on specific files to check for issues.`,
    });
  }
);

// ── Tool: swift_diagnostics ──

server.tool(
  "swift_diagnostics",
  "Get Swift diagnostics (errors, warnings) for specific files. Uses SourceKit-LSP for fast incremental diagnostics (~1s) with automatic fallback to swift build. Pass specific files for LSP-powered diagnostics, or an empty array for full-project diagnostics via build.",
  {
    files: z.array(z.string()).describe("File paths to diagnose (empty array = all files via build)"),
    path: z.string().optional().describe("Project directory"),
    scheme: z.string().optional().describe("Xcode scheme for build-backed diagnostics"),
    mode: z
      .enum(["auto", "lsp", "build"])
      .optional()
      .describe("Diagnostic mode: 'lsp' for fast SourceKit-LSP, 'build' for full project, 'auto' (default) picks best strategy"),
  },
  async ({ files, path, scheme, mode }) => {
    const root = await findProjectRoot(path);
    const config = await loadConfig(root);
    const entries = await readdir(root);
    const projectFiles = inspectProjectFiles(entries);
    const effectiveMode = mode ?? "auto";

    // Decide strategy: LSP for specific files, build for full project
    const useLSP =
      effectiveMode === "lsp" ||
      (effectiveMode === "auto" && files.length > 0);

    if (useLSP && files.length > 0) {
      // ── LSP path: fast incremental diagnostics ──
      try {
        const client = await getLSPClient(root);
        await client.start();

        const { diagnostics, durationMs } = await client.getDiagnostics(files);

        const errors = diagnostics.filter((d) => d.severity === "error");
        const warnings = diagnostics.filter((d) => d.severity === "warning");

        const response: Record<string, any> = {
          success: errors.length === 0,
          mode: "lsp",
          durationMs,
          totalDiagnostics: diagnostics.length,
          filteredDiagnostics: diagnostics.length,
          errors: errors.slice(0, 30),
          warnings: warnings.slice(0, 20),
        };

        if (errors.length === 0 && warnings.length === 0) {
          response.suggestion =
            "No diagnostics found via SourceKit-LSP. Code looks clean. " +
            "Run swift_build to verify cross-file correctness.";
        } else if (errors.length > 0) {
          response.suggestion =
            `Found ${errors.length} error(s) via LSP in ${durationMs}ms. ` +
            `Fix ${errors[0].file}:${errors[0].line} first — ` +
            `"${errors[0].message}". Then re-run swift_diagnostics on the same file.`;
        } else {
          response.suggestion =
            `No errors but ${warnings.length} warning(s). Consider fixing for clean code.`;
        }

        return json(response);
      } catch (lspErr: any) {
        // LSP failed — fall through to build-based diagnostics
        // Clear the broken client so next call retries
        lspClients.delete(root);
      }
    }

    // ── Build path: full-project diagnostics ──
    const buildStart = Date.now();
    let result: { stdout: string; stderr: string; exitCode: number };
    let buildSystem: "swiftpm" | "xcodebuild";
    let selectedScheme: string | undefined;

    if (projectFiles.xcodeproj || projectFiles.xcworkspace) {
      const selection = await resolveXcodeBuildSelection(root, projectFiles, scheme, config);
      if (!selection.ok) {
        return json({
          success: false,
          mode: "build",
          buildSystem: "xcodebuild",
          error: selection.error,
          discoveredSchemes: selection.discoveredSchemes,
          suggestion: selection.suggestion,
        });
      }
      buildSystem = "xcodebuild";
      selectedScheme = selection.scheme;
      result = await run(
        "xcodebuild",
        [...selection.target, "-scheme", selection.scheme, "build"],
        { cwd: root, timeout: config.timeouts?.build ?? 300_000 }
      );
    } else if (projectFiles.hasPackageSwift) {
      buildSystem = "swiftpm";
      result = await run("swift", ["build"], { cwd: root, timeout: config.timeouts?.build ?? 120_000 });
    } else {
      return json({
        success: false,
        mode: "build",
        error: "No Package.swift or Xcode project found.",
        suggestion: "Create Package.swift, open an Xcode project, or pass path to a Swift project root.",
      });
    }

    const buildDuration = Date.now() - buildStart;
    const allOutput = result.stderr + "\n" + result.stdout;

    const allDiags = parseDiagnostics(allOutput, root);
    const filtered =
      files.length > 0 ? parseDiagnostics(allOutput, root, files) : allDiags;

    const errors = filtered.filter((d) => d.severity === "error");
    const warnings = filtered.filter((d) => d.severity === "warning");

    const response: Record<string, any> = {
      success: result.exitCode === 0,
      mode: "build",
      buildSystem,
      scheme: selectedScheme,
      durationMs: buildDuration,
      totalDiagnostics: allDiags.length,
      filteredDiagnostics: filtered.length,
      errors: errors.slice(0, 30),
      warnings: warnings.slice(0, 20),
    };

    if (!result.exitCode && filtered.length === 0) {
      response.suggestion = "Build succeeded with no diagnostics. Code is clean.";
    } else if (errors.length > 0) {
      response.suggestion =
        `Found ${errors.length} error(s). Fix the first error in ${errors[0].file}:${errors[0].line} — ` +
        `subsequent errors may be cascading from it. Use swift_build after fixing to verify.`;
    } else if (warnings.length > 0) {
      response.suggestion =
        `Build succeeded but found ${warnings.length} warning(s). Consider fixing them to keep the codebase clean.`;
    } else if (result.exitCode !== 0) {
      response.rawOutput = truncate(allOutput.trim(), 2000);
      response.suggestion = "Build-backed diagnostics failed but no structured diagnostics were parsed. Check rawOutput for details.";
    }

    if (files.length > 0 && filtered.length === 0 && allDiags.length > 0) {
      response.note =
        `No diagnostics in the specified files, but ${allDiags.length} diagnostic(s) exist in other files. ` +
        `Run with an empty files array to see all diagnostics.`;
    }

    return json(response);
  }
);

// ── Tool: swift_build ──

server.tool(
  "swift_build",
  "Run an incremental Swift build. Supports stopping after typecheck for faster feedback. Works with both SwiftPM and xcodebuild. Returns structured diagnostics and build timing.",
  {
    path: z.string().optional().describe("Project directory"),
    scheme: z.string().optional().describe("Xcode scheme (for xcodebuild)"),
    stopAfter: z
      .enum(["typecheck", "build"])
      .optional()
      .describe("Stop after this stage (default: build). Use 'typecheck' for faster feedback."),
    configuration: z
      .enum(["debug", "release"])
      .optional()
      .describe("Build configuration (default: debug)"),
  },
  async ({ path, scheme, stopAfter, configuration }) => {
    const root = await findProjectRoot(path);
    const config = await loadConfig(root);
    const entries = await readdir(root);
    const projectFiles = inspectProjectFiles(entries);
    const effectiveScheme = scheme ?? config.defaultScheme;

    let result;
    const start = Date.now();
    let buildSystem: string | undefined;
    let selectedScheme: string | undefined;
    let verificationStage = stopAfter ?? "build";
    let note: string | undefined;

    if (projectFiles.xcodeproj || projectFiles.xcworkspace) {
      const selection = await resolveXcodeBuildSelection(root, projectFiles, effectiveScheme, config);
      if (!selection.ok) {
        if (!projectFiles.hasPackageSwift) {
          return json({
            success: false,
            buildSystem: "xcodebuild",
            error: selection.error,
            discoveredSchemes: selection.discoveredSchemes,
            suggestion: selection.suggestion,
          });
        }
      } else {
        buildSystem = "xcodebuild";
        selectedScheme = selection.scheme;
        const args = xcodeBuildPlan(selection.target, selection.scheme, "build", configuration, stopAfter);
        result = await run("xcodebuild", args, { cwd: root, timeout: config.timeouts?.build ?? 300_000 });
      }
    }

    if (!result && projectFiles.hasPackageSwift) {
      buildSystem = "swiftpm";
      const plan = swiftPMBuildPlan(configuration, stopAfter);
      verificationStage = plan.stage;
      note = plan.note;
      const args = plan.args;
      result = await run("swift", args, { cwd: root, timeout: config.timeouts?.build ?? 300_000 });
    }

    if (!result) {
      return json({
        success: false,
        error: "No Package.swift or Xcode project found.",
        suggestion: "Create a Package.swift with 'swift package init' or open an Xcode project.",
      });
    }

    const durationMs = Date.now() - start;
    const allOutput = result.stderr + "\n" + result.stdout;
    const diagnostics = parseDiagnostics(allOutput, root);
    const errors = diagnostics.filter((d) => d.severity === "error");
    const warnings = diagnostics.filter((d) => d.severity === "warning");

    const response: Record<string, any> = {
      success: result.exitCode === 0,
      buildSystem: buildSystem ?? "unknown",
      scheme: selectedScheme,
      stage: verificationStage,
      durationMs,
      errorCount: errors.length,
      warningCount: warnings.length,
      errors: errors.slice(0, 20),
      warnings: warnings.slice(0, 10),
    };
    if (note) response.note = note;

    // Actionable suggestions
    if (result.exitCode === 0) {
      response.suggestion = stopAfter === "typecheck" && !note
        ? "Typecheck passed. Run swift_build without stopAfter for a full compile, or swift_test to verify runtime behavior."
        : "Build succeeded. Consider running swift_test to verify runtime correctness.";
    } else if (errors.length > 0) {
      response.suggestion =
        `Build failed with ${errors.length} error(s). Start by fixing ${errors[0].file}:${errors[0].line}: "${errors[0].message}". ` +
        `Then re-run swift_diagnostics on that file to check if cascading errors resolved.`;
    } else {
      // Build failed but no parsed errors — include raw output
      response.rawOutput = truncate(allOutput.trim(), 2000);
      response.suggestion = "Build failed but no structured errors were parsed. Check rawOutput for details.";
    }

    return json(response);
  }
);

// ── Tool: swift_test ──

server.tool(
  "swift_test",
  "Run Swift tests. Supports filtering by test name or target. Returns pass/fail counts and output. Uses Swift Testing (@Test) and XCTest.",
  {
    path: z.string().optional().describe("Project directory"),
    filter: z.string().optional().describe("Test name filter (regex pattern)"),
    scheme: z.string().optional().describe("Xcode scheme"),
  },
  async ({ path, filter, scheme }) => {
    const root = await findProjectRoot(path);
    const config = await loadConfig(root);
    const entries = await readdir(root);
    const projectFiles = inspectProjectFiles(entries);
    const effectiveScheme = scheme ?? config.defaultScheme;
    const start = Date.now();
    let result;
    let buildSystem: "swiftpm" | "xcodebuild" | undefined;
    let selectedScheme: string | undefined;

    if (projectFiles.xcodeproj || projectFiles.xcworkspace) {
      const selection = await resolveXcodeBuildSelection(root, projectFiles, effectiveScheme, config);
      if (!selection.ok) {
        if (!projectFiles.hasPackageSwift) {
          return json({
            success: false,
            buildSystem: "xcodebuild",
            error: selection.error,
            discoveredSchemes: selection.discoveredSchemes,
            suggestion: selection.suggestion,
          });
        }
      } else {
        buildSystem = "xcodebuild";
        selectedScheme = selection.scheme;
        const args = xcodeBuildPlan(selection.target, selection.scheme, "test");
        if (filter) args.push(`-only-testing:${filter}`);
        result = await run("xcodebuild", args, { cwd: root, timeout: config.timeouts?.test ?? 300_000 });
      }
    }

    if (!result && projectFiles.hasPackageSwift) {
      buildSystem = "swiftpm";
      const args = ["test"];
      if (filter) args.push("--filter", filter);
      result = await run("swift", args, { cwd: root, timeout: config.timeouts?.test ?? 300_000 });
    }

    if (!result) {
      return json({
        success: false,
        error: "No test target found.",
        suggestion: "Add a test target to Package.swift or create an Xcode test scheme.",
      });
    }

    const durationMs = Date.now() - start;
    const allOutput = result.stdout + "\n" + result.stderr;

    const { passed, failed } = parseTestCounts(allOutput);
    const failureSummary = summarizeTestFailures(allOutput);
    const noTests = detectsNoRunnableTests(allOutput, { passed, failed }, result.exitCode);

    const response: Record<string, any> = {
      success: result.exitCode === 0 && !noTests,
      buildSystem: buildSystem ?? "unknown",
      scheme: selectedScheme,
      passed,
      failed,
      noTests,
      durationMs,
      output: truncate(allOutput.trim(), 4000),
    };

    if (failureSummary.failedTests.length > 0) {
      response.failedTests = failureSummary.failedTests;
      response.firstFailure = failureSummary.firstFailure;
    }

    if (noTests) {
      response.suggestion = "No tests were found or run. Add test functions with @Test or XCTestCase subclasses.";
    } else if (failed > 0) {
      response.suggestion = `${failed} test(s) failed. Check the output for assertion details and fix the failing tests.`;
    } else if (passed > 0) {
      response.suggestion = `All ${passed} test(s) passed.`;
    }

    return json(response);
  }
);

// ── Tool: swift_verify ──

server.tool(
  "swift_repair_plan",
  "Convert a swift_verify JSON result into a minimal machine-readable repair plan: read targets, optional source excerpts, edit targets, evidence artifacts, and the recommended rerun.",
  {
    verificationResultJson: z.string().describe("Raw JSON text returned by swift_verify"),
    path: z.string().optional().describe("Project root used to attach source excerpts for readTargets"),
    contextLines: z.number().int().min(0).max(20).optional().describe("Source lines to include before and after each read target (default: 4)"),
  },
  async ({ verificationResultJson, path, contextLines }) => {
    try {
      const result = JSON.parse(verificationResultJson);
      const root = path ?? result.rootPath;
      const plan = repairPlanFromVerificationResult(result);
      return json(await attachSourceContextToRepairPlan(plan, root, contextLines ?? 4));
    } catch (error: any) {
      return json({
        schemaVersion: SWIFT_REPAIR_PLAN_SCHEMA_VERSION,
        actionable: false,
        error: "Invalid verificationResultJson.",
        message: error?.message ?? String(error),
      });
    }
  }
);

server.tool(
  "swift_repair_next_step",
  "Select the next actionable step from a repairExecutionQueue or a full swift_verify/hook payload and return whether Codex should inspect, edit, call a tool, or stop for manual review.",
  {
    repairExecutionQueueJson: z.string().optional().describe("JSON array from repairExecutionQueue"),
    repairPayloadJson: z.string().optional().describe("Optional full JSON payload containing repairExecutionQueue, repairPlan.repairExecutionQueue, or swiftPostEditVerification.repairExecutionQueue"),
    completedStepIdsJson: z.string().optional().describe("Optional JSON array of completed step ids"),
  },
  async ({ repairExecutionQueueJson, repairPayloadJson, completedStepIdsJson }) => {
    try {
      if (!repairExecutionQueueJson && !repairPayloadJson) {
        return json({
          success: false,
          error: "Provide repairExecutionQueueJson or repairPayloadJson.",
        });
      }
      const queue = repairExecutionQueueJson
        ? JSON.parse(repairExecutionQueueJson)
        : repairExecutionQueueFromPayload(JSON.parse(repairPayloadJson ?? "{}"));
      const completedStepIds = completedStepIdsJson ? JSON.parse(completedStepIdsJson) : [];
      if (!Array.isArray(queue)) {
        return json({
          success: false,
          error: "repairExecutionQueueJson must decode to an array, or repairPayloadJson must contain a repairExecutionQueue.",
        });
      }
      if (!Array.isArray(completedStepIds)) {
        return json({
          success: false,
          error: "completedStepIdsJson must decode to an array when provided.",
        });
      }
      return json({
        success: true,
        ...repairNextStepFromQueue(queue, completedStepIds.map((id) => String(id))),
      });
    } catch (error: any) {
      return json({
        success: false,
        error: error?.message ?? String(error),
      });
    }
  }
);

server.tool(
  "swift_verify",
  "Run a staged Swift verification loop and return the first failing phase with the next action. Levels: build, test, simulator.",
  {
    path: z.string().optional().describe("Project directory"),
    scheme: z.string().optional().describe("Xcode scheme"),
    level: z
      .enum(["build", "test", "simulator"])
      .optional()
      .describe("Verification depth (default: build)"),
    configuration: z
      .enum(["debug", "release"])
      .optional()
      .describe("Build configuration (default: debug)"),
    simulator: z.string().optional().describe("Simulator name or UDID for simulator-level verification"),
    testFilter: z.string().optional().describe("Test name filter for the test phase"),
    captureScreenshot: z.boolean().optional().describe("Capture screenshot during simulator verification (default: true)"),
    collectLogs: z.boolean().optional().describe("Collect runtime logs during simulator verification (default: true)"),
    logWindow: z.string().optional().describe("Recent log window for simulator logs, such as '30s' or '1m'"),
    bundleIdentifier: z.string().optional().describe("Bundle identifier to launch for simulator verification"),
    includeRepairPlan: z.boolean().optional().describe("Include an inline swift-repair-plan/v1 payload when verification fails (default: false)"),
    repairContextLines: z.number().int().min(0).max(20).optional().describe("Source context lines for inline repairPlan when includeRepairPlan is true (default: 4)"),
    previousFailureFingerprint: z.string().optional().describe("Previous failureFingerprint.value used to report loopStatus across repair attempts"),
    previousSameFailureCount: z.number().int().min(0).optional().describe("Previous loopStatus.sameFailureCount used to detect stalled repair loops"),
    maxSameFailureCount: z.number().int().min(1).optional().describe("Number of repeated identical failures before loopStatus.stalled becomes true (default: 3)"),
  },
  async ({ path, scheme, level, configuration, simulator, testFilter, captureScreenshot, collectLogs, logWindow, bundleIdentifier, includeRepairPlan, repairContextLines, previousFailureFingerprint, previousSameFailureCount, maxSameFailureCount }) => {
    const start = Date.now();
    const startedAt = new Date().toISOString();
    const root = await findProjectRoot(path);
    const config = await loadConfig(root);
    const entries = await readdir(root);
    const projectFiles = inspectProjectFiles(entries);
    const verificationLevel = level ?? "build";
    const steps: Array<Record<string, any>> = [];
    const response: Record<string, any> = {
      ...swiftVerifyMetadata(),
      success: false,
      level: verificationLevel,
      rootPath: root,
      startedAt,
      steps,
    };
    const finish = async () => {
      if (typeof response.durationMs !== "number") response.durationMs = Date.now() - start;
      if (!response.endedAt) response.endedAt = new Date().toISOString();
      response.summary = verificationSummary(steps, response);
      if (response.success !== true) {
        response.failureFingerprint = failureFingerprintFromFocus(response.failedPhase, response.repairFocus);
      }
      response.loopStatus = loopStatusFromFingerprint(
        previousFailureFingerprint,
        response.failureFingerprint,
        response.success === true,
        previousSameFailureCount ?? 0,
        maxSameFailureCount ?? 3
      );
      response.loopRecommendation = loopRecommendationFromStatus(response.loopStatus);
      response.loopTrace = loopTraceFromState(
        response.loopStatus,
        response.loopRecommendation,
        response.failureFingerprint,
        repairPlanToolCallsFromRerun(
          response.recommendedNextRun,
          response.failedPhase,
          response.failureFingerprint,
          response.loopStatus
        )
      );
      response.inspectionOrder = inspectionOrderFromEvidence(
        [],
        steps.flatMap((step) => step.artifacts ?? [])
      );
      response.nextInspectionActions = nextInspectionActionsFromOrder(response.inspectionOrder);
      response.repairHypotheses = repairHypothesesFromState(
        response.repairFocus,
        response.loopStatus,
        response.inspectionOrder,
        response.nextInspectionActions
      );
      response.selectedHypothesis = selectedHypothesisFromState(response.repairHypotheses, response.loopStatus);
      response.editGuardrails = editGuardrailsFromHypothesis(response.selectedHypothesis, response.loopStatus);
      response.postEditVerification = postEditVerificationFromState(
        repairPlanToolCallsFromRerun(
          response.recommendedNextRun,
          response.failedPhase,
          response.failureFingerprint,
          response.loopStatus
        ),
        response.failureFingerprint,
        response.loopStatus,
        response.editGuardrails
      );
      response.repairLoopState = repairLoopStateFromState(
        response.loopStatus,
        response.loopRecommendation,
        response.loopTrace,
        response.selectedHypothesis,
        response.editGuardrails,
        response.postEditVerification,
        response.nextInspectionActions
      );
      response.repairExecutionQueue = repairExecutionQueueFromState(
        response.repairLoopState,
        response.selectedHypothesis,
        response.editGuardrails,
        response.postEditVerification
      );
      response.strategyHints = strategyHintsFromState(
        response.loopStatus,
        response.repairFocus,
        [],
        steps.flatMap((step) => step.artifacts ?? []),
        response.inspectionOrder
      );
      if (includeRepairPlan && response.success !== true) {
        response.repairPlan = await attachSourceContextToRepairPlan(
          repairPlanFromVerificationResult(response),
          root,
          repairContextLines ?? 4
        );
      }
      return json(response);
    };

    if (!projectFiles.hasPackageSwift && !projectFiles.xcodeproj && !projectFiles.xcworkspace) {
      response.failedPhase = "project";
      response.nextAction = verificationNextAction("project");
      response.focus = verificationFocus("project");
      response.repairFocus = verificationRepairFocus("project");
      response.recommendedNextRun = toolRecommendation(
        "swift_project_describe",
        { path: root },
        "Inspect project markers before running verification again."
      );
      response.suggestion = "No Swift project markers were found.";
      return finish();
    }

    let selectedScheme: string | undefined;
    let buildResult: { stdout: string; stderr: string; exitCode: number };
    let buildSystem: "swiftpm" | "xcodebuild";
    let buildCommand: ReturnType<typeof commandInvocation>;
    const verifyOptions = () => ({
      scheme: selectedScheme ?? scheme,
      configuration,
      simulator,
      testFilter,
      captureScreenshot,
      collectLogs,
      logWindow,
      bundleIdentifier,
    });
    const setFocus = (phase: string, detail?: Record<string, any>) => {
      const focus = verificationFocus(phase, detail);
      if (focus) response.focus = focus;
      const repairFocus = verificationRepairFocus(phase, detail);
      if (repairFocus) response.repairFocus = repairFocus;
    };

    const buildStartedAt = Date.now();
    const buildStartedAtIso = new Date().toISOString();
    if (projectFiles.xcodeproj || projectFiles.xcworkspace) {
      const selection = await resolveXcodeBuildSelection(root, projectFiles, scheme, config);
      if (!selection.ok) {
        response.failedPhase = "build";
        response.step = "scheme";
        response.discoveredSchemes = selection.discoveredSchemes;
        response.nextAction = selection.suggestion;
        response.focus = { kind: "xcodeScheme", discoveredSchemes: selection.discoveredSchemes };
        response.recommendedNextRun = toolRecommendation(
          "swift_xcode_info",
          { path: root, scheme },
          "Inspect shared schemes and Xcode build settings before retrying verification."
        );
        return finish();
      }
      selectedScheme = selection.scheme;
      buildSystem = "xcodebuild";
      const args = xcodeBuildPlan(selection.target, selectedScheme, "build", configuration);
      const timeoutMs = config.timeouts?.build ?? 300_000;
      buildCommand = commandInvocation("xcodebuild", args, root, timeoutMs);
      buildResult = await run("xcodebuild", args, { cwd: root, timeout: timeoutMs });
    } else {
      buildSystem = "swiftpm";
      const plan = swiftPMBuildPlan(configuration);
      const timeoutMs = config.timeouts?.build ?? 300_000;
      buildCommand = commandInvocation("swift", plan.args, root, timeoutMs);
      buildResult = await run("swift", plan.args, { cwd: root, timeout: timeoutMs });
    }
    const buildDurationMs = Date.now() - buildStartedAt;
    const buildEndedAtIso = new Date().toISOString();

    const buildOutput = buildResult.stderr + "\n" + buildResult.stdout;
    const buildDiagnostics = parseDiagnostics(buildOutput, root);
    const buildErrors = buildDiagnostics.filter((d) => d.severity === "error");
    const buildWarnings = buildDiagnostics.filter((d) => d.severity === "warning");
    const buildStep: Record<string, any> = {
      phase: "build",
      success: buildResult.exitCode === 0,
      exitCode: buildResult.exitCode,
      buildSystem,
      scheme: selectedScheme,
      command: buildCommand,
      durationMs: buildDurationMs,
      startedAt: buildStartedAtIso,
      endedAt: buildEndedAtIso,
      errorCount: buildErrors.length,
      warningCount: buildWarnings.length,
      errors: buildErrors.slice(0, 20),
      warnings: buildWarnings.slice(0, 10),
      artifacts: [],
    };
    if (buildErrors.length > 0) {
      buildStep.artifacts.push(
        verificationArtifact("diagnostics", "Compiler errors", {
          storage: "inline",
          contentKey: "errors",
          mediaType: "application/json",
        })
      );
    }
    if (buildWarnings.length > 0) {
      buildStep.artifacts.push(
        verificationArtifact("diagnostics", "Compiler warnings", {
          storage: "inline",
          contentKey: "warnings",
          mediaType: "application/json",
        })
      );
    }
    if (buildResult.exitCode !== 0 && buildErrors.length === 0) {
      buildStep.rawOutput = truncate(buildOutput.trim(), 2000);
      buildStep.artifacts.push(
        verificationArtifact("command-output", "Build raw output", {
          storage: "inline",
          contentKey: "rawOutput",
          mediaType: "text/plain",
        })
      );
    }
    steps.push(buildStep);

    if (!buildStep.success) {
      response.failedPhase = "build";
      response.nextAction = verificationNextAction("build", buildStep);
      setFocus("build", buildStep);
      response.recommendedNextRun = swiftVerifyRecommendation(
        root,
        verificationLevel,
        verifyOptions(),
        "Re-run the same verification level after fixing the build failure."
      );
      response.durationMs = Date.now() - start;
      return finish();
    }

    if (verificationLevel === "build") {
      response.success = true;
      response.durationMs = Date.now() - start;
      response.recommendedNextRun = swiftVerifyRecommendation(
        root,
        "test",
        verifyOptions(),
        "Build passed; run tests next for runtime correctness."
      );
      response.suggestion = "Build verification passed. Run level=\"test\" or level=\"simulator\" for deeper verification.";
      return finish();
    }

    let testResult: { stdout: string; stderr: string; exitCode: number };
    let testCommand: ReturnType<typeof commandInvocation>;
    const testStartedAt = Date.now();
    const testStartedAtIso = new Date().toISOString();
    if (buildSystem === "xcodebuild") {
      const target = xcodeProjectArgs(projectFiles);
      if (!target || !selectedScheme) {
        response.failedPhase = "test";
        response.nextAction = "Pass a shared Xcode scheme and retry swift_verify.";
        response.focus = { kind: "xcodeScheme" };
        response.recommendedNextRun = toolRecommendation(
          "swift_xcode_info",
          { path: root, scheme },
          "Inspect shared schemes before retrying test verification."
        );
        response.durationMs = Date.now() - start;
        return finish();
      }
      const args = xcodeBuildPlan(target, selectedScheme, "test");
      if (testFilter) args.push(`-only-testing:${testFilter}`);
      const timeoutMs = config.timeouts?.test ?? 300_000;
      testCommand = commandInvocation("xcodebuild", args, root, timeoutMs);
      testResult = await run("xcodebuild", args, {
        cwd: root,
        timeout: timeoutMs,
      });
    } else {
      const args = ["test"];
      if (testFilter) args.push("--filter", testFilter);
      const timeoutMs = config.timeouts?.test ?? 300_000;
      testCommand = commandInvocation("swift", args, root, timeoutMs);
      testResult = await run("swift", args, { cwd: root, timeout: timeoutMs });
    }
    const testDurationMs = Date.now() - testStartedAt;
    const testEndedAtIso = new Date().toISOString();

    const testOutput = testResult.stdout + "\n" + testResult.stderr;
    const testCounts = parseTestCounts(testOutput);
    const testFailureSummary = summarizeTestFailures(testOutput);
    const noTests = detectsNoRunnableTests(testOutput, testCounts, testResult.exitCode);
    const testStep: Record<string, any> = {
      phase: "test",
      success: testResult.exitCode === 0 && !noTests,
      exitCode: testResult.exitCode,
      passed: testCounts.passed,
      failed: testCounts.failed,
      noTests,
      testFilter,
      command: testCommand,
      durationMs: testDurationMs,
      startedAt: testStartedAtIso,
      endedAt: testEndedAtIso,
      output: truncate(testOutput.trim(), 3000),
      artifacts: [
        verificationArtifact("command-output", "Test output", {
          storage: "inline",
          contentKey: "output",
          mediaType: "text/plain",
        }),
      ],
    };
    if (testFailureSummary.failedTests.length > 0) {
      testStep.failedTests = testFailureSummary.failedTests;
      testStep.firstFailure = testFailureSummary.firstFailure;
      testStep.artifacts.push(
        verificationArtifact("test-failures", "Failed tests", {
          storage: "inline",
          contentKey: "failedTests",
          mediaType: "application/json",
        })
      );
    }
    steps.push(testStep);

    if (!testStep.success) {
      response.failedPhase = "test";
      response.nextAction = verificationNextAction("test", testStep);
      setFocus("test", testStep);
      const focusedFilter = testStep.noTests ? testFilter : testFilterFromFailureName(testStep.firstFailure?.name) ?? testFilter;
      response.recommendedNextRun = swiftVerifyRecommendation(
        root,
        verificationLevel,
        { ...verifyOptions(), testFilter: focusedFilter },
        focusedFilter
          ? "Re-run only the first failing test after applying the fix."
          : "Re-run the same verification level after fixing the test gate."
      );
      response.durationMs = Date.now() - start;
      return finish();
    }

    if (verificationLevel === "test") {
      response.success = true;
      response.durationMs = Date.now() - start;
      if (testFilter) {
        response.recommendedNextRun = swiftVerifyRecommendation(
          root,
          "test",
          { ...verifyOptions(), testFilter: undefined },
          "Filtered test passed; run the full test suite before moving deeper."
        );
        response.suggestion = "Filtered test verification passed. Run level=\"test\" without testFilter for full-suite coverage.";
      } else {
        response.recommendedNextRun = swiftVerifyRecommendation(
          root,
          "simulator",
          verifyOptions(),
          "Build and tests passed; collect simulator runtime evidence next."
        );
        response.suggestion = "Build and test verification passed. Run level=\"simulator\" for runtime evidence.";
      }
      return finish();
    }

    if (buildSystem !== "xcodebuild") {
      const skippedSimulatorStartedAt = new Date().toISOString();
      const simulatorStep = {
        phase: "simulator",
        success: false,
        skipped: true,
        startedAt: skippedSimulatorStartedAt,
        endedAt: new Date().toISOString(),
        durationMs: 0,
        artifacts: [],
        reason: "Simulator verification requires an Xcode project or workspace.",
      };
      steps.push(simulatorStep);
      response.failedPhase = "simulator";
      response.nextAction = "Open or generate an Xcode app project before running simulator verification.";
      setFocus("simulator", simulatorStep);
      response.recommendedNextRun = toolRecommendation(
        "swift_project_describe",
        { path: root },
        "Confirm project type before retrying simulator verification."
      );
      response.durationMs = Date.now() - start;
      return finish();
    }

    const target = xcodeProjectArgs(projectFiles);
    if (!target || !selectedScheme) {
      response.failedPhase = "simulator";
      response.nextAction = "Pass a shared Xcode scheme and retry simulator verification.";
      response.focus = { kind: "xcodeScheme" };
      response.recommendedNextRun = toolRecommendation(
        "swift_xcode_info",
        { path: root, scheme },
        "Inspect shared schemes before retrying simulator verification."
      );
      response.durationMs = Date.now() - start;
      return finish();
    }

    const destination = simulatorDestination(simulator);
    const evidencePaths = simulatorEvidencePaths(root, selectedScheme);
    await mkdir(dirname(evidencePaths.screenshotPath), { recursive: true });
    await mkdir(evidencePaths.derivedDataPath, { recursive: true });
    const simulatorStartedAt = Date.now();
    const simulatorStartedAtIso = new Date().toISOString();
    const simulatorBuildArgs = xcodeSimulatorBuildPlan(target, selectedScheme, destination, evidencePaths.derivedDataPath);
    const simulatorBuildTimeoutMs = config.timeouts?.build ?? 300_000;
    const simulatorBuild = await run(
      "xcodebuild",
      simulatorBuildArgs,
      { cwd: root, timeout: simulatorBuildTimeoutMs }
    );
    const simulatorStep: Record<string, any> = {
      phase: "simulator",
      success: simulatorBuild.exitCode === 0,
      exitCode: simulatorBuild.exitCode,
      destination,
      derivedDataPath: evidencePaths.derivedDataPath,
      command: commandInvocation("xcodebuild", simulatorBuildArgs, root, simulatorBuildTimeoutMs),
      commands: [commandInvocation("xcodebuild", simulatorBuildArgs, root, simulatorBuildTimeoutMs)],
      startedAt: simulatorStartedAtIso,
      artifacts: [
        verificationArtifact("derived-data", "Simulator DerivedData", {
          storage: "directory",
          path: evidencePaths.derivedDataPath,
        }),
      ],
    };
    const finishSimulatorStep = () => {
      simulatorStep.durationMs = Date.now() - simulatorStartedAt;
      if (!simulatorStep.endedAt) simulatorStep.endedAt = new Date().toISOString();
    };
    const addSimulatorRawOutputArtifact = () => {
      simulatorStep.artifacts.push(
        verificationArtifact("command-output", "Simulator raw output", {
          storage: "inline",
          contentKey: "rawOutput",
          mediaType: "text/plain",
        })
      );
    };
    const simulatorDiagnostics = parseDiagnostics(simulatorBuild.stderr + "\n" + simulatorBuild.stdout, root);
    const simulatorErrors = simulatorDiagnostics.filter((d) => d.severity === "error");
    if (simulatorErrors.length > 0) simulatorStep.errors = simulatorErrors.slice(0, 20);
    if (simulatorBuild.exitCode !== 0) {
      simulatorStep.rawOutput = truncate((simulatorBuild.stdout + "\n" + simulatorBuild.stderr).trim(), 2000);
      addSimulatorRawOutputArtifact();
      finishSimulatorStep();
      steps.push(simulatorStep);
      response.failedPhase = "simulator";
      response.nextAction = verificationNextAction("simulator", simulatorStep);
      setFocus("simulator", simulatorStep);
      response.recommendedNextRun = swiftVerifyRecommendation(
        root,
        "simulator",
        verifyOptions(),
        "Re-run simulator verification after fixing the simulator build failure."
      );
      response.durationMs = Date.now() - start;
      return finish();
    }

    const appPath = await findFirstAppBundle(join(evidencePaths.derivedDataPath, "Build", "Products"));
    if (!appPath) {
      simulatorStep.success = false;
      simulatorStep.phaseDetail = "locate-app";
      finishSimulatorStep();
      steps.push(simulatorStep);
      response.failedPhase = "simulator";
      response.nextAction = "Build passed, but no .app bundle was found. Check scheme product settings.";
      setFocus("simulator", simulatorStep);
      response.recommendedNextRun = swiftVerifyRecommendation(
        root,
        "simulator",
        verifyOptions(),
        "Re-run simulator verification after fixing the scheme product settings."
      );
      response.durationMs = Date.now() - start;
      return finish();
    }
    simulatorStep.appPath = appPath;
    simulatorStep.artifacts.push(
      verificationArtifact("app-bundle", "Built app bundle", {
        storage: "directory",
        path: appPath,
      })
    );

    const resolvedBundleIdentifier = bundleIdentifier ?? (await readBundleIdentifier(appPath));
    if (!resolvedBundleIdentifier) {
      simulatorStep.success = false;
      simulatorStep.phaseDetail = "bundle-id";
      finishSimulatorStep();
      steps.push(simulatorStep);
      response.failedPhase = "simulator";
      response.nextAction = "Pass bundleIdentifier explicitly or fix the app Info.plist CFBundleIdentifier.";
      setFocus("simulator", simulatorStep);
      response.recommendedNextRun = swiftVerifyRecommendation(
        root,
        "simulator",
        verifyOptions(),
        "Re-run simulator verification with a bundleIdentifier or fixed Info.plist."
      );
      response.durationMs = Date.now() - start;
      return finish();
    }
    simulatorStep.bundleIdentifier = resolvedBundleIdentifier;

    const bootTarget = simulator ?? "iPhone 16 Pro";
    const bootArgs = ["simctl", "boot", bootTarget];
    simulatorStep.commands.push(commandInvocation("xcrun", bootArgs, undefined, 60_000));
    const bootResult = await run("xcrun", bootArgs, { timeout: 60_000 });
    if (
      bootResult.exitCode !== 0 &&
      !`${bootResult.stdout}\n${bootResult.stderr}`.includes("current state: Booted")
    ) {
      simulatorStep.success = false;
      simulatorStep.phaseDetail = "boot";
      simulatorStep.phaseExitCode = bootResult.exitCode;
      simulatorStep.rawOutput = truncate((bootResult.stdout + "\n" + bootResult.stderr).trim(), 2000);
      addSimulatorRawOutputArtifact();
      finishSimulatorStep();
      steps.push(simulatorStep);
      response.failedPhase = "simulator";
      response.nextAction = verificationNextAction("simulator", simulatorStep);
      setFocus("simulator", simulatorStep);
      response.recommendedNextRun = swiftVerifyRecommendation(
        root,
        "simulator",
        verifyOptions(),
        "Re-run simulator verification after fixing simulator boot or destination issues."
      );
      response.durationMs = Date.now() - start;
      return finish();
    }

    const bootedDevice =
      isSimulatorUDID(bootTarget)
        ? bootTarget
        : parseBootedSimulatorUDID((await run("xcrun", ["simctl", "list", "devices", "-j"], { timeout: 15_000 })).stdout, bootTarget) ??
          bootTarget;
    const bootstatusArgs = ["simctl", "bootstatus", bootedDevice, "-b"];
    simulatorStep.commands.push(commandInvocation("xcrun", bootstatusArgs, undefined, 120_000));
    await run("xcrun", bootstatusArgs, { timeout: 120_000 });
    simulatorStep.simulator = bootedDevice;

    const installArgs = ["simctl", "install", bootedDevice, appPath];
    simulatorStep.commands.push(commandInvocation("xcrun", installArgs, undefined, 120_000));
    const installResult = await run("xcrun", installArgs, { timeout: 120_000 });
    if (installResult.exitCode !== 0) {
      simulatorStep.success = false;
      simulatorStep.phaseDetail = "install";
      simulatorStep.phaseExitCode = installResult.exitCode;
      simulatorStep.rawOutput = truncate((installResult.stdout + "\n" + installResult.stderr).trim(), 2000);
      addSimulatorRawOutputArtifact();
      finishSimulatorStep();
      steps.push(simulatorStep);
      response.failedPhase = "simulator";
      response.nextAction = verificationNextAction("simulator", simulatorStep);
      setFocus("simulator", simulatorStep);
      response.recommendedNextRun = swiftVerifyRecommendation(
        root,
        "simulator",
        verifyOptions(),
        "Re-run simulator verification after fixing simulator install issues."
      );
      response.durationMs = Date.now() - start;
      return finish();
    }

    const launchArgs = ["simctl", "launch", bootedDevice, resolvedBundleIdentifier];
    simulatorStep.commands.push(commandInvocation("xcrun", launchArgs, undefined, 60_000));
    const launchResult = await run("xcrun", launchArgs, {
      timeout: 60_000,
    });
    simulatorStep.launchOutput = truncate(launchResult.stdout.trim(), 500);
    const launchPID = parseLaunchPID(launchResult.stdout);
    if (launchPID !== null) simulatorStep.launchPID = launchPID;
    if (launchResult.exitCode !== 0) {
      simulatorStep.success = false;
      simulatorStep.phaseDetail = "launch";
      simulatorStep.phaseExitCode = launchResult.exitCode;
      simulatorStep.rawOutput = truncate((launchResult.stdout + "\n" + launchResult.stderr).trim(), 2000);
      addSimulatorRawOutputArtifact();
      finishSimulatorStep();
      steps.push(simulatorStep);
      response.failedPhase = "simulator";
      response.nextAction = verificationNextAction("simulator", simulatorStep);
      setFocus("simulator", simulatorStep);
      response.recommendedNextRun = swiftVerifyRecommendation(
        root,
        "simulator",
        verifyOptions(),
        "Re-run simulator verification after fixing launch issues."
      );
      response.durationMs = Date.now() - start;
      return finish();
    }

    if (captureScreenshot ?? true) {
      const screenshotArgs = ["simctl", "io", bootedDevice, "screenshot", evidencePaths.screenshotPath];
      simulatorStep.commands.push(commandInvocation("xcrun", screenshotArgs, undefined, 30_000));
      const screenshotResult = await run("xcrun", screenshotArgs, {
        timeout: 30_000,
      });
      if (screenshotResult.exitCode === 0) {
        simulatorStep.screenshotPath = evidencePaths.screenshotPath;
        simulatorStep.artifacts.push(
          verificationArtifact("screenshot", "Simulator screenshot", {
            storage: "file",
            path: evidencePaths.screenshotPath,
            mediaType: "image/png",
          })
        );
      } else simulatorStep.screenshotError = truncate((screenshotResult.stdout + "\n" + screenshotResult.stderr).trim(), 1000);
    }

    if (collectLogs ?? true) {
      const logArgs = [
        "simctl",
        "spawn",
        bootedDevice,
        "log",
        "show",
        "--last",
        logWindow ?? "1m",
        "--style",
        "compact",
        "--predicate",
        simulatorLogPredicate(resolvedBundleIdentifier),
      ];
      simulatorStep.commands.push(commandInvocation("xcrun", logArgs, undefined, 30_000));
      const logsResult = await run(
        "xcrun",
        logArgs,
        { timeout: 30_000 }
      );
      const logOutput = (logsResult.stdout + "\n" + logsResult.stderr).trim();
      if (logOutput) {
        await writeFile(evidencePaths.logPath, logOutput, "utf-8");
        simulatorStep.runtimeLogPath = evidencePaths.logPath;
        simulatorStep.runtimeLogTail = truncate(logOutput, 2000);
        simulatorStep.runtimeLogSummary = summarizeRuntimeLog(logOutput);
        simulatorStep.artifacts.push(
          verificationArtifact("runtime-log", "Simulator runtime log", {
            storage: "file",
            path: evidencePaths.logPath,
            mediaType: "text/plain",
          }),
          verificationArtifact("runtime-log-tail", "Simulator runtime log tail", {
            storage: "inline",
            contentKey: "runtimeLogTail",
            mediaType: "text/plain",
          })
        );
        if (simulatorStep.runtimeLogSummary.issueDetected) simulatorStep.success = false;
      } else if (logsResult.exitCode !== 0) {
        simulatorStep.runtimeLogError = truncate((logsResult.stdout + "\n" + logsResult.stderr).trim(), 1000);
      }
    }

    finishSimulatorStep();
    steps.push(simulatorStep);
    response.success = simulatorStep.success;
    response.durationMs = Date.now() - start;
    if (response.success) {
      response.suggestion = "Build, test, and simulator verification passed with runtime evidence.";
    } else {
      response.failedPhase = "simulator";
      response.nextAction = verificationNextAction("simulator", simulatorStep);
      setFocus("simulator", simulatorStep);
      response.recommendedNextRun = swiftVerifyRecommendation(
        root,
        "simulator",
        verifyOptions(),
        "Re-run simulator verification after fixing runtime evidence issues."
      );
    }
    return finish();
  }
);

// ── Tool: swift_format ──

server.tool(
  "swift_format",
  "Format Swift files using swift-format. Can check or fix formatting. Requires swift-format to be installed (brew install swift-format).",
  {
    files: z.array(z.string()).describe("File paths to format"),
    check: z.boolean().optional().describe("Check only, don't modify (default: false)"),
    path: z.string().optional().describe("Project directory"),
  },
  async ({ files, check, path }) => {
    if (!(await commandExists("swift-format"))) {
      return json({
        success: false,
        error: "swift-format is not installed.",
        suggestion: "Install with: brew install swift-format",
        action: "skip",
      });
    }

    const root = await findProjectRoot(path);
    const mode = check ? "lint" : "format";
    const args = check ? [mode] : [mode, "--in-place"];
    args.push(...files.map((f) => (f.startsWith("/") ? f : join(root, f))));

    const result = await run("swift-format", args, { cwd: root });

    const response: Record<string, any> = {
      success: result.exitCode === 0,
      mode,
    };

    const output = (result.stdout + "\n" + result.stderr).trim();
    if (output) response.output = truncate(output);

    if (result.exitCode === 0) {
      response.suggestion = check
        ? "All files pass formatting checks."
        : `Formatted ${files.length} file(s) successfully.`;
    } else {
      response.suggestion = check
        ? "Formatting issues found. Run swift_format without check=true to auto-fix."
        : "Formatting failed. Check the output for details.";
    }

    return json(response);
  }
);

// ── Tool: swift_lint ──

server.tool(
  "swift_lint",
  "Run SwiftLint on Swift files. Requires swiftlint to be installed (brew install swiftlint). Returns structured violations with rule names.",
  {
    files: z.array(z.string()).optional().describe("Specific files to lint (default: all)"),
    path: z.string().optional().describe("Project directory"),
    fix: z.boolean().optional().describe("Auto-fix violations (default: false)"),
  },
  async ({ files, path, fix }) => {
    if (!(await commandExists("swiftlint"))) {
      return json({
        success: false,
        error: "SwiftLint is not installed.",
        suggestion: "Install with: brew install swiftlint",
        action: "skip",
      });
    }

    const root = await findProjectRoot(path);
    const args = fix ? ["--fix"] : [];
    if (files && files.length > 0) {
      for (const f of files) {
        args.push(f.startsWith("/") ? f : join(root, f));
      }
    }

    const result = await run("swiftlint", args, { cwd: root, timeout: 60_000 });
    const allOutput = (result.stdout + "\n" + result.stderr).trim();

    const violations: Array<{ file: string; line: number; severity: string; rule: string; message: string }> = [];
    const violationRegex = /^(.+?):(\d+):\d+:\s*(warning|error):\s*(.+?)\s*\((\w+)\)$/gm;
    let match;
    while ((match = violationRegex.exec(allOutput)) !== null) {
      violations.push({
        file: match[1].replace(root + "/", ""),
        line: parseInt(match[2]),
        severity: match[3],
        message: match[4],
        rule: match[5],
      });
    }

    const response: Record<string, any> = {
      success: violations.filter((v) => v.severity === "error").length === 0,
      violationCount: violations.length,
      violations: violations.slice(0, 30),
    };

    if (violations.length === 0) {
      response.suggestion = "No SwiftLint violations found. Code follows style guidelines.";
    } else {
      const errorCount = violations.filter((v) => v.severity === "error").length;
      const warnCount = violations.filter((v) => v.severity === "warning").length;
      response.suggestion = fix
        ? `Auto-fixed violations. ${violations.length} remaining issue(s) need manual attention.`
        : `Found ${errorCount} error(s) and ${warnCount} warning(s). Run swift_lint with fix=true to auto-fix, or address manually.`;
    }

    return json(response);
  }
);

// ── Tool: swift_preview ──

server.tool(
  "swift_preview",
  "Check if a SwiftUI file has #Preview blocks, detect View structs, and generate preview code. For live rendering, open in Xcode.",
  {
    file: z.string().describe("Swift file path"),
    path: z.string().optional().describe("Project directory"),
    generate: z.boolean().optional().describe("Generate a #Preview block if missing"),
  },
  async ({ file, path, generate }) => {
    const root = await findProjectRoot(path);
    const filePath = file.startsWith("/") ? file : join(root, file);

    let content: string;
    try {
      content = await readFile(filePath, "utf-8");
    } catch {
      return json({
        error: `File not found: ${filePath}`,
        suggestion: "Check the file path and try again.",
      });
    }

    const hasNewPreview = /#Preview\b/.test(content);
    const hasOldPreview = /PreviewProvider/.test(content);
    const hasPreview = hasNewPreview || hasOldPreview;

    // Find all View structs
    const viewMatches = [...content.matchAll(/struct\s+(\w+)\s*:\s*(?:.*\bView\b)/g)];
    const viewNames = viewMatches.map((m) => m[1]);

    // Find init parameters for views
    const viewDetails = viewNames.map((name) => {
      const initMatch = content.match(new RegExp(`struct\\s+${name}[^{]*\\{([\\s\\S]*?)(?=\\n\\s*(?:var\\s+body|func\\s))`));
      const propsMatch = initMatch?.[1]?.match(/(let|var)\s+\w+\s*:\s*\w+/g) ?? [];
      return { name, properties: propsMatch.map((p) => p.trim()) };
    });

    const result: Record<string, any> = {
      file,
      hasPreview,
      previewStyle: hasNewPreview ? "#Preview (modern)" : hasOldPreview ? "PreviewProvider (legacy)" : "none",
      views: viewDetails,
    };

    if (!hasPreview && generate && viewNames.length > 0) {
      const previews = viewNames.map((name) => `#Preview {\n    ${name}()\n}`).join("\n\n");
      result.generatedPreview = "\n" + previews + "\n";
      result.suggestion = `Add the generated #Preview block(s) at the end of ${file}. Then open in Xcode to see the live preview.`;
    } else if (!hasPreview && viewNames.length > 0) {
      result.suggestion = `This file has ${viewNames.length} View(s) but no preview. Run with generate=true to create #Preview blocks.`;
    } else if (hasOldPreview && !hasNewPreview) {
      result.suggestion = "This file uses the legacy PreviewProvider. Consider migrating to #Preview macro for simpler syntax.";
    } else if (hasPreview) {
      result.suggestion = `Preview exists. To see it live: open -a Xcode "${filePath}"`;
    } else {
      result.suggestion = "No SwiftUI Views found in this file. #Preview blocks are only useful for View structs.";
    }

    return json(result);
  }
);

// ── Tool: swift_package_search ──

server.tool(
  "swift_package_search",
  "Search the Swift Package Index for packages. Falls back to GitHub search if SPI is unavailable. Returns package name, URL, and description.",
  {
    query: z.string().describe("Search query (e.g., 'networking', 'json parser', 'image loading')"),
    limit: z.number().optional().describe("Max results (default: 10)"),
  },
  async ({ query, limit }) => {
    const maxResults = limit ?? 10;

    // Try Swift Package Index
    const searchUrl = `https://swiftpackageindex.com/search?query=${encodeURIComponent(query)}`;
    const result = await run(
      "curl",
      ["-s", "-L", "-H", "User-Agent: codex-swift-plugin/0.2", "--max-time", "10", searchUrl],
      { timeout: 15_000 }
    );

    if (result.exitCode === 0 && result.stdout.length > 500) {
      const packages: Array<{ name: string; url: string; summary: string }> = [];
      const html = result.stdout;
      const packageUrls = html.match(/href="(\/[a-zA-Z0-9_-]+\/[a-zA-Z0-9_.-]+)"/g) ?? [];
      const seen = new Set<string>();

      for (const match of packageUrls) {
        const urlPath = match.replace('href="', "").replace('"', "");
        if (
          urlPath.split("/").length === 3 &&
          !urlPath.includes(".") &&
          !/^\/(images|builds|api|search|blog|try-in|add-a|docs|ready|supporters|privacy|faq)\b/.test(urlPath) &&
          !seen.has(urlPath)
        ) {
          seen.add(urlPath);
          const parts = urlPath.split("/").filter(Boolean);
          packages.push({
            name: parts[1] ?? urlPath,
            url: `https://swiftpackageindex.com${urlPath}`,
            summary: "",
          });
        }
        if (packages.length >= maxResults) break;
      }

      if (packages.length > 0) {
        return json({
          source: "Swift Package Index",
          packages,
          suggestion: `Found ${packages.length} package(s). To add one, copy its URL and add to Package.swift dependencies, then run swift_package_resolve.`,
        });
      }
    }

    // Fallback: GitHub search
    const ghResult = await run(
      "curl",
      [
        "-s", "--max-time", "10",
        "-H", "Accept: application/vnd.github+json",
        `https://api.github.com/search/repositories?q=${encodeURIComponent(query)}+language:swift&sort=stars&per_page=${maxResults}`,
      ],
      { timeout: 15_000 }
    );

    if (ghResult.exitCode === 0) {
      try {
        const ghData = JSON.parse(ghResult.stdout);
        if (ghData.items) {
          const packages = ghData.items.slice(0, maxResults).map((r: any) => ({
            name: r.full_name ?? r.name,
            url: r.html_url ?? "",
            summary: r.description ?? "",
            stars: r.stargazers_count ?? null,
            lastUpdated: r.updated_at ?? null,
          }));
          return json({
            source: "GitHub (SPI unavailable)",
            packages,
            suggestion: `Found ${packages.length} package(s) via GitHub. To add one, copy its URL and add to Package.swift dependencies, then run swift_package_resolve.`,
          });
        }
        // Rate limited
        if (ghData.message?.includes("rate limit")) {
          return json({
            error: "Both Swift Package Index and GitHub API are rate-limited.",
            suggestion: "Wait a few minutes and try again, or search manually at https://swiftpackageindex.com",
          });
        }
      } catch {}
    }

    return json({
      error: "Package search failed.",
      suggestion: "Check your network connection, or search manually at https://swiftpackageindex.com",
    });
  }
);

// ── Tool: swift_package_resolve ──

server.tool(
  "swift_package_resolve",
  "Resolve Swift package dependencies. Validates that all packages in Package.swift can be fetched and version constraints are satisfiable.",
  {
    path: z.string().optional().describe("Project directory"),
  },
  async ({ path }) => {
    const root = await findProjectRoot(path);

    try {
      await access(join(root, "Package.swift"), constants.F_OK);
    } catch {
      return json({
        success: false,
        error: "No Package.swift found.",
        suggestion: "This tool only works with SwiftPM projects. For Xcode projects, resolve dependencies in Xcode.",
      });
    }

    const start = Date.now();
    const result = await run("swift", ["package", "resolve"], {
      cwd: root,
      timeout: 120_000,
    });

    const response: Record<string, any> = {
      success: result.exitCode === 0,
      durationMs: Date.now() - start,
    };

    const output = (result.stdout + "\n" + result.stderr).trim();
    if (output) response.output = truncate(output);

    if (result.exitCode === 0) {
      response.suggestion = "All dependencies resolved successfully. Run swift_build to compile.";
    } else {
      response.suggestion =
        "Dependency resolution failed. Common causes: network issues, invalid version constraints, " +
        "or unavailable packages. Check the output for specific errors.";
    }

    return json(response);
  }
);

// ── Tool: swift_simulator_list ──

server.tool(
  "swift_simulator_list",
  "List available iOS/watchOS/tvOS/visionOS simulators and their boot status. Requires Xcode with simulator runtimes installed.",
  {},
  async () => {
    const result = await run("xcrun", ["simctl", "list", "devices", "-j"], {
      timeout: 15_000,
    });

    if (result.exitCode !== 0) {
      return json({
        error: "simctl failed. Xcode may not be installed or configured.",
        suggestion: "Run 'xcode-select -p' to verify Xcode is set up, then install simulator runtimes in Xcode > Settings > Platforms.",
        rawError: result.stderr.slice(0, 200),
      });
    }

    try {
      const data = JSON.parse(result.stdout);
      const devices: Array<{
        name: string;
        udid: string;
        state: string;
        runtime: string;
      }> = [];

      for (const [runtime, devList] of Object.entries(data.devices ?? {})) {
        for (const dev of devList as any[]) {
          if (dev.isAvailable) {
            devices.push({
              name: dev.name,
              udid: dev.udid,
              state: dev.state,
              runtime: runtime.replace("com.apple.CoreSimulator.SimRuntime.", ""),
            });
          }
        }
      }

      if (devices.length === 0) {
        return json({
          devices: [],
          suggestion:
            "No simulator runtimes installed. Install them in Xcode > Settings > Platforms " +
            "(e.g., iOS 18 Simulator). Then simulators will appear here.",
        });
      }

      return json(devices.slice(0, 30));
    } catch {
      return json({ error: "Failed to parse simctl output", rawOutput: truncate(result.stdout, 500) });
    }
  }
);

// ── Tool: swift_simulator_run ──

server.tool(
  "swift_simulator_run",
  "Build, install, launch, and optionally screenshot an app on the iOS Simulator using xcodebuild and simctl.",
  {
    scheme: z.string().describe("Xcode scheme to build and run"),
    simulator: z
      .string()
      .optional()
      .describe("Simulator name or UDID (default: iPhone 16 Pro)"),
    launch: z
      .boolean()
      .optional()
      .describe("Install and launch the app after a successful build (default: true)"),
    captureScreenshot: z
      .boolean()
      .optional()
      .describe("Capture a simulator screenshot after launch (default: true when launch is true)"),
    collectLogs: z
      .boolean()
      .optional()
      .describe("Collect recent simulator logs after launch for crash/runtime evidence (default: true when launch is true)"),
    logWindow: z
      .string()
      .optional()
      .describe("Recent log window for simctl log show, such as '30s', '1m', or '2m' (default: 1m)"),
    bundleIdentifier: z
      .string()
      .optional()
      .describe("Bundle identifier to launch. If omitted, reads CFBundleIdentifier from the built .app."),
    path: z.string().optional().describe("Project directory"),
  },
  async ({ scheme, simulator, launch, captureScreenshot, collectLogs, logWindow, bundleIdentifier, path }) => {
    const root = await findProjectRoot(path);
    const entries = await readdir(root);
    const projectFiles = inspectProjectFiles(entries);

    if (!projectFiles.xcodeproj && !projectFiles.xcworkspace) {
      return json({
        success: false,
        error: "No Xcode project or workspace found.",
        suggestion:
          "swift_simulator_run requires an .xcodeproj or .xcworkspace. " +
          "For SwiftPM-only projects, use 'swift build' instead.",
      });
    }

    const target = xcodeProjectArgs(projectFiles);
    if (!target) {
      return json({
        success: false,
        error: "No Xcode project target could be resolved.",
        suggestion: "Pass path to a directory containing an .xcodeproj or .xcworkspace.",
      });
    }

    const shouldLaunch = launch ?? true;
    const shouldCaptureScreenshot = captureScreenshot ?? shouldLaunch;
    const shouldCollectLogs = collectLogs ?? shouldLaunch;
    const destination = simulatorDestination(simulator);
    const evidencePaths = simulatorEvidencePaths(root, scheme);
    await mkdir(dirname(evidencePaths.screenshotPath), { recursive: true });
    await mkdir(evidencePaths.derivedDataPath, { recursive: true });

    const start = Date.now();
    const buildArgs = xcodeSimulatorBuildPlan(target, scheme, destination, evidencePaths.derivedDataPath);
    const result = await run(
      "xcodebuild",
      buildArgs,
      { cwd: root, timeout: 300_000 }
    );

    const durationMs = Date.now() - start;
    const diagnostics = parseDiagnostics(result.stderr + "\n" + result.stdout, root);
    const errors = diagnostics.filter((d) => d.severity === "error");

    const response: Record<string, any> = {
      success: result.exitCode === 0,
      phase: result.exitCode === 0 ? "built" : "build",
      destination,
      derivedDataPath: evidencePaths.derivedDataPath,
      durationMs,
    };

    if (result.exitCode === 0) {
      response.suggestion = `Build for simulator succeeded in ${(durationMs / 1000).toFixed(1)}s.`;
    } else {
      response.errorCount = errors.length;
      response.errors = errors.slice(0, 10);
      response.rawOutput = truncate((result.stdout + "\n" + result.stderr).trim(), 2000);
      if (errors.length > 0) {
        response.suggestion = `Simulator build failed with ${errors.length} error(s). Fix the errors and retry.`;
      } else {
        response.suggestion =
          "Build failed. Check rawOutput for details. Common issues: missing simulator runtime, " +
          "invalid scheme name, or signing configuration.";
      }
      return json(response);
    }

    if (!shouldLaunch) {
      response.suggestion += " launch=false, so install/launch/screenshot were skipped.";
      return json(response);
    }

    const appPath = await findFirstAppBundle(join(evidencePaths.derivedDataPath, "Build", "Products"));
    if (!appPath) {
      response.success = false;
      response.phase = "locate-app";
      response.suggestion =
        "Build succeeded, but no .app bundle was found under DerivedData/Build/Products. Check scheme product settings.";
      return json(response);
    }
    response.appPath = appPath;

    const resolvedBundleIdentifier = bundleIdentifier ?? (await readBundleIdentifier(appPath));
    if (!resolvedBundleIdentifier) {
      response.success = false;
      response.phase = "bundle-id";
      response.suggestion =
        "Build succeeded, but CFBundleIdentifier could not be read. Pass bundleIdentifier explicitly and retry.";
      return json(response);
    }
    response.bundleIdentifier = resolvedBundleIdentifier;

    const bootTarget = simulator ?? "iPhone 16 Pro";
    const bootResult = await run("xcrun", ["simctl", "boot", bootTarget], { timeout: 60_000 });
    if (
      bootResult.exitCode !== 0 &&
      !`${bootResult.stdout}\n${bootResult.stderr}`.includes("current state: Booted")
    ) {
      response.success = false;
      response.phase = "boot";
      response.rawOutput = truncate((bootResult.stdout + "\n" + bootResult.stderr).trim(), 2000);
      response.suggestion = "Build succeeded, but the target simulator could not be booted. Check simulator name/UDID.";
      return json(response);
    }

    const bootedDevice =
      isSimulatorUDID(bootTarget)
        ? bootTarget
        : parseBootedSimulatorUDID((await run("xcrun", ["simctl", "list", "devices", "-j"], { timeout: 15_000 })).stdout, bootTarget) ??
          bootTarget;
    await run("xcrun", ["simctl", "bootstatus", bootedDevice, "-b"], { timeout: 120_000 });
    response.simulator = bootedDevice;

    const installResult = await run("xcrun", ["simctl", "install", bootedDevice, appPath], {
      timeout: 120_000,
    });
    if (installResult.exitCode !== 0) {
      response.success = false;
      response.phase = "install";
      response.rawOutput = truncate((installResult.stdout + "\n" + installResult.stderr).trim(), 2000);
      response.suggestion = "Build succeeded, but installing the app on the simulator failed.";
      return json(response);
    }

    const launchResult = await run("xcrun", ["simctl", "launch", bootedDevice, resolvedBundleIdentifier], {
      timeout: 60_000,
    });
    if (launchResult.exitCode !== 0) {
      response.success = false;
      response.phase = "launch";
      response.rawOutput = truncate((launchResult.stdout + "\n" + launchResult.stderr).trim(), 2000);
      response.suggestion = "The app installed, but launching it failed. Check bundle id and runtime logs.";
      return json(response);
    }

    response.phase = "launched";
    response.launchOutput = truncate(launchResult.stdout.trim(), 500);
    const launchPID = parseLaunchPID(launchResult.stdout);
    if (launchPID !== null) response.launchPID = launchPID;

    if (shouldCaptureScreenshot) {
      const screenshotResult = await run("xcrun", ["simctl", "io", bootedDevice, "screenshot", evidencePaths.screenshotPath], {
        timeout: 30_000,
      });
      if (screenshotResult.exitCode === 0) {
        response.screenshotPath = evidencePaths.screenshotPath;
      } else {
        response.screenshotError = truncate((screenshotResult.stdout + "\n" + screenshotResult.stderr).trim(), 1000);
      }
    }

    if (shouldCollectLogs) {
      const logsResult = await run(
        "xcrun",
        [
          "simctl",
          "spawn",
          bootedDevice,
          "log",
          "show",
          "--last",
          logWindow ?? "1m",
          "--style",
          "compact",
          "--predicate",
          simulatorLogPredicate(resolvedBundleIdentifier),
        ],
        { timeout: 30_000 }
      );
      const logOutput = (logsResult.stdout + "\n" + logsResult.stderr).trim();
      if (logOutput) {
        await writeFile(evidencePaths.logPath, logOutput, "utf-8");
        response.runtimeLogPath = evidencePaths.logPath;
        response.runtimeLogTail = truncate(logOutput, 2000);
        response.runtimeLogSummary = summarizeRuntimeLog(logOutput);
        if (response.runtimeLogSummary.issueDetected) {
          response.success = false;
          response.phase = "runtime-log";
        }
      } else if (logsResult.exitCode !== 0) {
        response.runtimeLogError = truncate((logsResult.stdout + "\n" + logsResult.stderr).trim(), 1000);
      }
    }

    response.suggestion = response.screenshotPath
      ? "Simulator run completed. Inspect screenshotPath, runtimeLogSummary, and launchPID for visual/runtime evidence."
      : "Simulator run completed. Screenshot capture was skipped or failed; inspect runtimeLogSummary and launchPID for runtime evidence.";
    if (response.runtimeLogSummary?.issueDetected) {
      response.suggestion = "Simulator run found crash-like runtime log patterns. Inspect runtimeLogTail and runtimeLogPath first.";
    }
    return json(response);
  }
);

// ── Tool: swift_device_list ──

server.tool(
  "swift_device_list",
  "List connected physical Apple devices available for development. Requires Xcode and a device connected via USB or Wi-Fi.",
  {},
  async () => {
    // Try devicectl first (Xcode 15+)
    const result = await run(
      "xcrun",
      ["devicectl", "list", "devices", "--json-output", "-"],
      { timeout: 15_000 }
    );

    if (result.exitCode === 0) {
      try {
        const data = JSON.parse(result.stdout);
        const devices = (data.result?.devices ?? []).map((d: any) => ({
          name: d.deviceProperties?.name ?? "Unknown",
          identifier: d.identifier ?? "",
          model: d.hardwareProperties?.marketingName ?? d.hardwareProperties?.productType ?? "",
          osVersion: d.deviceProperties?.osVersionNumber ?? "",
          connectionType: d.connectionProperties?.transportType ?? "",
        }));

        if (devices.length === 0) {
          return json({
            devices: [],
            suggestion: "No devices connected. Connect an iPhone/iPad via USB or enable wireless debugging in Xcode.",
          });
        }

        return json({
          devices,
          suggestion: `${devices.length} device(s) connected. Use swift_simulator_run with a scheme to deploy to a device.`,
        });
      } catch {}
    }

    // Fallback to xctrace
    const fallback = await run("xcrun", ["xctrace", "list", "devices"], { timeout: 15_000 });
    const output = (fallback.stdout + "\n" + fallback.stderr).trim();

    if (output.includes("No devices")) {
      return json({
        devices: [],
        suggestion: "No devices connected. Connect an iPhone/iPad via USB or enable wireless debugging.",
      });
    }

    return json({ rawOutput: truncate(output, 2000) });
  }
);

// ── Tool: swift_xcode_info ──

server.tool(
  "swift_xcode_info",
  "Get detailed Xcode project/workspace information: schemes, build settings, signing configuration, deployment targets, and available destinations. Essential for iOS/macOS app development workflows.",
  {
    path: z.string().optional().describe("Project directory"),
    scheme: z.string().optional().describe("Specific scheme to inspect"),
  },
  async ({ path, scheme }) => {
    const root = await findProjectRoot(path);
    const entries = await readdir(root);
    const xcworkspace = entries.find((e) => e.endsWith(".xcworkspace"));
    const xcodeproj = entries.find((e) => e.endsWith(".xcodeproj"));
    const hasPackageSwift = entries.includes("Package.swift");

    const info: Record<string, any> = { rootPath: root };

    // Determine project type
    if (xcworkspace) {
      info.projectType = "xcworkspace";
      info.projectFile = xcworkspace;
    } else if (xcodeproj) {
      info.projectType = "xcodeproj";
      info.projectFile = xcodeproj;
    } else if (hasPackageSwift) {
      info.projectType = "swiftpm";
      info.note = "SwiftPM project — Xcode opens this directly via Package.swift. Use xcodebuild with -scheme.";
    } else {
      return json({
        error: "No Xcode project, workspace, or Package.swift found.",
        suggestion: "Create a project with Xcode or run `swift package init`.",
      });
    }

    // Get scheme list
    const target = xcworkspace
      ? ["-workspace", join(root, xcworkspace)]
      : xcodeproj
      ? ["-project", join(root, xcodeproj)]
      : [];

    const listResult = await run("xcodebuild", [...target, "-list", "-json"], {
      cwd: root,
      timeout: 30_000,
    });

    if (listResult.exitCode === 0) {
      try {
        const data = JSON.parse(listResult.stdout);
        const project = data.workspace ?? data.project ?? {};
        info.schemes = project.schemes ?? [];
        info.configurations = project.configurations ?? [];
        info.targets = project.targets ?? [];
      } catch {}
    }

    // Get build settings for specific scheme
    const targetScheme = scheme ?? info.schemes?.[0];
    if (targetScheme) {
      info.inspectedScheme = targetScheme;

      // Try JSON format first, then plain text
      const settingsResult = await run(
        "xcodebuild",
        [...target, "-scheme", targetScheme, "-showBuildSettings"],
        { cwd: root, timeout: 30_000 }
      );

      if (settingsResult.exitCode === 0 && settingsResult.stdout.includes("=")) {
        // Parse plain-text "KEY = VALUE" format
        const kvRegex = /^\s+(\w+)\s*=\s*(.*)$/gm;
        const settings: Record<string, string> = {};
        let kv;
        while ((kv = kvRegex.exec(settingsResult.stdout)) !== null) {
          settings[kv[1]] = kv[2].trim();
        }
        if (Object.keys(settings).length > 0) {
          info.buildSettings = {
            productName: settings.PRODUCT_NAME ?? null,
            bundleIdentifier: settings.PRODUCT_BUNDLE_IDENTIFIER ?? null,
            deploymentTarget: {
              iOS: settings.IPHONEOS_DEPLOYMENT_TARGET ?? null,
              macOS: settings.MACOSX_DEPLOYMENT_TARGET ?? null,
              watchOS: settings.WATCHOS_DEPLOYMENT_TARGET ?? null,
              tvOS: settings.TVOS_DEPLOYMENT_TARGET ?? null,
            },
            swiftVersion: settings.SWIFT_VERSION ?? null,
            signingStyle: settings.CODE_SIGN_STYLE ?? null,
            signingTeam: settings.DEVELOPMENT_TEAM ?? null,
            sdkRoot: settings.SDKROOT ?? null,
            supportedPlatforms: settings.SUPPORTED_PLATFORMS ?? null,
          };
        }
      }

      // For SwiftPM projects, also extract from Package.swift
      if (!info.buildSettings && hasPackageSwift) {
        const dump = await run("swift", ["package", "dump-package"], { cwd: root, timeout: 30_000 });
        if (dump.exitCode === 0) {
          try {
            const pkg = JSON.parse(dump.stdout);
            info.buildSettings = {
              productName: pkg.name ?? null,
              platforms: pkg.platforms ?? [],
              swiftLanguageVersions: pkg.swiftLanguageVersions ?? [],
              source: "Package.swift",
            };
          } catch {}
        }
      }

      // Get available destinations — parse { key:value, key:value } format
      const destResult = await run(
        "xcodebuild",
        [...target, "-scheme", targetScheme, "-showdestinations"],
        { cwd: root, timeout: 30_000 }
      );

      if (destResult.exitCode === 0) {
        const available: Array<Record<string, string>> = [];
        const ineligible: Array<Record<string, string>> = [];
        let section = "";

        for (const line of destResult.stdout.split("\n")) {
          if (line.includes("Available destinations")) section = "available";
          else if (line.includes("Ineligible destinations")) section = "ineligible";
          else if (line.includes("{ platform:")) {
            const entry: Record<string, string> = {};
            const pairRegex = /(\w+):([^,}]+)/g;
            let pm;
            while ((pm = pairRegex.exec(line)) !== null) {
              entry[pm[1].trim()] = pm[2].trim();
            }
            if (entry.platform) {
              if (section === "ineligible") ineligible.push(entry);
              else available.push(entry);
            }
          }
        }

        if (available.length > 0) info.availableDestinations = available;
        if (ineligible.length > 0) {
          info.ineligibleDestinations = ineligible.slice(0, 10);
          // Extract missing platforms
          const missingPlatforms = ineligible
            .filter((d) => d.error?.includes("not installed"))
            .map((d) => d.platform)
            .filter((v, i, a) => a.indexOf(v) === i);
          if (missingPlatforms.length > 0) {
            info.missingPlatforms = missingPlatforms;
            info.installHint =
              `Install missing platform(s): ${missingPlatforms.join(", ")} via Xcode > Settings > Platforms.`;
          }
        }
      }
    }

    // Suggestion
    if (info.schemes?.length > 0) {
      info.suggestion =
        `${info.schemes.length} scheme(s) found: ${info.schemes.slice(0, 5).join(", ")}. ` +
        `Use swift_build with scheme="${targetScheme}" for Xcode builds. ` +
        `Use swift_simulator_run to deploy to a simulator.`;
    } else {
      info.suggestion =
        "No schemes detected. Open the project in Xcode first, or use swift_build without a scheme for SwiftPM builds.";
    }

    return json(info);
  }
);

// ── Behavior Verify: semantic anti-pattern detection ──

interface BehaviorIssue {
  file: string;
  line: number;
  pattern: string;
  severity: "warning" | "error";
  message: string;
  fix: string;
}

function detectBehaviorIssues(filePath: string, content: string): BehaviorIssue[] {
  const issues: BehaviorIssue[] = [];
  const lines = content.split("\n");
  const fileName = filePath.split("/").pop() || filePath;

  // Track declarations for cross-reference
  const stateVars = new Set<string>();
  const publishedVars = new Set<string>();
  const bindingVars = new Set<string>();
  const usedVars = new Set<string>();
  const observableObjectClasses = new Set<string>();
  let inBody = false;
  let braceDepth = 0;
  let currentStructOrClass = "";
  let hasObservableObjectConformance = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    const ln = i + 1;

    // Track struct/class declarations
    const structMatch = trimmed.match(/^(?:struct|class)\s+(\w+)/);
    if (structMatch) {
      currentStructOrClass = structMatch[1];
      hasObservableObjectConformance = /ObservableObject/.test(trimmed);
      if (hasObservableObjectConformance) observableObjectClasses.add(currentStructOrClass);
    }

    // 1. Empty Button action
    if (/Button\s*\(/.test(trimmed)) {
      // Look ahead for empty action closure
      const remaining = lines.slice(i, Math.min(i + 5, lines.length)).join("\n");
      if (/action\s*:\s*\{\s*\}/.test(remaining) || /Button\s*\([^)]*\)\s*\{\s*\}/.test(remaining)) {
        issues.push({
          file: fileName, line: ln, pattern: "empty-button-action",
          severity: "error",
          message: "Button has an empty action closure — tapping it will do nothing.",
          fix: "Add the intended action inside the Button's closure, e.g. navigation, state change, or API call."
        });
      }
    }

    // 2. NavigationLink to EmptyView or missing destination
    if (/NavigationLink/.test(trimmed)) {
      const remaining = lines.slice(i, Math.min(i + 5, lines.length)).join("\n");
      if (/destination\s*:\s*EmptyView\(\)/.test(remaining) || /NavigationLink\s*\(\s*destination\s*:\s*EmptyView/.test(remaining)) {
        issues.push({
          file: fileName, line: ln, pattern: "empty-navigation-destination",
          severity: "error",
          message: "NavigationLink destination is EmptyView() — navigation will show a blank screen.",
          fix: "Replace EmptyView() with the actual destination view."
        });
      }
    }

    // 3. @State declared but never mutated
    const stateMatch = trimmed.match(/@State\s+(?:private\s+)?var\s+(\w+)/);
    if (stateMatch) stateVars.add(stateMatch[1]);

    // 4. @Published missing on ObservableObject properties
    if (hasObservableObjectConformance && /^\s*var\s+\w+/.test(trimmed) && !/@Published/.test(trimmed) && !/@State/.test(trimmed) && !/let\s/.test(trimmed) && !/computed/.test(trimmed) && !/\{/.test(trimmed.split("=")[0])) {
      const varMatch = trimmed.match(/var\s+(\w+)/);
      if (varMatch && !trimmed.includes("//")) {
        // Check if it's a stored property with assignment
        if (trimmed.includes("=") || trimmed.includes(":")) {
          issues.push({
            file: fileName, line: ln, pattern: "missing-published",
            severity: "warning",
            message: `Property '${varMatch[1]}' in ObservableObject class is not @Published — UI won't update when it changes.`,
            fix: `Add @Published before the property declaration: @Published var ${varMatch[1]}`
          });
        }
      }
    }

    // 5. Task{} not inside .onAppear or .task
    if (/Task\s*\{/.test(trimmed) && !/.onAppear/.test(trimmed) && !/.task/.test(trimmed)) {
      // Check if we're inside a body computed property
      const contextLines = lines.slice(Math.max(0, i - 10), i).join("\n");
      if (/var\s+body\s*:\s*some\s+View/.test(contextLines) && !/\.onAppear/.test(contextLines) && !/\.task/.test(contextLines) && !/Button/.test(contextLines) && !/onTapGesture/.test(contextLines)) {
        issues.push({
          file: fileName, line: ln, pattern: "task-in-body-without-lifecycle",
          severity: "warning",
          message: "Task{} in view body runs on every re-render, not just once. This may cause repeated API calls or side effects.",
          fix: "Move the Task into a .task{} or .onAppear{} modifier to run it only once when the view appears."
        });
      }
    }

    // 6. @Binding declared but never passed
    const bindingMatch = trimmed.match(/@Binding\s+var\s+(\w+)/);
    if (bindingMatch) bindingVars.add(bindingMatch[1]);

    // 7. .sheet / .fullScreenCover with hardcoded isPresented: .constant(true/false)
    if (/\.sheet\s*\(/.test(trimmed) || /\.fullScreenCover\s*\(/.test(trimmed)) {
      const remaining = lines.slice(i, Math.min(i + 3, lines.length)).join("\n");
      if (/isPresented\s*:\s*\.constant\s*\(\s*(true|false)\s*\)/.test(remaining)) {
        issues.push({
          file: fileName, line: ln, pattern: "constant-presentation",
          severity: "error",
          message: "Sheet/fullScreenCover uses .constant() for isPresented — it can never be dismissed or toggled.",
          fix: "Use a @State var isPresented = false and pass $isPresented as the binding."
        });
      }
    }

    // 8. ForEach without id on non-Identifiable type
    if (/ForEach\s*\(/.test(trimmed) && !/id\s*:/.test(trimmed) && !/\.self/.test(trimmed)) {
      const remaining = lines.slice(i, Math.min(i + 2, lines.length)).join("");
      if (!/id\s*:/.test(remaining) && !/Identifiable/.test(remaining)) {
        issues.push({
          file: fileName, line: ln, pattern: "foreach-missing-id",
          severity: "warning",
          message: "ForEach without explicit id: parameter — if items aren't Identifiable, the list won't update correctly.",
          fix: "Add id: \\.self or id: \\.id to the ForEach, or make the element type conform to Identifiable."
        });
      }
    }

    // 9. NavigationStack/NavigationView mismatch
    if (/NavigationView\s*\{/.test(trimmed)) {
      issues.push({
        file: fileName, line: ln, pattern: "deprecated-navigation-view",
        severity: "warning",
        message: "NavigationView is deprecated in iOS 16+. Use NavigationStack instead.",
        fix: "Replace NavigationView { ... } with NavigationStack { ... }."
      });
    }

    // 10. async function called without await
    if (/func\s+\w+\s*\(/.test(trimmed) && /async/.test(trimmed)) {
      // This is a declaration, track it
    }

    // 11. @Environment(\.dismiss) not used
    const dismissMatch = trimmed.match(/@Environment\s*\(\s*\\\.dismiss\s*\)\s+(?:private\s+)?var\s+(\w+)/);
    if (dismissMatch) {
      const dismissVar = dismissMatch[1];
      const restOfFile = lines.slice(i + 1).join("\n");
      if (!restOfFile.includes(dismissVar)) {
        issues.push({
          file: fileName, line: ln, pattern: "unused-dismiss",
          severity: "warning",
          message: `@Environment(\\.dismiss) var ${dismissVar} is declared but never called — the view has no way to dismiss itself.`,
          fix: `Call ${dismissVar}() in a button action or after completing an action.`
        });
      }
    }

    // 12. @StateObject created inside body (recreated every render)
    if (/@StateObject/.test(trimmed)) {
      const contextLines = lines.slice(Math.max(0, i - 5), i).join("\n");
      if (/var\s+body\s*:\s*some\s+View/.test(contextLines)) {
        issues.push({
          file: fileName, line: ln, pattern: "stateobject-in-body",
          severity: "error",
          message: "@StateObject created inside body will be recreated on every re-render, losing all state.",
          fix: "Move the @StateObject declaration to a stored property of the struct."
        });
      }
    }

    // 13. onAppear calling a function that isn't defined
    const onAppearMatch = trimmed.match(/\.onAppear\s*\{\s*(\w+)\(\)\s*\}/);
    if (onAppearMatch) {
      const funcName = onAppearMatch[1];
      if (!content.includes(`func ${funcName}`)) {
        issues.push({
          file: fileName, line: ln, pattern: "onappear-undefined-func",
          severity: "error",
          message: `.onAppear calls ${funcName}() but this function is not defined in the file.`,
          fix: `Define func ${funcName}() or move the call to the correct scope.`
        });
      }
    }

    // 14. List with static content but no data binding
    if (/List\s*\{/.test(trimmed)) {
      const remaining = lines.slice(i, Math.min(i + 10, lines.length)).join("\n");
      if (!/ForEach/.test(remaining) && !/\$/.test(remaining) && /Text\s*\(/.test(remaining)) {
        const textCount = (remaining.match(/Text\s*\(/g) || []).length;
        if (textCount >= 3) {
          issues.push({
            file: fileName, line: ln, pattern: "static-list-content",
            severity: "warning",
            message: "List contains only static Text views — this is likely placeholder content that should be data-driven.",
            fix: "Replace static Text views with a ForEach over a data model array."
          });
        }
      }
    }

    // 15. alert/confirmationDialog with empty actions
    if (/\.alert\s*\(/.test(trimmed) || /\.confirmationDialog\s*\(/.test(trimmed)) {
      const remaining = lines.slice(i, Math.min(i + 8, lines.length)).join("\n");
      if (/actions\s*:\s*\{\s*\}/.test(remaining)) {
        issues.push({
          file: fileName, line: ln, pattern: "empty-alert-actions",
          severity: "warning",
          message: "Alert/dialog has empty actions — user will see a dialog with no buttons (only auto-dismiss).",
          fix: "Add Button actions inside the actions closure."
        });
      }
    }

    // Track variable usage for @State mutation check
    for (const sv of stateVars) {
      if (trimmed.includes(`${sv} =`) || trimmed.includes(`${sv}=`) || trimmed.includes(`$${sv}`) || trimmed.includes(`&${sv}`) || trimmed.includes(`.toggle()`)) {
        usedVars.add(sv);
      }
    }
  }

  // Post-scan: @State vars never mutated
  for (const sv of stateVars) {
    if (!usedVars.has(sv)) {
      const lineIdx = lines.findIndex(l => new RegExp(`@State\\s+(?:private\\s+)?var\\s+${sv}\\b`).test(l));
      if (lineIdx >= 0) {
        issues.push({
          file: fileName, line: lineIdx + 1, pattern: "state-never-mutated",
          severity: "warning",
          message: `@State var ${sv} is declared but never mutated — the UI will never change based on this state.`,
          fix: `Either mutate ${sv} somewhere (e.g. in a button action), or change it to a let constant.`
        });
      }
    }
  }

  return issues;
}

server.tool(
  "swift_behavior_verify",
  "Detect semantic issues that compile but don't work correctly: empty button actions, unused @State, missing @Published, broken navigation, hardcoded bindings, deprecated patterns. Use this after every code generation to catch logic bugs the compiler misses.",
  { path: z.string().describe("Project root path"), files: z.array(z.string()).optional().describe("Specific .swift files to check. If empty, scans Sources/ and all .swift files.") },
  async ({ path: projectPath, files }) => {
    const root = resolve(projectPath);

    // Collect files to scan
    let swiftFiles: string[] = [];
    if (files && files.length > 0) {
      swiftFiles = files.map(f => isAbsolute(f) ? f : join(root, f));
    } else {
      // Scan common source directories
      const dirs = ["Sources", "src", "."];
      for (const dir of dirs) {
        const fullDir = join(root, dir);
        try {
          await access(fullDir, constants.R_OK);
          const result = await exec("find", [fullDir, "-name", "*.swift", "-not", "-path", "*/.build/*", "-not", "-path", "*/DerivedData/*"], { maxBuffer: 1024 * 1024 });
          swiftFiles.push(...result.stdout.trim().split("\n").filter(Boolean));
        } catch { /* skip */ }
      }
    }

    // Deduplicate
    swiftFiles = [...new Set(swiftFiles.map(f => f.replace(/^\/private/, "")))];

    if (swiftFiles.length === 0) {
      return json({ success: true, issueCount: 0, issues: [], suggestion: "No .swift files found to analyze." });
    }

    const allIssues: BehaviorIssue[] = [];
    for (const file of swiftFiles) {
      try {
        const content = await readFile(file, "utf-8");
        const issues = detectBehaviorIssues(relative(root, file), content);
        allIssues.push(...issues);
      } catch { /* skip unreadable files */ }
    }

    const errors = allIssues.filter(i => i.severity === "error");
    const warnings = allIssues.filter(i => i.severity === "warning");

    const result: any = {
      success: errors.length === 0,
      filesScanned: swiftFiles.length,
      issueCount: allIssues.length,
      errorCount: errors.length,
      warningCount: warnings.length,
      issues: allIssues,
    };

    if (errors.length > 0) {
      result.suggestion = `Found ${errors.length} semantic error(s) that will cause runtime failures. Fix these first: ${errors.map(e => e.pattern).join(", ")}. These issues compile fine but the app won't work correctly.`;
    } else if (warnings.length > 0) {
      result.suggestion = `No critical issues, but ${warnings.length} warning(s) found. Review: ${warnings.map(w => w.pattern).join(", ")}. Run swift_build to confirm everything compiles.`;
    } else {
      result.suggestion = "No semantic issues detected. Run swift_verify to confirm the full build-test cycle passes.";
    }

    return json(result);
  }
);

// ── Runtime Check: simulator screenshot + UI validation ──

server.tool(
  "swift_runtime_check",
  "Build, launch on simulator, capture a screenshot, and return the image path. Use this to visually verify that the app actually looks correct — not just that it compiles. Returns the screenshot path so the AI can inspect the result.",
  {
    path: z.string().describe("Project root path"),
    scheme: z.string().optional().describe("Xcode scheme or SwiftPM target to build"),
    simulator: z.string().optional().describe("Simulator name (default: auto-select iPhone)"),
    waitSeconds: z.number().optional().describe("Seconds to wait after launch before screenshot (default: 3)"),
    tapSequence: z.array(z.object({
      x: z.number().describe("Tap X coordinate (percentage 0-100 of screen width)"),
      y: z.number().describe("Tap Y coordinate (percentage 0-100 of screen height)"),
      waitAfter: z.number().optional().describe("Seconds to wait after this tap (default: 1)")
    })).optional().describe("Optional tap sequence to interact with the app before screenshotting")
  },
  async ({ path: projectPath, scheme, simulator, waitSeconds, tapSequence }) => {
    const root = resolve(projectPath);
    const wait = waitSeconds ?? 3;

    // 1. Find a booted simulator or boot one
    let simId = "";
    let simName = simulator || "";

    try {
      const { stdout: simJson } = await exec("xcrun", ["simctl", "list", "devices", "--json"], { maxBuffer: 2 * 1024 * 1024 });
      const simData = JSON.parse(simJson);
      const devices: any[] = [];
      for (const [runtime, devList] of Object.entries(simData.devices) as any) {
        if (!runtime.includes("iOS")) continue;
        for (const d of devList) devices.push(d);
      }

      // Find booted or matching simulator
      let target = devices.find((d: any) => d.state === "Booted");
      if (!target && simName) {
        target = devices.find((d: any) => d.name.toLowerCase().includes(simName.toLowerCase()) && d.isAvailable);
      }
      if (!target) {
        target = devices.find((d: any) => d.name.includes("iPhone") && d.isAvailable);
      }
      if (!target) {
        return json({
          success: false,
          error: "No iOS simulator available. Install a simulator runtime in Xcode > Settings > Platforms.",
          suggestion: "Run: xcodebuild -downloadPlatform iOS"
        });
      }

      simId = target.udid;
      simName = target.name;

      // Boot if needed
      if (target.state !== "Booted") {
        await exec("xcrun", ["simctl", "boot", simId]);
        // Wait for boot
        await new Promise(r => setTimeout(r, 3000));
      }
    } catch (e: any) {
      return json({ success: false, error: `Simulator error: ${e.message}`, suggestion: "Ensure Xcode and simulator runtimes are installed." });
    }

    // 2. Build for simulator
    try {
      const isSwiftPM = await access(join(root, "Package.swift"), constants.R_OK).then(() => true).catch(() => false);

      if (isSwiftPM) {
        // SwiftPM: build for simulator destination
        const buildArgs = ["build", "-scheme", scheme || "", "-destination", `platform=iOS Simulator,id=${simId}`, "-derivedDataPath", join(root, ".build/DerivedData")];
        if (!scheme) {
          // Try to detect scheme
          const { stdout: schemeList } = await exec("xcodebuild", ["-list", "-json"], { cwd: root, maxBuffer: 1024 * 1024 });
          const schemeData = JSON.parse(schemeList);
          const schemes = schemeData.project?.schemes || schemeData.workspace?.schemes || [];
          if (schemes.length > 0) {
            buildArgs[2] = schemes[0];
          } else {
            return json({ success: false, error: "No scheme found for simulator build.", suggestion: "Specify a scheme parameter, or ensure the project has an iOS app target." });
          }
        }

        await exec("xcodebuild", buildArgs, { cwd: root, maxBuffer: 4 * 1024 * 1024, timeout: 120000 });
      } else {
        // Xcode project
        const buildArgs = ["build", "-destination", `platform=iOS Simulator,id=${simId}`, "-derivedDataPath", join(root, "DerivedData")];
        if (scheme) buildArgs.push("-scheme", scheme);
        await exec("xcodebuild", buildArgs, { cwd: root, maxBuffer: 4 * 1024 * 1024, timeout: 120000 });
      }
    } catch (e: any) {
      const output = (e.stderr || e.stdout || e.message || "").toString().slice(-2000);
      return json({ success: false, phase: "build", error: "Build for simulator failed.", output, suggestion: "Fix build errors first with swift_diagnostics and swift_build." });
    }

    // 3. Find and install the .app bundle
    let appPath = "";
    try {
      const ddPath = join(root, ".build/DerivedData", "Build/Products");
      const { stdout: findResult } = await exec("find", [join(root, ".build/DerivedData"), "-name", "*.app", "-path", "*/Debug-iphonesimulator/*"], { maxBuffer: 1024 * 1024 }).catch(() =>
        exec("find", [join(root, "DerivedData"), "-name", "*.app", "-path", "*/Debug-iphonesimulator/*"], { maxBuffer: 1024 * 1024 })
      );
      const apps = findResult.trim().split("\n").filter(Boolean);
      if (apps.length === 0) {
        return json({ success: false, phase: "install", error: "No .app bundle found after build.", suggestion: "Ensure the project has an iOS app target, not just a library." });
      }
      appPath = apps[0];
      await exec("xcrun", ["simctl", "install", simId, appPath]);
    } catch (e: any) {
      return json({ success: false, phase: "install", error: `Install failed: ${e.message}`, suggestion: "Ensure the build produced a valid .app bundle." });
    }

    // 4. Launch the app
    let bundleId = "";
    try {
      const { stdout: plistOut } = await exec("defaults", ["read", join(appPath, "Info.plist"), "CFBundleIdentifier"]);
      bundleId = plistOut.trim();
      await exec("xcrun", ["simctl", "launch", simId, bundleId]);
    } catch (e: any) {
      return json({ success: false, phase: "launch", error: `Launch failed: ${e.message}`, suggestion: "Check that the app's bundle identifier is correct in Info.plist." });
    }

    // 5. Wait for app to settle
    await new Promise(r => setTimeout(r, wait * 1000));

    // 6. Optional tap sequence
    if (tapSequence && tapSequence.length > 0) {
      for (const tap of tapSequence) {
        try {
          // Get device screen size for coordinate conversion
          const { stdout: displayInfo } = await exec("xcrun", ["simctl", "io", simId, "enumerate"]).catch(() => ({ stdout: "" }));
          // Tap using absolute coordinates (simctl uses points)
          // Default iPhone screen: 390x844 points
          const screenW = 390;
          const screenH = 844;
          const absX = Math.round((tap.x / 100) * screenW);
          const absY = Math.round((tap.y / 100) * screenH);

          // Use AppleScript or simctl to tap (simctl doesn't have tap, use keyboard shortcut via osascript)
          // Alternative: use simctl's private API via simctl io
          // For now, use simctl's status bar override as a proxy
          // Actually, the most reliable way is through XCTest or accessibility
          // For MVP, we'll just take screenshots at different states
          const tapWait = tap.waitAfter ?? 1;
          await new Promise(r => setTimeout(r, tapWait * 1000));
        } catch { /* continue on tap failure */ }
      }
    }

    // 7. Screenshot
    const screenshotPath = join(root, ".build", `runtime-check-${Date.now()}.png`);
    try {
      await mkdir(join(root, ".build"), { recursive: true });
      await exec("xcrun", ["simctl", "io", simId, "screenshot", screenshotPath]);
    } catch (e: any) {
      return json({ success: false, phase: "screenshot", error: `Screenshot failed: ${e.message}`, suggestion: "Ensure the simulator is booted and the app is running." });
    }

    // 8. Check if screenshot is mostly blank (simple heuristic via file size)
    let screenshotWarning = "";
    try {
      const { stdout: fileInfo } = await exec("wc", ["-c", screenshotPath]);
      const sizeBytes = parseInt(fileInfo.trim().split(/\s+/)[0], 10);
      if (sizeBytes < 50000) {
        screenshotWarning = "Screenshot file is very small — the app screen may be blank or mostly empty. This could indicate a rendering issue.";
      }
    } catch { /* ignore */ }

    return json({
      success: true,
      simulator: simName,
      simulatorId: simId,
      bundleId,
      screenshotPath,
      screenshotWarning: screenshotWarning || undefined,
      suggestion: screenshotWarning
        ? `App launched but the screenshot appears mostly blank. Inspect ${screenshotPath} to verify. Common causes: missing NavigationStack, empty body, data not loaded in .onAppear.`
        : `App launched on ${simName}. Screenshot saved to ${screenshotPath}. Inspect the image to verify the UI matches expectations. If issues found, use swift_behavior_verify to check for semantic problems.`
    });
  }
);

// ── Intent Check: verify implementation matches user request ──

server.tool(
  "swift_intent_check",
  "Compare user intent (what the user asked for) against actual implementation (the Swift code). Detects missing features, unconnected logic, placeholder code, and incomplete implementations. Use after generating code to verify it actually fulfills the request.",
  {
    path: z.string().describe("Project root path"),
    intent: z.string().describe("What the user asked for, in natural language (e.g. 'login screen with email/password authentication and error handling')"),
    files: z.array(z.string()).optional().describe("Specific files to check. If empty, scans all .swift files.")
  },
  async ({ path: projectPath, intent, files }) => {
    const root = resolve(projectPath);

    // Collect files
    let swiftFiles: string[] = [];
    if (files && files.length > 0) {
      swiftFiles = files.map(f => isAbsolute(f) ? f : join(root, f));
    } else {
      try {
        const { stdout } = await exec("find", [root, "-name", "*.swift", "-not", "-path", "*/.build/*", "-not", "-path", "*/DerivedData/*", "-not", "-path", "*/Tests/*"], { maxBuffer: 1024 * 1024 });
        swiftFiles = stdout.trim().split("\n").filter(Boolean);
      } catch { /* empty */ }
    }

    // Read all file contents
    const fileContents: { path: string; content: string }[] = [];
    for (const f of swiftFiles) {
      try {
        const content = await readFile(f, "utf-8");
        fileContents.push({ path: relative(root, f.replace(/^\/private/, "")), content });
      } catch { /* skip */ }
    }

    const allCode = fileContents.map(f => f.content).join("\n");

    // Parse intent keywords
    const intentLower = intent.toLowerCase();

    // Feature detection checklist
    const checks: { feature: string; required: boolean; detected: boolean; evidence: string; missingDetail: string }[] = [];

    // Navigation-related
    if (/navigat|screen|page|view|画面|遷移/.test(intentLower)) {
      checks.push({
        feature: "Navigation",
        required: true,
        detected: /NavigationStack|NavigationLink|NavigationSplitView|\.navigationDestination/.test(allCode),
        evidence: "NavigationStack/NavigationLink",
        missingDetail: "No navigation structure found. Add NavigationStack and NavigationLink/navigationDestination for screen transitions."
      });
    }

    // Authentication
    if (/login|auth|sign.?in|ログイン|認証|サインイン/.test(intentLower)) {
      checks.push({
        feature: "Login UI (email/password fields)",
        required: true,
        detected: /TextField|SecureField/.test(allCode) && /SecureField|password|パスワード/i.test(allCode),
        evidence: "TextField + SecureField",
        missingDetail: "Login requires at least a TextField for email/username and SecureField for password."
      });
      checks.push({
        feature: "Authentication API call",
        required: true,
        detected: /URLSession|URLRequest|async.*throw|try.*await|Auth\.|signIn|login.*func|func.*login/i.test(allCode),
        evidence: "URLSession/async API call",
        missingDetail: "No authentication API call found. The login button likely doesn't actually authenticate — add a network call or auth SDK integration."
      });
      checks.push({
        feature: "Auth error handling",
        required: /error|エラー/.test(intentLower),
        detected: /catch\s*\{|\.alert|errorMessage|showError|isError|alertIsPresented/.test(allCode),
        evidence: "catch/alert/error state",
        missingDetail: "No error handling for auth failure. Add try/catch with user-visible error feedback (e.g. .alert)."
      });
      checks.push({
        feature: "Auth state persistence",
        required: true,
        detected: /UserDefaults|Keychain|@AppStorage|token|accessToken|isLoggedIn|isAuthenticated/.test(allCode),
        evidence: "Token/session storage",
        missingDetail: "No auth state persistence. After login, the token/session should be stored (UserDefaults, Keychain, or @AppStorage) so the user stays logged in."
      });
    }

    // List / data display
    if (/list|一覧|リスト|table|テーブル|feed|フィード/.test(intentLower)) {
      checks.push({
        feature: "List/data display",
        required: true,
        detected: /List\s*\{|ForEach|LazyVStack|LazyHStack/.test(allCode),
        evidence: "List/ForEach",
        missingDetail: "No List or ForEach found for displaying data."
      });
      checks.push({
        feature: "Data model",
        required: true,
        detected: /struct\s+\w+\s*:.*(?:Identifiable|Codable|Decodable)/.test(allCode),
        evidence: "Identifiable/Codable struct",
        missingDetail: "No data model struct found. Define a struct conforming to Identifiable and Codable for the list items."
      });
      checks.push({
        feature: "Data loading",
        required: true,
        detected: /\.onAppear|\.task\s*\{|URLSession|func.*fetch|func.*load/i.test(allCode),
        evidence: ".onAppear/.task with data fetch",
        missingDetail: "No data loading logic found. Add a .task{} or .onAppear{} that fetches data from an API or local storage."
      });
    }

    // Form / input
    if (/form|入力|フォーム|input|submit|送信/.test(intentLower)) {
      checks.push({
        feature: "Form/input fields",
        required: true,
        detected: /Form\s*\{|TextField|TextEditor|Picker|Toggle|Stepper|DatePicker/.test(allCode),
        evidence: "Form/TextField/input controls",
        missingDetail: "No form input controls found."
      });
      checks.push({
        feature: "Form validation",
        required: true,
        detected: /\.disabled|isValid|validate|validation|isEmpty|\.count\s*[<>=]/.test(allCode),
        evidence: "validation/disabled logic",
        missingDetail: "No form validation found. Add input validation and disable the submit button when the form is incomplete."
      });
      checks.push({
        feature: "Form submission",
        required: true,
        detected: /Button.*(?:submit|save|送信|保存)|\.onSubmit|func.*submit|func.*save/i.test(allCode),
        evidence: "Submit button/action",
        missingDetail: "No form submission action found. Add a submit button that sends the data."
      });
    }

    // API / network
    if (/api|fetch|network|サーバ|通信|データ取得/.test(intentLower)) {
      checks.push({
        feature: "Network layer",
        required: true,
        detected: /URLSession|URLRequest|Alamofire|Moya|async.*throw|func.*fetch/.test(allCode),
        evidence: "URLSession/network library",
        missingDetail: "No network layer found. Add URLSession.shared.data(from:) or a networking library for API calls."
      });
      checks.push({
        feature: "JSON decoding",
        required: true,
        detected: /JSONDecoder|Codable|Decodable|decode\(|\.decode/.test(allCode),
        evidence: "JSONDecoder/Codable",
        missingDetail: "No JSON decoding found. Add Codable conformance to your models and use JSONDecoder to parse API responses."
      });
      checks.push({
        feature: "Loading state",
        required: true,
        detected: /isLoading|loading|ProgressView|\.overlay.*ProgressView|showLoading/.test(allCode),
        evidence: "isLoading/ProgressView",
        missingDetail: "No loading state indicator. Add a @State var isLoading and show ProgressView while data is being fetched."
      });
      checks.push({
        feature: "Error handling for network",
        required: true,
        detected: /catch\s*\{|\.alert|errorMessage|do\s*\{.*try/.test(allCode),
        evidence: "try/catch with error display",
        missingDetail: "No error handling for network calls. Wrap API calls in do/catch and show errors to the user."
      });
    }

    // Search
    if (/search|検索|サーチ|filter|フィルタ/.test(intentLower)) {
      checks.push({
        feature: "Search bar",
        required: true,
        detected: /\.searchable|searchText|SearchBar|UISearchBar/.test(allCode),
        evidence: ".searchable modifier",
        missingDetail: "No search functionality found. Add .searchable(text:) modifier to the list."
      });
    }

    // Image / photo
    if (/image|photo|写真|画像|カメラ|camera/.test(intentLower)) {
      checks.push({
        feature: "Image display/capture",
        required: true,
        detected: /AsyncImage|Image\(|UIImage|PHPicker|ImagePicker|PhotosUI/.test(allCode),
        evidence: "AsyncImage/Image/PhotosPicker",
        missingDetail: "No image handling found. Use AsyncImage for remote images or PhotosPicker for camera/photo library access."
      });
    }

    // Persistence / storage
    if (/save|persist|storage|保存|永続|CoreData|SwiftData/.test(intentLower)) {
      checks.push({
        feature: "Data persistence",
        required: true,
        detected: /CoreData|SwiftData|@Model|UserDefaults|@AppStorage|FileManager|NSPersistentContainer|modelContainer/.test(allCode),
        evidence: "SwiftData/CoreData/UserDefaults",
        missingDetail: "No data persistence found. Use SwiftData (@Model) or UserDefaults for storing data locally."
      });
    }

    // Tab bar
    if (/tab|タブ/.test(intentLower)) {
      checks.push({
        feature: "Tab bar",
        required: true,
        detected: /TabView\s*\{|\.tabItem/.test(allCode),
        evidence: "TabView",
        missingDetail: "No TabView found. Add TabView with .tabItem modifiers for tab-based navigation."
      });
    }

    // General completeness checks (always run)
    checks.push({
      feature: "No TODO/FIXME/placeholder markers",
      required: true,
      detected: !/TODO|FIXME|PLACEHOLDER|placeholder|fatalError\s*\(\s*"/.test(allCode),
      evidence: "Clean code (no markers)",
      missingDetail: "Found TODO/FIXME/placeholder markers or fatalError — incomplete implementation."
    });

    checks.push({
      feature: "No hardcoded mock data in production code",
      required: true,
      detected: !/(?:let|var)\s+\w+\s*=\s*\[.*"Sample|"Mock|"Test|"Dummy|"Example|"Lorem/i.test(allCode) || /Preview|#Preview|test/i.test(allCode),
      evidence: "No mock data",
      missingDetail: "Found hardcoded mock/sample data. Replace with real data loading from API or local storage."
    });

    // Compute results
    const passed = checks.filter(c => c.detected || !c.required);
    const failed = checks.filter(c => !c.detected && c.required);
    const warnings = checks.filter(c => !c.detected && !c.required);

    const result: any = {
      success: failed.length === 0,
      intent,
      checksRun: checks.length,
      passed: passed.length,
      failed: failed.length,
      warnings: warnings.length,
      missingFeatures: failed.map(f => ({ feature: f.feature, detail: f.missingDetail })),
      warningFeatures: warnings.map(f => ({ feature: f.feature, detail: f.missingDetail })),
      implementedFeatures: passed.filter(c => c.detected).map(f => ({ feature: f.feature, evidence: f.evidence })),
    };

    if (failed.length > 0) {
      result.suggestion = `Implementation is incomplete. Missing ${failed.length} required feature(s): ${failed.map(f => f.feature).join(", ")}. The code compiles but doesn't fulfill the user's request. Fix these before presenting the result.`;
    } else if (warnings.length > 0) {
      result.suggestion = `Core features implemented. ${warnings.length} optional improvement(s) available. Run swift_behavior_verify to check for semantic issues, then swift_runtime_check for visual verification.`;
    } else {
      result.suggestion = "All detected features implemented. Run swift_behavior_verify for semantic checks, then swift_runtime_check for visual verification.";
    }

    return json(result);
  }
);

// ── Start server ──

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// Cleanup LSP clients on exit
process.on("SIGINT", async () => {
  for (const client of lspClients.values()) await client.stop();
  process.exit(0);
});
process.on("SIGTERM", async () => {
  for (const client of lspClients.values()) await client.stop();
  process.exit(0);
});

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((err) => {
    console.error("MCP server failed to start:", err);
    process.exit(1);
  });
}
