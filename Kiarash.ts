const KIARASH_RESUME =
  "KIARASH ADL — Senior SWE candidate. kiarasha@alum.mit.edu. US Citizen. " +
  "SUMMARY: AI innovator and entrepreneur with 10+ years building scalable CV and ML solutions, from Google Search features serving billions of queries to patent-pending applications in home services. Proven track record prototype-to-production, securing VC, leading high-performing teams. " +
  "EXPERIENCE: " +
  "AI Vision, Founder & CEO (02/2024–Present, Austin TX) — Built patent-pending AI/CV solutions for repair estimation and home improvement. Led dev and deployment of production-grade AI features, prototype to App Store. Built multidisciplinary team, drove technical infrastructure decisions. " +
  "Technical Consulting (03/2019–01/2024) — Engineering projects, MVPs, prototypes, best practices. Advised companies on tech roadmaps. Translated product vision into actionable engineering plans. " +
  "Monir, Founder & CEO (03/2018–03/2019, NYC) — AI for personalized shopping content. Scalable serverless platform with Python microservices. Secured VC funding, recruited and led FTEs and contractors. " +
  "Google, SWE (12/2014–03/2018, NYC) — Designed/prototyped/deployed new features in Search Knowledge Panel. Improved infrastructure for informational messages across Google. Quality improvements on entity image selection for Knowledge Graph (images used across Google products). Cross-functional teams, billions of daily queries. " +
  "BlockedOnline.com, Student Researcher (02/2014–10/2014, Cambridge MA) — Under Sir Tim Berners-Lee. Developed servers and client-side tools to gather/visualize internet censorship data. Automated data validation and scrubbing. " +
  "Twitter Ads, SWE Intern (06/2014–09/2014, SF) — Experimental ML algorithm to expand target audience to non-Twitter users. Scalable multi-label ridge regression via matrix factorization in Hadoop/Scalding. " +
  "EDUCATION: B.S. EECS, MIT (2014). " +
  "SKILLS: " +
  "AI/ML: Deep learning (PyTorch, Transformers, CLIP), distributed ML (Ray), classical ML (scikit-learn, XGBoost), GPU (CUDA/cuDNN/NCCL), data (NumPy, Pandas). " +
  "Backend/Distributed: Python (FastAPI/Flask, asyncio, AIOHTTP), microservices, event-driven architectures, Celery, Ray, Kafka, Redis, PostgreSQL/SQLAlchemy/Peewee. " +
  "DevOps: Docker & multi-service Compose (17+ services), async servers (Uvicorn/uvloop), CI/CD, Black/Ruff/PyTest, Azure (primary)/AWS/GCP. " +
  "Observability: Prometheus, Grafana, OpenTelemetry, structlog, Sentry, profiling (pytest-benchmark). " +
  "Frontend/Mobile: React.js, Expo React Native, API integration, client-side AI workflows. " +
  "Leadership: Technical roadmapping, architecture decisions, team building, MVP-to-production, startup leadership/fundraising. " +
  "AI PROJECTS: " +
  "FIML — AI-native MCP server for financial data aggregation with intelligent multi-provider orchestration and multilingual compliance guardrails. 32K+ LOC Python, custom DSL, Expo mobile app, usage analytics/quota management, CI/CD with 1,030+ automated tests at 100% pass rate. Open-source on GitHub. " +
  "HireAligna.ai — Conversational AI recruiter: schedules/conducts voice interviews via LiveKit, transcribes with Azure OpenAI, automated candidate-job matching. Express.js API, Next.js 16, PostgreSQL, Redis, Python LiveKit voice agent, Docker, Prometheus/Grafana/Sentry. Bi-directional smart matching with skill-based scoring, AI-generated summaries, structured interview data extraction. " +
  "RESEARCH: " +
  "MIT CSAIL (2014) — ML research on edX student activity data. Co-authored 'Feature factory: Crowdsourced feature discovery' (ACM L@S 2015, pp. 373–376). " +
  "MIT CSAIL (2011–2012) — 55x GPU speedup for speech recognition. Co-authored 'Fast Spoken Query Detection Using Lower-Bound DTW on GPUs' (ICASSP 2012, pp. 5173–5176).";

const KIARASH_PROJECTS = `
# Detailed Project Audit — Kiarash Adl's Portfolio

> Source-code-level analysis of **11 repositories** spanning fintech infrastructure, enterprise SaaS, conversational AI, developer tooling, and mobile platforms.

---

## 1. FIML — Financial Intelligence MCP Server

**Repo**: \`kiarashplusplus/FIML\` · **Language**: Python · **32,000+ LOC** · **1,403 tests**

### Architecture Overview

\`\`\`
fiml/
├── arbitration/     # Crown jewel: data arbitration engine (450 lines)
├── providers/       # 17 provider adapters + abstract base (base.py: 181 lines)
├── cache/           # L1 Redis + L2 PostgreSQL (manager, warmer, eviction, analytics)
├── compliance/      # 9-language guardrail system (guardrail.py: 1,318 lines)
├── dsl/             # FK-DSL: Lark-based financial query language (parser, executor, planner)
├── mcp/             # MCP server (FastAPI): router + 9 tools
├── agents/          # Ray-based multi-agent system (8 specialized agents)
├── narrative/       # Azure OpenAI LLM narratives (generator: 977 lines)
├── watchdog/        # Real-time market event stream orchestration
├── sessions/        # Multi-query context tracking (Redis + PostgreSQL)
├── websocket/       # Real-time OHLCV streaming (650+ lines)
├── bot/             # Educational finance chatbot with adapters
├── monitoring/      # Prometheus metrics + health checks
└── services/        # Storage layer abstraction
\`\`\`

### Data Arbitration Engine — fiml/arbitration/engine.py (450 lines)

The core differentiator. The DataArbitrationEngine class orchestrates every data request:

1. **Provider Discovery**: Queries \`ProviderRegistry\` for all providers compatible with the requested \`Asset\` + \`DataType\` combination
2. **5-Factor Scoring** (_score_provider): Each provider receives a composite score based on:
   - **Freshness** (30%): \`max(0, 100 × (1 − age_seconds / max_staleness_seconds))\`
   - **Latency** (25%): P95 latency vs a 5-second ceiling
   - **Uptime** (20%): 24-hour availability percentage
   - **Completeness** (15%): Data field coverage for the requested \`DataType\`
   - **Reliability** (10%): Success rate over last N requests
   - **Bonus**: NewsAPI gets a 1.2× multiplier for \`NEWS\`/\`SENTIMENT\` data types (domain-specific affinity)
3. **Health Gating**: Providers scoring below 50 are excluded (with graceful degradation to best-available)
4. **Execution Plan**: Returns an \`ArbitrationPlan\` with primary provider, up to 2 fallbacks, merge strategy, and estimated latency
5. **Fallback Execution** (execute_with_fallback): Iterates provider list; on rate-limit errors, parses wait time from error messages (regex: \`Wait (\\d+\\.?\\d*)s\`) and sets per-provider cooldown via \`provider.set_cooldown(seconds)\`
6. **Multi-Provider Merge** (merge_multi_provider): Strategy selected by data type:
   - \`PRICE\` → numpy weighted average using provider confidence as weights, with agreement-based confidence = \`1/(1 + σ/μ)\`
   - \`OHLCV\` → candlestick aggregation (Open from earliest, High = max, Low = min, Close from latest, Volume = sum)
   - \`FUNDAMENTALS\` → most-recent-first backfill (fills missing fields from successively older sources)
   - \`NEWS\` → deduplicate + merge

### Provider System — fiml/providers/base.py (181 lines)

Abstract BaseProvider class enforces a clean interface:
- **Lifecycle**: initialize() / shutdown() for connection management
- **Data Methods**: fetch_price(), fetch_ohlcv(), fetch_fundamentals(), fetch_news(), fetch_technical(), fetch_macro(), fetch_options_chain()
- **Health Telemetry**: get_health(), get_latency_p95(region), get_uptime_24h(), get_success_rate(), get_completeness(data_type)
- **Cooldown Mechanism**: set_cooldown(seconds) / is_in_cooldown() — a datetime-based backoff that transparently removes providers from routing
- **Standardized Response**: ProviderResponse Pydantic model with confidence, \`is_valid\`, \`is_fresh\` flags consumed by the arbitration engine

17 concrete implementations: Yahoo Finance, Alpha Vantage, FMP, Polygon.io, Finnhub, Twelvedata, Tiingo, Intrinio, Marketstack, Quandl, FRED, CoinGecko, CoinMarketCap, DeFiLlama, CCXT, NewsAPI, Mock.

### Compliance Guardrail — fiml/compliance/guardrail.py (1,318 lines)

A regex-based processing pipeline for financial content compliance in 9 languages (EN, ES, FR, DE, IT, PT, JA, ZH, FA):

- **MultilingualPatterns**: Static class with 4 categories of compiled regex patterns per language:
  - **Prescriptive Verbs**: "should", "must", "recommend" and equivalents in all 9 languages (includes Japanese \`べき\`, Chinese \`应该\`, Farsi \`باید\`)
  - **Advice Patterns**: "you should buy" → "one may consider reviewing options" (21 EN patterns, 10-12 per other language)
  - **Opinion-as-Fact**: "definitely a buy" → "currently showing buy activity" (13 EN patterns)
  - **Certainty Language**: "will increase" → "has historically shown increase patterns" (10 EN patterns)
- **Language Detection**: Script-based auto-detection (CJK Unicode ranges for JA/ZH, Arabic script for FA), then falls back to indicator word matching with configurable threshold (default: 3 matching words)
- **Processing Pipeline**: \`ComplianceGuardrail.process()\` runs all 4 pattern categories sequentially with compiled regex cache
- **Configurable Modes**: Strict mode blocks on >5 violations; normal mode modifies in-place
- **Disclaimer Injection**: Auto-generates region- and asset-class-appropriate disclaimers via \`DisclaimerGenerator\`

### Other Notable Systems

| Module | Detail |
|--------|--------|
| **FK-DSL Parser** | Lark grammar for domain-specific financial queries (e.g., \`PRICE AAPL COMPARE MSFT LAST 30D\`). Parser → Planner → Executor pipeline |
| **Cache Architecture** | \`CacheManager\` coordinates L1 (Redis, 10–100ms) and L2 (PostgreSQL, 300–700ms). \`CacheWarmer\` pre-fetches popular symbols. \`EvictionManager\` implements LRU/LFU policies. \`CacheAnalytics\` tracks hit rates and latency distributions |
| **Agent Orchestration** | Ray-based system with \`AgentOrchestrator\`, \`BaseAgent\`, specialized \`workers\`. 8 agent types for deep equity analysis, crypto sentiment, real-time monitoring |
| **Narrative Generation** | Azure OpenAI integration (977-line \`generator.py\`). Prompt templates, batch processing, narrative cache, and a \`validator\` that enforces compliance guardrails on LLM outputs |
| **Watchdog System** | Event stream orchestrator with pluggable \`detectors\` (667 lines), \`events\` model (334 lines), health monitoring |
| **Session Management** | \`SessionStore\` (506 lines) with Redis + PostgreSQL, \`SessionAnalytics\` (454 lines) for usage tracking |
| **Docker Deployment** | 12-service \`docker-compose.yml\`: FastAPI server, Redis, PostgreSQL, Prometheus, Grafana, plus K8s \`deployment.yaml\` |
| **CI/CD** | 10+ GitHub Actions workflows (component-based: core, providers, DSL, MCP, agents, bot, mobile, compliance, infra, docs) |
| **Mobile** | Expo/React Native app with chat interface (3 AI persona options), API key management, market dashboard |

---

## 2. Legal AI Platform — Cloudflare Edge Legal SaaS

**Repo**: \`legal-main\` · **Language**: TypeScript · **112,868+ LOC** · **2,240 tests**

### Architecture

Runs **entirely on Cloudflare's global edge** — no origin servers:

\`\`\`
src/
├── handlers/     # 42 API route handlers (documents, billing, calendar, kanban, integrations...)
├── services/     # 46 services (AI, RAG, workflow, compliance, sync, embeddings, PII cleanup...)
├── middleware/    # 7-layer stack: auth → firm-isolation → rate-limit → rbac → audit → tracing → client-auth
├── durable-objects/  # 6 stateful edge objects (batch-import, conversation, review-queue, session-manager, sync-status, template-session)
├── lib/          # Logger, crypto, utilities
└── types/        # Shared type definitions
\`\`\`

**Frontend** (SvelteKit): 82 files, 51k lines, 47 routes, 20 components.

### Auth Middleware — src/middleware/auth.ts (401 lines)

Dual-mode JWT verification:
1. **Bearer tokens** (platform-issued): Verified with \`jose.jwtVerify()\` against \`JWT_SECRET\` env var
2. **Cloudflare Access JWTs**: Verified against JWKS fetched from \`{teamDomain}.cloudflareaccess.com\` with 1-hour cache (\`jwksCacheExpiry\`)
- **Session Trust Levels**: 3-tier system derived from request headers:
  - \`high\` = device trust (\`cf-access-device-posture: pass\`) + MFA
  - \`medium\` = MFA only
  - low = neither
- **Claim Extraction**: Pulls \`user_id\`, \`firm_id\`, \`email\`, \`role\`, \`clearance_level\`, \`permissions\` from JWT payload with validation fallbacks
- **Optional Auth Middleware**: Separate middleware for public endpoints that tries auth but continues without it on failure

### Firm Isolation — src/middleware/firm-isolation.ts (192 lines)

Multi-tenant data isolation enforced at the middleware level:
- Extracts \`firm_id\` from URL path (\`/firms/:firm_id/...\`), query params, or JSON request body (clones request to avoid consuming body)
- Cross-firm access: Denied for all roles except \`super_admin\` (with audit logging)
- **Query Helpers**: firmWhereClause(context) returns \`{sql: "firm_id = ?", params: [firm_id]}\` for D1 queries — ensures every database query is scoped

### Workflow State Machine — src/services/workflow.ts (946 lines)

Document lifecycle management with 7 states and 8 transition actions:

\`\`\`
draft → pending_review → in_review → approved → finalized → archived
                              ↓
                    revision_requested → (back to pending_review)
\`\`\`

Key implementation details:
- **Declarative State Transitions**: \`STATE_TRANSITIONS\` record maps \`{state: {action: newState}}\`
- **Dual Authorization**: Each action requires both minimum \`clearance_level\` (1–4) AND specific \`role\` (attorney, paralegal, partner, admin)
- **Optimistic Locking**: \`expected_updated_at\` field — if state was modified by another user, transition returns conflict error
- **Cryptographic Signing**: Every transition gets a digital signature via signTransition()
- **Batched DB Writes**: Uses D1's \`batch()\` to atomically insert transition history + update state
- **Async Audit**: Queues audit events to \`AUDIT_QUEUE\` (Cloudflare Queue) after every transition
- **SLA Enforcement**: Template-driven SLA deadlines calculated per state, with \`sla_compliance_rate\` analytics
- **Delegation**: Reassigns reviewers with full audit trail in \`review_participants\` table (delegated_from, delegated_reason)
- **Review Modes**: Sequential, parallel-all, parallel-any — template-configurable
- **Workflow Templates**: Firm-scoped templates with approval roles, SLA hours, min reviewers, auto-discovery of default templates
- **Analytics**: SQL analytics with JULIANDAY-based time calculations for avg time-in-state, review turnaround, approval/rejection rates, top reviewers, queue depth trends

### Other Key Services

| Service | Lines | What It Does |
|---------|-------|-------------|
| \`ai.ts\` | AI inference via Workers AI for document classification, Q&A |
| \`rag.ts\` | RAG-powered Q&A using Vectorize embeddings + Workers AI |
| \`embeddings.ts\` | Semantic search via Cloudflare Vectorize |
| \`text-extraction.ts\` | 724 | PDF/document text extraction using \`unpdf\` |
| \`vision-analysis.ts\` | 581 | Image/document analysis via Workers AI |
| \`approval.ts\` | Multi-level approval chains with conditional requirements |
| \`auto-remediation.ts\` | Automatic issue resolution for SLA violations |
| \`sla-enforcement.ts\` | SLA monitoring with alerts |
| \`compliance.ts\` | Chain-of-custody tracking for e-signatures |
| \`typo-detection.ts\` | 444 | Document quality checks |
| \`pii-cleanup.ts\` | Automated PII detection and sanitization |
| \`data-retention.ts\` | Retention policies with scheduled cleanup |

### Infrastructure

- **Storage**: D1 (SQLite) for data, KV for cache, R2 for document objects, Vectorize for embeddings
- **Compute**: Workers (API), Durable Objects (rate limiting, sessions, batch import), Queues (audit, ingestion, embedding, import)
- **Security**: AES-256-GCM encryption, E2E encryption, RBAC with clearance levels 1–5
- **Only 4 backend dependencies**: hono, jose, fflate, unpdf

---

## 3. HireAligna — AI Recruiter with Voice Interviews

**Repo**: \`kiarashplusplus/hirealigna\` · **Languages**: TypeScript + Python · **pnpm monorepo**

### Monorepo Structure

\`\`\`
apps/
├── web/       # Next.js 16: marketing, candidate portal, employer portal, jobs, admin dashboard
├── server/    # Express API: call control, consent, transcription, matching, profiles, privacy
├── worker/    # Queue consumer: async match, transcription, resume extraction
├── bot/       # Python LiveKit agent: conducts voice interviews
└── certbot/   # SSL certificate management
packages/
├── common/    # Shared TS types + consent disclosure text
├── messaging/ # Queue abstraction (Azure Service Bus or in-memory)
├── logging/   # Structured logging with correlation IDs
├── email/     # Email templates + ACS integration
└── ui/        # Shared React UI components
\`\`\`

### Matching Service — \`apps/server/src/services/matching.ts\`

AI-powered candidate-job matching:
1. **Embedding Generation**: Sends interview summary JSON + job role profile to Azure OpenAI Embeddings API via the \`openai\` SDK. Stores embeddings as \`candidateEmbedding\` / \`jobEmbedding\` in Prisma's \`MatchingResult\` table
2. **GPT-5 Reranker**: Calls Azure OpenAI Chat Completions with structured JSON output:
   - Prompt: "You are an expert technical recruiter. Given a candidate summary and a job description, output overall numeric match score (0-100), three short bullet reasons referencing transcript citations"
   - Uses \`response_format: { type: "json_object" }\` for structured output
   - Supports configurable \`reasoning_effort\` ("low" | "medium" | "high") or fallback to \`temperature: 0.1\`
3. **Prisma Upsert**: Atomically creates or updates match results, avoiding duplicate entries via composite unique key \`interviewId_jobRoleId\`
4. **Graceful Degradation**: Falls back to mock embeddings and randomized scoring when Azure OpenAI is not configured (development mode)

### LiveKit Voice Bot — \`apps/bot/agent.py\`

Python-based recruiter that conducts phone interviews:
- **LiveKit Agents Framework**: Uses \`VoiceAgent\` + \`AgentSession\` + \`room_io\`
- **STT/TTS**: \`livekit.plugins.openai\` for speech recognition + synthesis, \`livekit.plugins.silero\` for VAD
- **Internationalization**: \`get_strings()\` / get_supported_languages() for localized interview flows
- **Graceful Shutdown**: Custom signal handler (\`_delayed_signal_handler\`) that delays termination during \`_critical_work_in_progress\` (e.g., mid-transcription)
- **Thread-Safe Logging**: Double-checked locking pattern (\`_logging_setup_lock\`) with \`RotatingFileHandler\` + shared error log at \`/var/log/aligna/all-errors.log\`
- **Interview Flow**: Consent disclosure → structured questions → transcription → result submission to API

### Worker Jobs — \`apps/worker/src/jobs/\`

6 async job types consumed from the queue:
- \`matching.ts\` — Triggers \`MatchingService.scoreInterview()\` for all relevant job/candidate pairs
- \`transcription.ts\` — Processes raw audio into structured interview transcripts
- \`resumeExtraction.ts\` — Parses uploaded resumes into structured data
- \`mentorProfile.ts\` — Generates AI mentor profiles from user data
- \`prepFeedback.ts\` — Prepares interview feedback summaries
- \`emailNotification.ts\` — Sends templated emails via Azure Communication Services

### Server Routes

Express API with domain-specific routes: \`calls.ts\` (LiveKit room provisioning + token generation), \`consent.ts\` (consent capture + verification), \`profiles.ts\` (candidate/employer profiles), \`employer.ts\` (job posting), \`privacy.ts\` (data deletion with verification codes), \`admin.ts\` (platform administration), \`candidateDashboard.ts\` (candidate-facing dashboard)

### Observability

- **Sentry**: Error tracking across server, web, and worker
- **Prometheus**: Metrics collection via \`config/metrics.ts\` in both server + worker
- **Correlation IDs**: \`correlationId.ts\` middleware for request tracing across services
- **Health Endpoints**: Comprehensive health checks for all services

---

## 4. Finderly — AI Home Improvement Assistant

**Repo**: \`kiarashplusplus/finderly-monorepo\` · **Languages**: TypeScript + LiveKit

### Architecture

\`\`\`
frontend/       # React Native/Expo: iOS, Android, Web
server/
├── src/
│   ├── agent/      # LiveKit agent for voice-guided home repair
│   ├── prompts/    # Structured LLM prompts
│   ├── schemas/    # Zod schemas including canonical ProjectState
│   ├── config/     # Environment configuration
│   ├── constants/  # App constants
│   └── utils/      # Shared utilities
s/              # Assistant server (OpenAI-powered)
us/             # User/auth server (Google/Apple Sign-in + JWT)
nginx/          # Production reverse proxy
\`\`\`

### Canonical ProjectState

The central data model shared across all AI interactions:
- **Goal**, **diagnosis**, **DIY summary**, **estimated cost**, **skill level**, **estimated time**
- **Steps array**: \`{id, title, description, time_minutes, status: 'todo'|'doing'|'done'|'blocked'}\`
- **Materials tracking**: \`{name, quantity, estimated_cost}\` array
- **Chat history**: Unified turn log across text and voice sessions with \`turn_id\`, \`mode\`, \`role\`, text, \`timestamp\`
- **Safety notes**, **constraints**, **tools on hand**, **open questions**

### Conversation Context Service

The structured LLM memory layer:
1. \`loadProjectState()\` — Loads canonical state for a project
2. Normalizes recent text/voice turns into consistent format
3. \`updateProjectStateFromTranscript()\` — LLM-derived patches update the state
4. Ensures the LLM always sees consistent project memory across chat modes

### FinderlyState Package — Cross-Platform State Persistence

A separate repo (\`FinderlyState-main\`) containing the architectural spec for a 5-phase evolution:
- **Phase 1**: Extract canonical Zod schema into \`@finderly/project-state\` npm package
- **Phase 2**: Replace \`project_db.json\` flat-file store with PostgreSQL + user-scoped endpoints
- **Phase 3**: Wire JWT auth to all state endpoints; implement chat-exit sync + pull-on-open
- **Phase 4**: Project list endpoint, last-write-wins conflict resolution, offline queue
- **Phase 5**: Merge package into monorepo's \`packages/\` directory

---

## 5. AgentRank.it — AI Agent Website Auditor

**Repo**: \`kiarashplusplus/AgentRank.it\` · **Language**: TypeScript · **Published npm package**

### Two-Speed Scanner Architecture — src/core/scanner.ts (419 lines)

Main orchestrator for the "Reactive Escalation" architecture:

**Level 1 — Speed Reader** (default, \`mode: 'quick'\`, ~$0.002/scan, <5s):
1. Launches \`BrowserUseEngine\` (Playwright)
2. buildContext(): Navigates to URL, captures HTML + robots.txt + ai.txt + accessibility tree + time-to-interactive
3. \`checkRobotsTxt()\`: Validates scanning is allowed; throws \`RobotsBlockedError\` if disallowed
4. Runs all 5 analyzers in **parallel via \`Promise.all()\`**:
   - \`permissionsAnalyzer\` — robots.txt + ai.txt analysis (weight: 20%)
   - \`structureAnalyzer\` — semantic HTML density, div-soup detection (weight: 25%)
   - \`accessibilityAnalyzer\` — accessibility tree depth + ARIA labeling (weight: 25%)
   - \`hydrationAnalyzer\` — time-to-interactive for JS rendering (weight: 15%)
   - \`hostilityAnalyzer\` — bot-blocker + navigation trap detection (weight: 15%)

**Level 2 — Visual Resolver** (\`mode: 'deep'\`, ~$0.02/scan, 30–90s):
- Triggered by \`--mode=deep\` flag or on \`InteractionFailed\` / \`NodeNotClickable\` / \`ElementIntercepted\` errors
- Launches \`BrowserUseServerEngine\` (self-hosted browser-use with Vision-LLM)
- Runs diagnostic tasks from \`diagnostic-prompts.ts\` sequentially, each with a dedicated prompt
- Results override Level 1 signal scores

### Hostility Analyzer — src/analyzers/hostility.ts (178 lines)

**DOM-aware** bot-blocker detection (avoids false positives from JS bundles):
- **Bot Blockers Detected**: Cloudflare Turnstile (\`#cf-turnstile\`), Cloudflare Challenge (\`challenge-running\`), Google reCAPTCHA (\`g-recaptcha\` class + \`recaptcha/api.js\` script), hCaptcha (\`h-captcha\` class + \`hcaptcha.com\` script), generic \`data-bot-protection\` attributes
- **Navigation Traps**: Counts \`javascript:void\` links, \`href="#"\`, disabled buttons, \`overlay-blocker\`/\`modal-backdrop\` classes
- **Tiered Scoring**: >10 traps → fail (score 10), >5 → warn (60), >0 → pass (80), 0 → pass (100)
- **PRD Behavior**: Hostility failure = FAIL immediately, do NOT escalate to Vision mode (cost savings)

### Score Calculator — src/core/score.ts (74 lines)

- Weighted sum: each signal's \`score × (weight / 100)\`
- **Escalation Penalty**: −10 points if Visual Resolver was triggered
- Letter grades: A (90+), B (80+), C (70+), D (60+), F (<60)
- Human-readable summaries: "Excellent - Highly navigable by AI agents" through "Critical - Major barriers to AI agent access"

### MCP Server — \`src/mcp/\`

- \`server.ts\` — MCP server exposing AgentRank as a tool for LLM integration
- \`handlers.ts\` — Request handlers for scan operations
- \`rate-limiter.ts\` — Rate limiting for MCP API calls

---

## 6. Retailfluencer — Influencer → Retail Attribution SaaS

**Repo**: \`Retailfluencer-main\` · **Stack**: Svelte 5 (Runes), SvelteKit, Prisma, PostgreSQL

### Data Model — \`prisma/schema.prisma\`

Core entities for GS1 8112 coupon attribution:
- **Brand** → has Products, Campaigns, Influencers, Customers, Automations
- **Product** → tracks \`gtin\` (Global Trade Item Number for 8112), \`sku\`, \`cogs\`, \`retailPrice\`
- **Retailer** → \`supports8112\` boolean, regional JSON
- **Campaign** → links Brand + Product + Retailer with \`discountType\` (fixed/percent/BOGO), \`baseGs1\`, \`tcbMofId\`, \`status\` lifecycle
- **CouponAssignment** → assigns serialized coupons to influencers with tracking
- **Redemption** → POS redemption records with attribution back to influencer
- **Affiliate** → self-service affiliate system with unique codes, commission tracking
- **Customer** → CRM with source tracking (coupon, affiliate, organic)
- **Automation** → trigger + action workflow chains

### Route Structure

SvelteKit file-based routing:
- \`/dashboard\` routes — Brand admin dashboard with analytics
- \`/dashboard/automations\` — Workflow builder (triggers → actions)
- \`/dashboard/affiliates\` — Commission management
- \`/c/[gs1]\` — Public coupon redemption page
- \`/a/[code]\` — Affiliate referral redirect (tracks attribution)
- \`/promo\` — Public promo landing page
- \`/api/customers/capture\` — Customer data capture endpoint
- \`/review\` — Review interface

### TCB Integration Layer — \`src/lib/tcb/\`

Abstracted client for The Coupon Bureau API:
- \`types.ts\` — TCB data types for 8112 serialization
- \`client.ts\` — Real TCB API client
- \`mock-client.ts\` — Mock implementation for development
- \`index.ts\` — Factory pattern selecting client based on environment

### "Snowball Effect" Automation

Post-redemption workflow that automatically converts customers into affiliates:
1. Trigger: "Coupon Redeemed" event
2. Wait step (configurable)
3. Action: Send affiliate invitation email
4. Result: Customer becomes an influencer, creating a viral attribution loop

---

## 7. WebMCP Tooling Suite — AI Agent Integration Toolkit

**Repo**: \`kiarashplusplus/webmcp-tooling-suite\` · **4 published npm packages**

### Package Architecture

\`\`\`
packages/
├── validator/          # @25xcodes/llmfeed-validator (Ed25519 signature verification)
│   ├── src/index.ts    # Core validation logic
│   ├── src/cli.ts      # CLI: npx @25xcodes/llmfeed-validator example.com
│   └── src/index.test.ts
├── signer/             # @25xcodes/llmfeed-signer (key generation + signing)
│   ├── src/index.ts    # Ed25519 keygen + JSON signing
│   ├── src/cli.ts      # CLI: npx @25xcodes/llmfeed-signer keygen / sign
│   └── src/index.test.ts
├── llmstxt-parser/     # @25xcodes/llmstxt-parser (llms.txt parsing + RAG utilities)
│   ├── src/index.ts    # Parser + validator for llms.txt spec
│   └── src/index.test.ts
├── health-monitor/     # @25xcodes/llmfeed-health-monitor (feed crawling + outreach)
│   ├── src/crawler.ts  # HTTP feed crawler
│   ├── src/report.ts   # Health report generation
│   └── src/scheduler.ts # Automated monitoring schedule
└── github-action/      # CI/CD validation + badge generation
    └── src/index.ts    # GitHub Action entry point
\`\`\`

### Key Technical Details

- **Ed25519 Cryptography**: The signer generates Ed25519 keypairs and signs LLMFeed JSON payloads. The validator verifies signatures against published public keys
- **llms.txt Compliance**: Parser implements the [llmstxt.org](https://llmstxt.org) specification with both parsing and validation, plus RAG utilities for AI consumption
- **Health Monitor**: Automated crawler + health reporter with scheduling for continuous feed monitoring
- **GitHub Action**: Reusable CI/CD action used in FIML's own CI pipeline; validates LLMFeed files and generates status badges
- **Each package**: Has its own \`tsup.config.ts\` (build), \`vitest.config.ts\` (test), co-located test files

---

## 8. Expo Gemini Live — Real-Time AI Mobile App

**Repo**: \`expo-gemini-live-main\` · **Stack**: FastAPI + Pipecat + Daily + Expo/React Native

### Pipecat Bot Service — server/app/services/bot.py (227 lines)

The PipecatBotRunner builds and executes Gemini Live pipelines:

1. **Transport Layer**: \`DailyTransport\` with configurable audio/video I/O, Silero VAD (0.2s stop threshold), \`LocalSmartTurnAnalyzerV3\` for intelligent turn detection
2. **LLM Service**: \`GeminiLiveLLMService\` configured with:
   - Model, voice ID, language, system instruction from \`pydantic-settings\`
   - Modality selection: \`GeminiModalities.AUDIO\` or \`GeminiModalities.AUDIO_AND_VIDEO\`
   - Optional \`HttpOptions\` for API version control
   - Media resolution configurable (MEDIUM for video)
3. **Pipeline Assembly**: \`Pipeline([transport.input() → user_aggregator → [VideoDebugProcessor] → llm → assistant_aggregator → transport.output()])\`
4. **System Instruction Hook**: \`on_client_connected\` event handler that queues the system instruction to the LLM when a client connects
5. **Video Debug Processor**: Custom \`FrameProcessor\` that logs \`UserImageRawFrame\` details (participant ID, frame size) for debugging video pipeline

### Server Architecture

- \`services/daily.py\` — Daily room creation + token provisioning
- \`services/sessions.py\` — Session lifecycle management with TTL + cleanup
- \`api/routes.py\` — RTVI-compatible endpoints: \`POST /api/rtvi/start\`, \`POST /api/rtvi/{id}/stop\`, \`GET /api/rtvi/{id}\`
- \`config.py\` — \`pydantic-settings\`-based configuration (35+ env vars documented)

### Mobile App Architecture

- \`VoiceSessionProvider.tsx\` — React context wrapping Pipecat RN SDK + Daily transport, handles camera/mic permissions, \`transport.initDevices()\`, streams transcripts + audio levels through Zustand
- \`voiceStore.ts\` — Zustand store for session state
- \`PreJoinScreen.tsx\` — API base URL config, display name, system prompt input
- \`SessionScreen.tsx\` — Split video panes (local + remote), live transcripts, audio meters, text prompt input, controls
- Components: \`AudioMeter\`, \`StatusBadge\`, \`TranscriptList\`

---

## 9. TTS Gallery — Azure OpenAI Voice Sampler

**Repo**: \`kiarashplusplus/ttsgallery\` · **Stack**: React 19, TypeScript, Azure OpenAI TTS

- 100% client-side — no backend, zero data collection
- Supports all 23 Azure OpenAI TTS voices (6 Standard + 15 Neural + 2 HD)
- Credentials encrypted and stored locally in browser (privacy-first)
- Individual voice testing + sequential all-voice comparison
- Live at [tts.gallery](https://tts.gallery), promoted via [TikTok](https://www.tiktok.com/@tts.gallery)
- Deployed on Cloudflare Pages

---

## 10. Retailfluencer Landing Page

**Repo**: \`Retailfluencer-landing-page-main\` · **Stack**: Vanilla HTML/CSS/JS

Marketing site for Retailfluencer at [myretail.coupons](https://myretail.coupons):
- SEO-optimized: Open Graph, Twitter Cards, canonical URL, preload hints, preconnect
- Responsive design with Google Fonts
- Deployed on Cloudflare Pages with \`_headers\` and \`_redirects\` configuration

---

## Cross-Cutting Technical Themes

### Recurring Design Patterns

| Pattern | Where Used | Implementation |
|---------|-----------|---------------|
| **Provider/Strategy** | FIML providers, Legal AI services, Retailfluencer TCB | Abstract base + registry + dynamic selection |
| **State Machine** | Legal AI workflow, Retailfluencer campaigns | Declarative transition map + validation + audit |
| **Middleware Pipeline** | Legal AI (7 layers), HireAligna (5 layers) | Composable middleware with \`next()\` chaining |
| **Multi-Tenant Isolation** | Legal AI firm isolation, FIML user scoping | Middleware-enforced query scoping |
| **Graceful Degradation** | FIML providers, HireAligna matching, expo-gemini-live | Mock fallbacks when services unavailable |
| **Optimistic Locking** | Legal AI workflow | \`expected_updated_at\` conflict detection |
| **Cryptographic Operations** | Legal AI (transition signing), WebMCP (Ed25519), Legal AI (AES-256-GCM) | Domain-appropriate crypto primitives |
| **Queue-Based Async** | Legal AI (Cloudflare Queues), HireAligna (Service Bus), FIML (Celery/Ray) | Event-driven job processing |
| **Observable Systems** | HireAligna (Sentry + Prometheus), Legal AI (structured logging + tracing), FIML (Prometheus) | Correlation IDs, health endpoints, metrics |

### Technology Breadth

| Category | Technologies |
|----------|-------------|
| **Languages** | TypeScript, Python, Svelte, SQL |
| **Backend** | Hono (Legal AI), Express (HireAligna, Finderly), FastAPI (FIML, expo-gemini-live) |
| **Frontend** | Next.js 16, SvelteKit, React 19, Expo/React Native |
| **Databases** | PostgreSQL, Redis, Cloudflare D1 (SQLite-edge), Prisma ORM |
| **AI/LLM** | Azure OpenAI (GPT-4o, GPT-5, TTS, Embeddings), Gemini Live, Pipecat, Ray, Playwright, Workers AI |
| **Real-time** | LiveKit (voice/video), WebSocket, Daily (WebRTC transport), Pipecat |
| **Edge/Cloud** | Cloudflare (Workers, Pages, D1, R2, KV, Vectorize, Queues, Durable Objects), Azure |
| **Protocols** | MCP (Model Context Protocol), WebMCP/LLMFeed, GS1 8112, RTVI |
| **DevOps** | Docker/Docker Compose (12-service), Kubernetes, Nginx, GitHub Actions |
| **Security** | AES-256-GCM, E2E encryption, Ed25519, JWT/JWKS, Cloudflare Access, RBAC |

### Aggregate Metrics

| Metric | Value |
|--------|-------|
| Total repositories | 11 |
| Combined LOC (server-side) | ~200,000+ |
| Combined test count | 3,600+ (FIML: 1,403 + Legal: 2,240 + others) |
| Published npm packages | 6 (agentrank + 5 @25xcodes packages) |
| Production deployments | 5+ live services |
| Unique AI service integrations | 7 (Azure OpenAI, Gemini Live, Pipecat, Workers AI, LiveKit Agents, Ray, Playwright) |
| Financial data providers | 17 |
| Languages supported (compliance) | 9 |
| Docker services configured | 20+ across repos |

`;