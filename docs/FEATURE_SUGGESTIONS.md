# Feature Suggestions — Combined Analysis

## AdminApp Tests Folder

1. **Visual Regression Testing Layer** — `toHaveScreenshot()` on key states
2. **Accessibility (a11y) Audit Fixture** — `@axe-core/playwright` in `actionsFixture.ts`
3. **Performance Budget Fixture** — Web Vitals capture per route
4. **API Contract Validation Mixin** — Schema validation on intercepted responses
5. **Test Data Factory / Seeding Layer** — API-driven setup/teardown in `global-setup.ts`
6. **Cross-Browser & Mobile Viewport Coverage** — Firefox, WebKit, mobile projects
7. **Retry-Aware Test Annotations** — Query Flaky Detective before runs, auto-annotate
8. **Shared State Assertions for NgRx** — Read store state via `page.evaluate()`

## ai-pr-review

9. **Test Coverage Gap Detector Worker** — Compare changed components vs existing specs
10. **Smart Test Selection / Impact Analysis Worker** — Component → spec dependency graph
11. **Flaky Detective Enhancements** — Root cause classification, auto-fix suggestions, trends
12. **Review Worker: Architecture-Aware Reviews** — POM pattern enforcement, anti-pattern detection
13. **PW-Generate Improvements** — Mixin-aware, fixture-aware, constants integration
14. **AI Model A/B Testing** — Compare models, track acceptance rates
15. **PR Quality Score Dashboard** — Aggregate review data across PRs
16. **Webhook-Triggered Test Execution Worker** — Run generated tests, self-healing loop
17. **Secret Rotation Alerting** — Track secrets across PRs, external alerts
18. **Re-review on subsequent pushes** — When a PR gets new commits, re-review and show remaining issues ✅ IMPLEMENTING

## Cross-Repository Synergies

19. **Unified Test Health Dashboard** — Combine flaky, coverage, performance data
20. **Closed-Loop Test Quality Pipeline** — Full CI feedback cycle
21. **Test Documentation Generator Worker** — Living test docs from JSDoc

## Priority Ranking

| # | Suggestion | Impact | Effort | Quick Win? |
|---|-----------|--------|--------|------------|
| 5 | Test Data Factory | High | Medium | No |
| 9 | Coverage Gap Detector | High | Low | Yes |
| 13 | PW-Generate Improvements | High | Medium | Partially |
| 1 | Visual Regression Testing | Medium | Low | Yes |
| 12 | Architecture-Aware Reviews | Medium | Medium | No |
| 7 | Retry-Aware Annotations | Medium | Low | Yes |
| 2 | Accessibility Audit | Medium | Low | Yes |
| 10 | Smart Test Selection | High | High | No |
| 11 | Flaky Detective Enhancements | Medium | Medium | Partially |
| 19 | Closed-Loop Pipeline | High | High | No |
