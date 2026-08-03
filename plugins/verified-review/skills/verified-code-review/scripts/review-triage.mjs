const BLOCKING_SEVERITIES = new Set(["critical", "high"]);
const KNOWN_SEVERITIES = new Set(["critical", "high", "medium", "low"]);
const MAX_NITS = 5;
const DEFAULT_MAX_ITERATIONS = 3;

export function mapSeverity(severity) {
  if (!KNOWN_SEVERITIES.has(severity) || BLOCKING_SEVERITIES.has(severity)) {
    return "high";
  }
  return severity === "medium" ? "medium" : "low";
}

export function findingKey(finding) {
  return `${finding?.file}:${finding?.line_start}:${finding?.title}`;
}

function assertFinding(finding, index) {
  if (!finding || typeof finding !== "object" || Array.isArray(finding)) {
    throw new Error(`findings[${index}] must be an object.`);
  }
  for (const key of ["title", "file"]) {
    if (typeof finding[key] !== "string" || !finding[key]) {
      throw new Error(`findings[${index}] is missing a "${key}".`);
    }
  }
}

export function classifyFinding(finding, verification) {
  const fleetSeverity = mapSeverity(finding?.severity);
  const wouldBlock = fleetSeverity === "high";
  const base = {
    key: findingKey(finding),
    title: finding?.title ?? "(untitled finding)",
    file: finding?.file ?? null,
    line_start: finding?.line_start ?? null,
    line_end: finding?.line_end ?? null,
    reviewerSeverity: finding?.severity ?? null,
    fleetSeverity,
    confidence: finding?.confidence ?? null,
    humanFlag: false,
    evidence: verification?.evidence ?? verification?.testEvidence ?? null
  };

  if (!verification || typeof verification !== "object") {
    return {
      ...base,
      status: "NOT_VERIFIED",
      blocking: wouldBlock,
      humanFlag: wouldBlock,
      reason: wouldBlock ? "blocking finding was not verified" : "not verified"
    };
  }

  const status = String(verification.status ?? "").toUpperCase();
  if (status === "REFUTED") {
    return {
      ...base,
      status,
      fleetSeverity: "dismissed",
      blocking: false,
      reason: "refuted against the repository"
    };
  }
  if (status === "UNVERIFIED") {
    return {
      ...base,
      status,
      fleetSeverity: wouldBlock ? "medium" : fleetSeverity,
      blocking: false,
      humanFlag: wouldBlock,
      reason: "could not be verified either way"
    };
  }
  if (status !== "CONFIRMED") {
    return {
      ...base,
      status: "NOT_VERIFIED",
      blocking: wouldBlock,
      humanFlag: wouldBlock,
      reason: `unrecognized verification status "${verification.status}"`
    };
  }
  if (!wouldBlock) {
    return { ...base, status, blocking: false, reason: "confirmed below the blocking bar" };
  }
  if (verification.resolved && !verification.testEvidence) {
    return {
      ...base,
      status,
      blocking: true,
      reason: "claimed fixed without test evidence"
    };
  }
  if (verification.resolved) {
    return { ...base, status, blocking: false, reason: "fixed with test evidence" };
  }
  return { ...base, status, blocking: true, reason: "confirmed and not yet fixed" };
}

function lookupVerification(verifications, finding, titleCounts) {
  const byKey = verifications[findingKey(finding)];
  if (byKey) {
    return byKey;
  }
  return titleCounts.get(finding.title) === 1 ? verifications[finding.title] : undefined;
}

function sameSortedValues(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function summarizeGate(findings, verifications = {}, options = {}) {
  if (!Array.isArray(findings)) {
    throw new Error("findings must be an array.");
  }
  findings.forEach(assertFinding);

  const iteration = Number(options.iteration ?? 1);
  const maxIterations = Number(options.maxIterations ?? DEFAULT_MAX_ITERATIONS);
  if (!Number.isInteger(iteration) || iteration < 1 || !Number.isInteger(maxIterations) || maxIterations < 1) {
    throw new Error("iteration and max-iterations must be positive integers.");
  }

  const lookup = verifications && typeof verifications === "object" ? verifications : {};
  const titleCounts = new Map();
  for (const finding of findings) {
    titleCounts.set(finding.title, (titleCounts.get(finding.title) ?? 0) + 1);
  }
  const classified = findings.map((finding) =>
    classifyFinding(finding, lookupVerification(lookup, finding, titleCounts))
  );

  const previousBlocking = Array.isArray(options.previousBlocking) ? options.previousBlocking : null;
  const seenKeys = new Set(classified.map((entry) => entry.key));
  const seenTitles = new Set(classified.map((entry) => entry.title));
  const carried = (previousBlocking ?? [])
    .filter((key) => !seenKeys.has(key) && !seenTitles.has(key))
    .map((key) => {
      const verification = lookup[key];
      const status = String(verification?.status ?? "").toUpperCase();
      const fixed = status === "CONFIRMED" && verification?.resolved && verification?.testEvidence;
      const refuted = status === "REFUTED";
      const settled = fixed || refuted;
      return {
        key,
        title: key,
        file: null,
        line_start: null,
        line_end: null,
        reviewerSeverity: null,
        fleetSeverity: settled ? "dismissed" : "high",
        confidence: null,
        humanFlag: !settled,
        evidence: verification?.evidence ?? verification?.testEvidence ?? null,
        status: settled ? status : "CARRIED_FORWARD",
        settledAs: fixed ? "fixed" : refuted ? "refuted" : null,
        blocking: !settled,
        reason: settled ? "earlier blocker is now settled" : "earlier blocker disappeared without a verified fix"
      };
    });

  const dismissed = classified.filter((entry) => entry.status === "REFUTED");
  const nonBlocking = classified.filter((entry) => !entry.blocking && entry.status !== "REFUTED");
  const blocking = [...classified.filter((entry) => entry.blocking), ...carried.filter((entry) => entry.blocking)];
  const blockingKeys = blocking.map((entry) => entry.key).sort();
  const blockingTitles = blocking.map((entry) => entry.title).sort();
  const previousSorted = previousBlocking === null ? null : [...previousBlocking].sort();
  const noProgress =
    blocking.length > 0 &&
    previousSorted !== null &&
    (sameSortedValues(blockingKeys, previousSorted) || sameSortedValues(blockingTitles, previousSorted));

  let reason = null;
  if (blocking.length > 0 && iteration >= maxIterations) {
    reason = "max-iterations";
  } else if (noProgress) {
    reason = "no-progress";
  }

  const suiteStatus = String(options.suiteStatus ?? "unknown").toLowerCase();
  const findingsClear = blocking.length === 0;
  const suitePassed = suiteStatus === "pass";
  if (findingsClear && !suitePassed && reason === null) {
    reason = suiteStatus === "fail" ? "suite-failing" : "suite-status-unknown";
  }

  const nits = nonBlocking.filter((entry) => entry.fleetSeverity === "low");
  return {
    iteration,
    maxIterations,
    blocking,
    reported: nonBlocking.filter((entry) => entry.fleetSeverity === "medium"),
    nits: nits.slice(0, MAX_NITS),
    nitOverflow: Math.max(0, nits.length - MAX_NITS),
    humanFlags: [...classified, ...carried].filter((entry) => entry.humanFlag),
    dismissed: [...dismissed, ...carried.filter((entry) => entry.settledAs === "refuted")],
    resolved: carried.filter((entry) => entry.settledAs === "fixed"),
    blockingKeys,
    blockingTitles,
    suiteStatus,
    findingsClear,
    done: findingsClear && suitePassed,
    escalate: reason === "max-iterations" || reason === "no-progress",
    reason
  };
}
