# DirectoryApply — TODO

## Pre-Flight Checklist (Before First Run)

- [ ] Update AI model name from `claude-sonnet-4-20250514` → `claude-sonnet-4-6` (hardcoded in 6 places)
- [ ] Set AI API key in popup Configuration
- [ ] Set `maxCompanies: 5` for initial test run
- [ ] Keep `dryRun: ✓` checked until you've reviewed results
- [ ] Consider raising `minMatchScore` from `40` → `50-60` to reduce noise
- [ ] Consider raising `delayMs` from `1000` → `1500` to be gentle on workatastartup.com
- [ ] If using Cloudflare Worker: set secrets (`wrangler secret put ANTHROPIC_API_KEY`) and deploy

---

## Bugs / Reliability

### 🔴 Critical

- [ ] **`max_tokens: 2048` may truncate AI responses** — Companies with many jobs produce large JSON output. If the model runs out of output tokens mid-JSON, the response is unparseable. Set to `64000` (Sonnet 4.6 max is 64K). There is no cost penalty — you only pay for tokens actually generated, not the limit. Setting near-max eliminates truncation risk entirely.
  - `extension/background/service-worker.js` — `directAIMatch()`, Anthropic and OpenAI calls
  - `worker/src/index.ts` — `callAnthropic()` and `callOpenAI()`
  - For OpenAI (`gpt-4o`), use `16384` (its max output)

- [ ] **No prompt size guard** — All job descriptions are concatenated into one prompt with no length check. Job descriptions can be up to 5000 chars each (`content.js` `parseJobPage`). A company with 20 jobs = ~100K chars of job text. Should truncate per-job descriptions and/or cap total prompt size before sending to the API.
  - `extension/background/service-worker.js` — `directAIMatch()` prompt construction
  - `worker/src/index.ts` — `buildPrompt()`

- [ ] **No API retry/backoff** — AI API calls have no retry on transient failures (429, 500, network timeout). A single failure logs the error and skips the company entirely.
  - `extension/background/service-worker.js` — `directAIMatch()`
  - `worker/src/index.ts` — `callAnthropic()`, `callOpenAI()`

### 🟡 Medium

- [ ] **Algolia pagination has no rate-limit backoff** — 300ms fixed delay between pages. If Algolia returns 429, the code logs but continues without exponential backoff.
  - `extension/background/service-worker.js` — `fetchAllCompaniesViaAlgolia()`

- [ ] **Tab load timeout rejects without graceful handling** — If a job page takes >30s to load, the promise rejects but the tab may remain open.
  - `extension/background/service-worker.js` — `applyToJob()` tab listener

---

## Performance Bottlenecks

### Sequential Processing (Intentional but Slow)

- [ ] **Job fetching is fully sequential** — For each company, fetches company page + each job page one-at-a-time with `delayMs/2` sleep between. With ~150 companies × ~3 jobs = ~450 HTTP requests. Estimated: **7-15 minutes** for Step 3.
  - `extension/background/service-worker.js` — pipeline Step 3 loop

- [ ] **AI matching is sequential** — One API call per company with `delayMs` between each. ~150 companies × ~3s per call. Estimated: **7-10 minutes** for Step 4.
  - `extension/background/service-worker.js` — pipeline Step 4 loop

- [ ] **Application sending is sequential** — Opens a tab per job, waits for load + 2s render delay, interacts with modal, closes tab. One at a time.
  - `extension/background/service-worker.js` — `sendApprovedApplications()`

### Potential Improvements

- [ ] Batch job detail fetching with `Promise.all()` + concurrency limit (e.g. 3 at a time)
- [ ] Parallel AI matching with concurrency limit (e.g. 2-3 concurrent API calls)
- [ ] Consider batching multiple small companies into a single AI prompt

---

## Hardcoded Defaults to Review

| Location | Value | What It Controls |
|----------|-------|-----------------|
| `service-worker.js` state.config | `aiProvider: "anthropic"` | Default AI provider |
| `service-worker.js` state.config | `aiModel: "claude-sonnet-4-20250514"` → `"claude-sonnet-4-6"` | Default model name |
| `service-worker.js` state.config | `delayMs: 1000` | Delay between pipeline steps (ms) |
| `service-worker.js` state.config | `dryRun: true` | Dry run on by default (safe) |
| `service-worker.js` state.config | `minMatchScore: 40` | Minimum score for review queue |
| `service-worker.js` state.config | `maxCompanies: 0` | 0 = all companies (no limit) |
| `service-worker.js` directAIMatch | `max_tokens: 2048` → `64000` | AI output token limit (Sonnet 4.6 max: 64K) |
| `service-worker.js` directAIMatch | `temperature: 0.3` | OpenAI temperature |
| `worker/src/index.ts` callAnthropic | `max_tokens: 2048` → `64000` | Worker AI output token limit |
| `worker/src/index.ts` callOpenAI | `temperature: 0.3` | Worker OpenAI temperature |
| `content.js` parseJobPage | `.slice(0, 5000)` | Max chars per job description scrape |

---

## Hardcoded Model Names (6 Locations)

All default to `claude-sonnet-4-20250514` for Anthropic (update to `claude-sonnet-4-6`) and `gpt-4o` for OpenAI:

1. `extension/background/service-worker.js` — `state.config.aiModel` default
2. `extension/background/service-worker.js` — `directAIMatch()` Anthropic fallback
3. `extension/background/service-worker.js` — `directAIMatch()` OpenAI fallback
4. `extension/popup/popup.js` — `loadConfigToUI()` fallback
5. `worker/src/index.ts` — `/api/match` handler Anthropic fallback
6. `worker/src/index.ts` — `/api/match` handler OpenAI fallback

---

## Magic Numbers to Extract

| File | Value | Context | Suggested Constant |
|------|-------|---------|--------------------|
| `service-worker.js` | `0.4` min | Keepalive alarm period | `KEEPALIVE_MINUTES` |
| `service-worker.js` | `20` | Algolia hitsPerPage | `ALGOLIA_HITS_PER_PAGE` |
| `service-worker.js` | `300` ms | Algolia page delay | `ALGOLIA_PAGE_DELAY_MS` |
| `service-worker.js` | `500` | Max log entries | `LOG_HISTORY_MAX` |
| `service-worker.js` | `30000` ms | Tab load timeout | `TAB_LOAD_TIMEOUT_MS` |
| `service-worker.js` | `2000` ms | Post-load render delay | `PAGE_RENDER_DELAY_MS` |
| `service-worker.js` | `2048` → `64000` | AI max output tokens | `AI_MAX_TOKENS` |
| `content.js` | `1500` ms | Modal appear wait | `MODAL_APPEAR_DELAY_MS` |
| `content.js` | `2000` ms | Modal retry wait | `MODAL_RETRY_DELAY_MS` |
| `content.js` | `2000` ms | Post-submit wait | `SUBMIT_CONFIRM_DELAY_MS` |
| `content.js` | `5000` chars | Job description cap | `JOB_DESC_MAX_CHARS` |
| `popup.js` | `2000` ms | State polling interval | `STATE_POLL_INTERVAL_MS` |
| `popup.js` | `500` ms | Note edit debounce | `NOTE_EDIT_DEBOUNCE_MS` |
| `popup.js` | `80` | Recent logs display count | `RECENT_LOGS_DISPLAY` |

---

## Logging Improvements (Done ✓)

- [x] **content.js** — 3 empty `catch(_){}` blocks now log with `console.warn`
- [x] **injected.js** — 2 empty catches now log URL and error details
- [x] **popup.js** — `sendMsg()` wrapper on all 15+ `chrome.runtime.sendMessage` calls; failure logging + SW liveness tracking
- [x] **service-worker.js** — AI JSON parse wrapped in try/catch with raw response logged; `chrome.tabs.remove` catch logs
- [x] **popup.html/css** — Green/red SW connection indicator dot in header

---

## Future Enhancements

- [ ] Add token counting before AI calls (lightweight estimate: `prompt.length / 4`)
- [ ] Add exponential backoff retry wrapper for API calls
- [ ] Persist match results to `chrome.storage.local` so they survive SW restarts
- [ ] Add "Resume pipeline" capability (skip already-matched companies)
- [ ] Add cost estimation in the UI (based on prompt tokens × model pricing)
- [ ] Support additional job boards beyond workatastartup.com

---

## Model Update Summary

**Current default:** `claude-sonnet-4-20250514` (legacy Sonnet 4)  
**Recommended:** `claude-sonnet-4-6` (latest Sonnet)

| | Sonnet 4 (current) | Sonnet 4.6 (target) | Opus 4.6 |
|---|---|---|---|
| Context window | 200K (1M w/ beta) | **1M** | **1M** |
| Max output | 64K | **64K** | **128K** |
| Input pricing | $3/MTok | $3/MTok | $5/MTok |
| Output pricing | $15/MTok | $15/MTok | $25/MTok |
| Latency | Fast | Fast | Moderate |

Sonnet 4.6 chosen over Opus 4.6: same context window, same max output for our use case (~2K output), 40% cheaper, faster latency. Opus 4.6's 128K output ceiling is irrelevant when our JSON responses are <4K tokens.
