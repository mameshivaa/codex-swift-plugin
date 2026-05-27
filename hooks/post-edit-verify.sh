#!/usr/bin/env bash
# Detect Swift edits and provide an immediate verification loop hint.
set -euo pipefail

HOOK_INPUT=$(cat)
SWIFT_AGENT_HOOK_INPUT="$HOOK_INPUT" python3 - <<'PY'
import json
import os
import re
import subprocess
import sys
from pathlib import Path


EDIT_TOOLS = {"Write", "Edit", "apply_patch", "MultiEdit"}
PATH_KEYS = {"file_path", "path", "filePath", "file"}


def load_input():
    try:
        return json.loads(os.environ.get("SWIFT_AGENT_HOOK_INPUT", "{}"))
    except Exception:
        return {}


def collect_paths(value):
    paths = []
    if isinstance(value, dict):
        for key, child in value.items():
            if key in PATH_KEYS and isinstance(child, str):
                paths.append(child)
            elif key in {"patch", "diff"} and isinstance(child, str):
                paths.extend(parse_patch_paths(child))
            else:
                paths.extend(collect_paths(child))
    elif isinstance(value, list):
        for child in value:
            paths.extend(collect_paths(child))
    return paths


def parse_patch_paths(patch_text):
    paths = []
    for line in patch_text.splitlines():
        match = re.match(r"\*\*\* (?:Add|Update|Delete) File: (.+)$", line)
        if match:
            paths.append(match.group(1).strip())
    return paths


def unique(items):
    seen = set()
    result = []
    for item in items:
        if item and item not in seen:
            seen.add(item)
            result.append(item)
    return result


def find_project_root(path_text):
    path = Path(path_text).expanduser()
    if not path.is_absolute():
        path = Path(os.environ.get("CWD", os.getcwd())) / path
    start = path if path.is_dir() else path.parent
    for candidate in [start, *start.parents]:
        if (candidate / "Package.swift").exists():
            return candidate, "swiftpm"
        try:
            if any(candidate.glob("*.xcworkspace")) or any(candidate.glob("*.xcodeproj")):
                return candidate, "xcode"
        except OSError:
            pass
    return start, "unknown"


def load_config(root):
    for name in [".swift-agent.json", ".swift-agent.jsonc"]:
        path = root / name
        if not path.exists():
            continue
        try:
            raw = re.sub(r"//.*$", "", path.read_text(), flags=re.MULTILINE)
            return json.loads(raw)
        except Exception:
            return {}
    return {}


def env_bool(name):
    value = os.environ.get(name)
    if value is None:
        return None
    return value.lower() not in {"0", "false", "no", "off"}


def tail(text, limit=2400):
    text = text.strip()
    if len(text) <= limit:
        return text
    return text[-limit:]


def run_swiftpm_build(root, timeout_seconds):
    command = ["swift", "build", "--disable-sandbox"]
    module_cache = root / ".build" / "codex-module-cache"
    module_cache.mkdir(parents=True, exist_ok=True)
    env = os.environ.copy()
    env.setdefault("CLANG_MODULE_CACHE_PATH", str(module_cache))
    env.setdefault("SWIFTPM_MODULECACHE_OVERRIDE", str(module_cache))
    try:
        completed = subprocess.run(
            command,
            cwd=str(root),
            env=env,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            timeout=timeout_seconds,
        )
        return {
            "ran": True,
            "command": " ".join(command),
            "success": completed.returncode == 0,
            "exitCode": completed.returncode,
            "outputTail": tail(completed.stdout),
        }
    except subprocess.TimeoutExpired as error:
        return {
            "ran": True,
            "command": " ".join(command),
            "success": False,
            "timedOut": True,
            "timeoutSeconds": timeout_seconds,
            "outputTail": tail(error.stdout or ""),
        }
    except FileNotFoundError:
        return {
            "ran": False,
            "reason": "swift executable was not found on PATH.",
        }


def post_edit_repair_queue(verification, tool_call):
    if verification.get("success"):
        return []

    queue = []
    if verification.get("ran") and verification.get("outputTail"):
        queue.append({
            "sequence": len(queue) + 1,
            "id": "inspect-post-edit-build-output",
            "action": "inspect",
            "required": True,
            "runPolicy": "read-only",
            "stopCondition": "Stop if the output points to a non-source environment problem that swift_verify cannot repair.",
            "source": "postEditVerification",
            "instruction": "Inspect the post-edit SwiftPM build output before deciding whether to edit.",
            "target": {
                "action": "inspect-inline-artifact",
                "artifactKind": "command-output",
                "contentKey": "autoVerification.outputTail",
            },
        })

    queue.append({
        "sequence": len(queue) + 1,
        "id": "verify-post-edit-repair-plan",
        "action": "verify",
        "required": True,
        "runPolicy": "call-tool",
        "stopCondition": "Stop on success; on failure, follow the returned repairExecutionQueue from swift_verify.",
        "toolCall": tool_call,
        "successCondition": "swift_verify succeeds or returns a structured repairPlan with repairExecutionQueue.",
    })
    return queue


data = load_input()
tool_name = data.get("tool_name", "")
if tool_name not in EDIT_TOOLS:
    sys.exit(0)

tool_input = data.get("tool_input", {})
paths = unique(collect_paths(tool_input))
swift_files = [path for path in paths if path.endswith(".swift")]
if not swift_files:
    sys.exit(0)

root, project_type = find_project_root(swift_files[0])
config = load_config(root)
env_auto_verify = env_bool("SWIFT_AGENT_POST_EDIT_VERIFY")
auto_verify = env_auto_verify if env_auto_verify is not None else config.get("postEditVerify", True)
timeout_seconds = int(
    os.environ.get("SWIFT_AGENT_POST_EDIT_TIMEOUT", config.get("postEditVerifyTimeoutSeconds", 25))
)

verification = {
    "ran": False,
    "reason": "Automatic post-edit verification is disabled.",
}
if auto_verify and project_type == "swiftpm":
    verification = run_swiftpm_build(root, timeout_seconds)
elif auto_verify and project_type == "xcode":
    verification = {
        "ran": False,
        "reason": "Xcode post-edit verification should use swift_verify so scheme and destination are explicit.",
    }
elif auto_verify:
    verification = {
        "ran": False,
        "reason": "No SwiftPM or Xcode project root was detected.",
    }

tool_call = {
    "tool": "swift_verify",
    "arguments": {
        "path": str(root),
        "level": "build",
        "includeRepairPlan": True,
    },
}
repair_queue = post_edit_repair_queue(verification, tool_call)

status = "passed" if verification.get("success") else "needs verification"
if verification.get("ran") and not verification.get("success"):
    status = "failed"

context = (
    f"Swift post-edit verification: {status}. "
    f"Changed Swift file(s): {', '.join(Path(path).name for path in swift_files[:5])}. "
    f"Project type: {project_type}. "
    "Follow swiftPostEditVerification.repairExecutionQueue for the next verification step."
)

print(json.dumps({
    "additionalContext": context,
    "swiftPostEditVerification": {
        "changedSwiftFiles": swift_files,
        "projectRoot": str(root),
        "projectType": project_type,
        "autoVerification": verification,
        "recommendedToolCall": tool_call,
        "repairExecutionQueue": repair_queue,
    },
}))
PY
