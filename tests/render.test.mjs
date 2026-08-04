import test from "node:test";
import assert from "node:assert/strict";

import { renderStoredJobResult, renderTaskResult } from "../plugins/codex/scripts/lib/render.mjs";

test("renderTaskResult returns the Codex final response unchanged", () => {
  assert.equal(renderTaskResult({ rawOutput: "Implemented the fix." }), "Implemented the fix.\n");
});

test("renderStoredJobResult appends resumable session details", () => {
  const output = renderStoredJobResult(
    {
      id: "task-123",
      status: "completed",
      title: "Codex Task",
      jobClass: "task",
      threadId: "thr_123"
    },
    {
      threadId: "thr_123",
      result: { rawOutput: "Implemented the requested migration." }
    }
  );

  assert.match(output, /^Implemented the requested migration\./);
  assert.match(output, /Codex session ID: thr_123/);
  assert.match(output, /Resume in Codex: codex resume thr_123/);
});
