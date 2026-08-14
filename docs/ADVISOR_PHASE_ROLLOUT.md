# Advisor Improvement Rollout (Phased)

This plan tracks production-safe rollout of advisor quality and responsiveness improvements.

## Phase 1 (Current)

Status: Implemented

Goals:
- Improve response speed for obvious greeting/help intents.
- Keep behavior measurable with lightweight stream metrics.
- Preserve existing FAQ cache and retrieval-first behavior for factual queries.

Changes:
- Added fast-intent path in streaming advisor service.
  - Toggle: `ADVISOR_FAST_INTENT_ENABLED` (default `true`)
- Added in-memory stream metrics counters.
  - Exposed through advisor health endpoint.

Health fields now include:
- `metrics.totalRequests`
- `metrics.fastIntentHits`
- `metrics.faqCacheHits`
- `metrics.llmCalls`
- `metrics.errors`
- `metrics.avgLatencyMs`
- `metrics.p95LatencyMs`

Notes:
- Metrics are in-memory and reset on process restart.
- No schema changes required for Phase 1.

## Phase 2 (Next)

Goals:
- Confidence-aware grounded mode for factual questions.
- Clear fallback behavior when citations/confidence are weak.

Planned controls:
- `ADVISOR_PHASE2_GROUNDED_MODE` (default `false`)
- `ADVISOR_MIN_GROUNDED_CONFIDENCE` (default `0.55`)
- `ADVISOR_MIN_CITATIONS` (default `1`)

Planned behavior:
- Detect likely factual questions.
- If retrieval confidence/citations are weak, ask a clarifying question or provide transparent uncertainty instead of overconfident assertions.
- Emit source metadata (`grounded_mode`, `fallback_reason`) in stream `done.meta`.

## Phase 3 (Current)

Status: Implemented

Goals:
- Retrieval quality upgrades and source ranking policy.
- Better query rewriting and hybrid re-rank diagnostics.

Changes:
- Added canonical query rewriting for common BMU terminology variations.
- Added source-ranking policy to prefer the best document class for fee, programme, and policy questions.
- Added retrieval metadata (`canonicalQuery`, `phase`, `sourcePolicy`) to help compare retrieval quality in production.

Controls:
- `ADVISOR_PHASE3_CANONICAL_REWRITE` (default `true`)
- `ADVISOR_PHASE3_SOURCE_POLICY` (default `true`)

## Phase 4

Status: Implemented

Goals:
- Evaluation harness and regression dashboard.
- Offline benchmark set for answer quality and grounding.

Changes:
- Added heuristic answer-quality scoring (`responseQualityService`) with
  `addressed_score`, `grounding_score`, `citation_score`, `completeness_score`,
  and `overall_score`.
- Added admin quality summary and recent-QA review routes for manual curation.
- Added offline benchmark harness for regression sweeps.

Controls:
- `AUTO_CACHE_MIN_OVERALL` (default `0.84`)
- `AUTO_CACHE_MIN_ADDRESSED` (default `0.72`)
- `AUTO_CACHE_MIN_GROUNDED` (default `0.62`)
- `AUTO_CACHE_BY_SCORE` (default `true`)

Operation:
- Run `npm run bench:advisor` to execute a lightweight benchmark set and print
  pass/fail outcomes for representative fee, programme, and policy questions.

## Phase 5

Status: Implemented

Goals:
- Advanced observability and SLOs.
- Alerting for elevated fallback/error rates.

Changes:
- Added SLO-aware health metrics in the advisor stream pipeline.
- Exposed `slo` state in the advisor health response for alerting and dashboards.
- Added default thresholds for p95 latency and error-rate monitoring.

Controls:
- `ADVISOR_PHASE5_SLO_ENABLED` (default `true`)
- `ADVISOR_SLO_P95_MS` (default `6000`)
- `ADVISOR_SLO_ERROR_RATE_PCT` (default `10`)

State values:
- `ok` = healthy
- `warning` = approaching threshold
- `alert` = above threshold
- `disabled` = monitoring is off

## Phase 6

Status: Implemented

Goals:
- Alerting integration for SLO transitions.
- Operational smoke checks for production health review.

Changes:
- Added structured SLO status transitions that emit console warnings when the
  advisor enters warning/alert states.
- Health responses now include the current SLO state for dashboards and ops review.

## Phase 7

Goals:
- Admin operational dashboard for advisor health, SLOs, and quality summary.
- One-screen health review for production monitoring.

Changes:
- Added `/admin/advisor/health-overview` to combine advisor metrics and quality
  summary for quick operational review.

## Phase 8

Goals:
- Automatic alerting when SLOs enter warning or alert states.
- Production notification path for ops teams without manual polling.

Changes:
- Added webhook/email alert hooks for advisor SLO transitions.
- Configurable via `ADVISOR_ALERT_WEBHOOK` and `ADVISOR_ALERT_EMAIL`.

## Phase 9

Goals:
- Manual alert verification and operational drill procedure.
- One-click alert testing for production operators.

Changes:
- Added admin-only `/admin/advisor/test-alert` to trigger a live warning/alert
  notification using the configured alert transport.

## Phase 10

Goals:
- Operational review export for advisor quality and SLO trends.
- Auditable quality snapshot for admins and reviewers.

Changes:
- Added admin-only `/admin/advisor/quality-export` to export a CSV snapshot of
  advisor quality metrics for review and offline analysis.

## Phase 11

Goals:
- Trend analysis for advisor quality over time.
- Week-by-week monitoring for admin review and regression checks.

Changes:
- Added admin-only `/admin/advisor/quality-trend` to summarise recent quality
  changes by day for the last 7–30 day range.

## Rollback

Immediate rollback knobs:
- Set `ADVISOR_FAST_INTENT_ENABLED=false` to disable fast-intent behavior.
- Existing pipeline remains intact and is still the default fallback path.
