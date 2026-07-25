/**
 * Turns Codex review findings plus a verification pass into a gate decision.
 *
 * Codex emits four severities against `schemas/review-output.schema.json`, but
 * `parseStructuredOutput` never validates against that schema, so a finding can
 * arrive with a missing or unrecognized severity. This module fails closed on
 * that rather than letting it through as harmless.
 *
 * The rule that makes the review loop terminate: a finding blocks only when a
 * verification pass CONFIRMED it against the codebase. Without that, a single
 * hallucinated critical finding would block forever, because no fix can make a
 * defect that does not exist stop being reported.
 */

const BLOCKING_CODEX_SEVERITIES = new Set(["critical", "high"]);
const KNOWN_CODEX_SEVERITIES = new Set(["critical", "high", "medium", "low"]);
const MAX_NITS = 5;
const DEFAULT_MAX_ITERATIONS = 3;

/**
 * Maps a Codex severity onto the fleet's three tiers (see docs-control REVIEW.md).
 * An unrecognized or missing severity maps to `high`, so malformed output is
 * treated as blocking rather than ignored.
 *
 * @param {string | null | undefined} codexSeverity
 * @returns {"high" | "medium" | "low"}
 */
export function mapSeverity(codexSeverity) {
  if (!KNOWN_CODEX_SEVERITIES.has(codexSeverity)) {
    return "high";
  }
  if (BLOCKING_CODEX_SEVERITIES.has(codexSeverity)) {
    return "high";
  }
  return codexSeverity === "medium" ? "medium" : "low";
}

function assertFindingShape(finding, index) {
  if (!finding || typeof finding !== "object" || Array.isArray(finding)) {
    throw new Error(`findings[${index}] must be an object.`);
  }
  for (const key of ["title", "file"]) {
    if (typeof finding[key] !== "string" || !finding[key]) {
      throw new Error(`findings[${index}] is missing a "${key}".`);
    }
  }
}

/**
 * @param {Record<string, unknown>} finding
 * @param {Record<string, unknown> | undefined} verification
 */
export function classifyFinding(finding, verification) {
  const fleetSeverity = mapSeverity(finding?.severity);
  const wouldBlock = fleetSeverity === "high";
  const base = {
    key: findingKey(finding),
    title: finding?.title ?? "(untitled finding)",
    file: finding?.file ?? null,
    line_start: finding?.line_start ?? null,
    line_end: finding?.line_end ?? null,
    codexSeverity: finding?.severity ?? null,
    fleetSeverity,
    confidence: finding?.confidence ?? null,
    humanFlag: false,
    evidence: verification?.evidence ?? verification?.testEvidence ?? null
  };

  // Nobody looked. That is a process failure, not a pass.
  if (!verification || typeof verification !== "object") {
    return {
      ...base,
      status: "NOT_VERIFIED",
      blocking: wouldBlock,
      humanFlag: wouldBlock,
      reason: wouldBlock
        ? "not verified — a blocking finding must be checked against the codebase before it can be dismissed"
        : "not verified"
    };
  }

  const status = String(verification.status ?? "").toUpperCase();

  if (status === "REFUTED") {
    return {
      ...base,
      status: "REFUTED",
      fleetSeverity: "dismissed",
      blocking: false,
      reason: "refuted against the codebase"
    };
  }

  if (status === "UNVERIFIED") {
    return {
      ...base,
      status: "UNVERIFIED",
      // Could not be proven either way: report it, flag it, but do not block on it.
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
    return { ...base, status: "CONFIRMED", blocking: false, reason: "confirmed, below the blocking bar" };
  }

  const hasTest = Boolean(verification.testEvidence);
  if (verification.resolved && !hasTest) {
    return {
      ...base,
      status: "CONFIRMED",
      blocking: true,
      reason: "claimed fixed without a test proving the defect existed"
    };
  }

  if (verification.resolved) {
    return { ...base, status: "CONFIRMED", blocking: false, reason: "fixed, with a test as evidence" };
  }

  return { ...base, status: "CONFIRMED", blocking: true, reason: "confirmed and not yet fixed" };
}

/**
 * The stable identity of a finding. Titles alone are not unique — the same defect
 * class legitimately appears in two files — so a title-keyed verification record
 * would otherwise be applied to findings it was never about.
 *
 * @param {Record<string, unknown>} finding
 * @returns {string}
 */
export function findingKey(finding) {
  return `${finding?.file}:${finding?.line_start}:${finding?.title}`;
}

/**
 * Resolves the verification for one finding. Prefers the composite key; falls back
 * to the bare title only when that title is unambiguous across this review, so a
 * hand-written title-keyed record stays convenient without becoming unsafe.
 */
function lookupVerification(lookup, finding, titleCounts) {
  const composite = lookup[findingKey(finding)];
  if (composite) {
    return composite;
  }
  const title = String(finding?.title);
  if (titleCounts.get(title) === 1) {
    return lookup[title];
  }
  return undefined;
}

/**
 * @param {Array<Record<string, unknown>>} findings
 * @param {Record<string, Record<string, unknown>>} verifications keyed by `findingKey`, or by
 *   title when that title is unique in this review
 * @param {{iteration?: number, maxIterations?: number, previousBlocking?: string[],
 *   suiteStatus?: "pass" | "fail" | "unknown"}} options
 *   `previousBlocking` carries the keys that blocked the previous iteration. Each must be
 *   accounted for again this iteration — a blocker that simply stops being reported is not
 *   evidence that it was fixed.
 */
export function summarizeGate(findings, verifications = {}, options = {}) {
  if (!Array.isArray(findings)) {
    throw new Error("findings must be an array.");
  }
  findings.forEach(assertFindingShape);

  const iteration = Number(options.iteration ?? 1);
  const maxIterations = Number(options.maxIterations ?? DEFAULT_MAX_ITERATIONS);
  const lookup = verifications && typeof verifications === "object" ? verifications : {};

  const titleCounts = new Map();
  for (const finding of findings) {
    const title = String(finding.title);
    titleCounts.set(title, (titleCounts.get(title) ?? 0) + 1);
  }

  const classified = findings.map((finding) =>
    classifyFinding(finding, lookupVerification(lookup, finding, titleCounts))
  );

  const dismissed = classified.filter((entry) => entry.status === "REFUTED");
  const rest = classified.filter((entry) => !entry.blocking && entry.status !== "REFUTED");
  const reported = rest.filter((entry) => entry.fleetSeverity === "medium");
  const allNits = rest.filter((entry) => entry.fleetSeverity === "low");

  const previousBlocking = Array.isArray(options.previousBlocking) ? options.previousBlocking : null;

  // A blocker that stops being reported has not been proven fixed. Reviews are not
  // deterministic: a finding can vanish because the diff moved, because the model
  // sampled differently, or because it was genuinely resolved. Only the last of
  // those is done, so carry each one forward until this iteration accounts for it.
  const seenKeys = new Set(classified.map((entry) => entry.key));
  const seenTitles = new Set(classified.map((entry) => entry.title));
  const carriedForward = (previousBlocking ?? [])
    .filter((key) => !seenKeys.has(key) && !seenTitles.has(key))
    .map((key) => {
      const verification = lookup[key];
      const status = String(verification?.status ?? "").toUpperCase();
      const settled =
        status === "REFUTED" || (status === "CONFIRMED" && verification?.resolved && verification?.testEvidence);
      return {
        key,
        title: key,
        file: null,
        line_start: null,
        line_end: null,
        codexSeverity: null,
        fleetSeverity: settled ? "dismissed" : "high",
        confidence: null,
        humanFlag: !settled,
        evidence: verification?.evidence ?? verification?.testEvidence ?? null,
        status: settled ? String(verification.status).toUpperCase() : "CARRIED_FORWARD",
        settledAs: settled ? (status === "REFUTED" ? "refuted" : "fixed") : null,
        blocking: !settled,
        reason: settled
          ? "carried forward from an earlier iteration and settled"
          : "blocked in an earlier iteration and disappeared without a verified fix"
      };
    });

  const blocking = [...classified.filter((entry) => entry.blocking), ...carriedForward.filter((entry) => entry.blocking)];
  const blockingKeys = blocking.map((entry) => entry.key ?? entry.title).sort();
  const blockingTitles = blocking.map((entry) => entry.title).sort();
  // `previousBlocking` may be written by hand, so accept either the composite keys
  // this function emits or the bare titles a person would reach for.
  const previousSorted = previousBlocking === null ? null : [...previousBlocking].sort();
  const noProgress =
    blocking.length > 0 &&
    previousSorted !== null &&
    (sameSet(blockingKeys, previousSorted) || sameSet(blockingTitles, previousSorted));

  let reason = null;
  // `>=`, not `>`: reaching the last permitted iteration with blockers outstanding is
  // itself the escalation. `>` would quietly run one more round than advertised.
  if (blocking.length > 0 && iteration >= maxIterations) {
    reason = "max-iterations";
  } else if (noProgress) {
    reason = "no-progress";
  }

  // Clearing the findings is not the whole exit contract: the repository's own suite has
  // to pass too. Nobody claiming it passed is not the same as it passing, so an absent
  // status keeps the loop open rather than closing it optimistically.
  const suiteStatus = String(options.suiteStatus ?? "unknown").toLowerCase();
  const findingsClear = blocking.length === 0;
  const suitePassed = suiteStatus === "pass";
  if (findingsClear && !suitePassed && reason === null) {
    reason = suiteStatus === "fail" ? "suite-failing" : "suite-status-unknown";
  }

  return {
    iteration,
    maxIterations,
    blocking,
    reported,
    nits: allNits.slice(0, MAX_NITS),
    nitOverflow: Math.max(0, allNits.length - MAX_NITS),
    humanFlags: [...classified, ...carriedForward].filter((entry) => entry.humanFlag),
    dismissed: [...dismissed, ...carriedForward.filter((entry) => entry.settledAs === "refuted")],
    resolved: carriedForward.filter((entry) => entry.settledAs === "fixed"),
    blockingKeys,
    blockingTitles,
    suiteStatus,
    findingsClear,
    done: findingsClear && suitePassed,
    escalate: reason === "max-iterations" || reason === "no-progress",
    reason
  };
}

function sameSet(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
