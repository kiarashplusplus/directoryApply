// DirectoryApply — Service Worker (background orchestrator)
// Manages pipeline: Algolia fetch → job scraping → AI matching → review → apply
"use strict";

// ── Candidate Profile (single source of truth for direct AI calls) ───────
const KIARASH_PROFILE = `KIARASH ADL — Senior SWE, US Citizen, MIT EECS '14, kiarasha@alum.mit.edu

EXPERIENCE (10+ years):
• AI Vision (Founder, 2024–Present): Patent-pending AI/CV solutions for home services. Prototype to App Store. Led multidisciplinary team.
• Technical Consulting (2019–2024): Engineering MVPs, prototypes, tech roadmaps for startups.
• Monir (Founder, 2018–2019, NYC): AI for personalized shopping. Scalable serverless Python microservices. Secured VC funding.
• Google Search (SWE, 2014–2018, NYC): Designed/deployed features in Knowledge Panel serving billions of queries. Quality improvements for Knowledge Graph image selection. Cross-functional teams.
• Twitter Ads (Intern, 2014, SF): ML algorithm for expanding ad targeting to non-Twitter users using matrix factorization in Hadoop/Scalding.
• W3C/Tim Berners-Lee (2014, MIT): Internet censorship data gathering and visualization tools.

KEY SKILLS:
• AI/ML: PyTorch, Transformers, CLIP, Ray, scikit-learn, XGBoost, GPU/CUDA
• Backend: Python (FastAPI, Flask, asyncio), microservices, Celery, Ray, Kafka, Redis, PostgreSQL
• DevOps: Docker (17+ service compositions), CI/CD, Azure/AWS/GCP
• Frontend: React.js, Expo React Native, SvelteKit, Next.js
• Observability: Prometheus, Grafana, OpenTelemetry, Sentry
• Edge/Cloud: Cloudflare Workers/Pages/D1/R2/KV/Vectorize/Queues/Durable Objects
• Leadership: Startup founding, VC fundraising, team building, architecture decisions

NOTABLE PROJECTS:
• FIML: AI MCP server for financial data — 32K+ LOC Python, 17 provider adapters, data arbitration engine, custom DSL, 9-language compliance guardrails, 1,403 tests. Ray-based multi-agent system.
• Legal AI Platform: 112K+ LOC TypeScript on Cloudflare edge — 42 API handlers, 46 services, 7-layer middleware, Durable Objects, workflow state machine, RAG, 2,240 tests. Zero origin servers.
• HireAligna.ai: Conversational AI recruiter — LiveKit voice interviews, Azure OpenAI transcription, automated candidate-job matching, Express+Next.js+PostgreSQL+Redis+Python.
• AgentRank.it: AI agent website auditor — two-speed scanner (quick + visual resolver), 5 analyzers, published npm package, MCP server.
• WebMCP Tooling Suite: 4 published npm packages — Ed25519 signed LLMFeed validator/signer, llms.txt parser, health monitor.
• Finderly: AI home improvement assistant — LiveKit voice agent, React Native/Expo, canonical ProjectState model.
• Retailfluencer: Influencer→retail attribution SaaS — Svelte 5, GS1 8112 coupon system, Prisma+PostgreSQL.

RESEARCH:
• MIT CSAIL: "Feature factory: Crowdsourced feature discovery" (ACM L@S 2015)
• MIT CSAIL: 55x GPU speedup for speech recognition (ICASSP 2012)`;

// ── State ────────────────────────────────────────────────────────────────
const state = {
  algoliaConfig: null, // { appId, apiKey, indexName, searchParams, url }
  companies: [], // [{ name, slug, description, url, ... }]
  jobsByCompany: {}, // slug -> [{ id, title, description, url, ... }]
  matchResults: [], // [{ company, selectedJob, allJobScores, ... }]
  reviewQueue: [], // Items pending human review
  appliedJobs: [], // Successfully applied
  skippedJobs: [], // Skipped by user
  currentStep: "idle", // idle | extracting | fetching_companies | fetching_jobs | matching | reviewing | applying
  progress: { current: 0, total: 0, message: "" },
  logs: [],
  running: false,
  aborted: false,
  config: {
    workerUrl: "",
    workerToken: "",
    aiProvider: "anthropic",
    aiApiKey: "",
    aiModel: "claude-sonnet-4-6",
    delayMs: 1000,
    dryRun: true,
    useDirectApi: false,
    minMatchScore: 40,
    maxCompanies: 0, // 0 = all
  },
};

function log(msg, level = "info") {
  const entry = {
    time: new Date().toISOString().slice(11, 19),
    level,
    message: msg,
  };
  state.logs.push(entry);
  // Keep last 500 logs
  if (state.logs.length > 500) state.logs.shift();
  console[level === "error" ? "error" : "log"](`[DirectoryApply:SW] ${msg}`);
  // Broadcast to popup
  broadcastState();
}

function broadcastState() {
  chrome.runtime.sendMessage({ type: "STATE_UPDATE", state: getPublicState() }).catch(() => {});
}

function getPublicState() {
  return {
    currentStep: state.currentStep,
    progress: { ...state.progress },
    logs: state.logs.slice(-100),
    companiesCount: state.companies.length,
    jobsScrapedCount: Object.keys(state.jobsByCompany).length,
    matchResultsCount: state.matchResults.length,
    reviewQueueCount: state.reviewQueue.length,
    appliedCount: state.appliedJobs.length,
    skippedCount: state.skippedJobs.length,
    running: state.running,
    algoliaConfigured: !!state.algoliaConfig,
    config: { ...state.config, aiApiKey: state.config.aiApiKey ? "***" : "", workerToken: state.config.workerToken ? "***" : "" },
    reviewQueue: state.reviewQueue,
    matchResults: state.matchResults,
  };
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchWithRetry(url, options, { retries = 3, baseDelayMs = 1000, label = "API" } = {}) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const resp = await fetch(url, options);
      if (resp.ok || (resp.status < 500 && resp.status !== 429)) return resp;
      if (attempt === retries) return resp; // return last failed response
      const delay = baseDelayMs * Math.pow(2, attempt);
      log(`${label} returned ${resp.status}, retrying in ${delay}ms (attempt ${attempt + 1}/${retries})`, "error");
      await sleep(delay);
    } catch (err) {
      if (attempt === retries) throw err;
      const delay = baseDelayMs * Math.pow(2, attempt);
      log(`${label} network error: ${err.message}, retrying in ${delay}ms (attempt ${attempt + 1}/${retries})`, "error");
      await sleep(delay);
    }
  }
  throw new Error(`${label} fetchWithRetry: all retries exhausted`);
}

// ── Service Worker Keepalive ─────────────────────────────────────────────
// MV3 service workers are terminated after ~30s of inactivity.
// Use chrome.alarms to keep the worker alive during long pipeline runs.

const KEEPALIVE_ALARM = "da-keepalive";

function startKeepalive() {
  chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.4 }); // every ~24s
}

function stopKeepalive() {
  chrome.alarms.clear(KEEPALIVE_ALARM);
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === KEEPALIVE_ALARM) {
    // The alarm firing is enough to wake/keep the SW alive.
    // Log only at debug level to avoid noise.
    if (state.running) {
      console.log("[DirectoryApply:SW] keepalive tick");
    } else {
      // Pipeline no longer running — stop pinging
      stopKeepalive();
    }
  }
});

// ── Algolia Fetching ─────────────────────────────────────────────────────

async function fetchAllCompaniesViaAlgolia() {
  if (!state.algoliaConfig) {
    throw new Error("Algolia config not captured yet. Reload workatastartup.com/companies page.");
  }

  const { appId, apiKey, url: capturedUrl, body: capturedBody } = state.algoliaConfig;
  log(`Algolia config: appId=${appId}, url=${capturedUrl}`);

  // Determine the API endpoint and reconstruct the request
  const allHits = [];
  let page = 0;
  let totalPages = 1;
  let hitsPerPage = 20;

  // Determine if it's a multi-query or single-query endpoint
  const isMultiQuery = capturedUrl?.includes("/queries");

  while (page < totalPages && !state.aborted) {
    state.progress = {
      current: page + 1,
      total: totalPages,
      message: `Fetching Algolia page ${page + 1}${totalPages > 1 ? `/${totalPages}` : ""}...`,
    };
    broadcastState();

    let fetchUrl = capturedUrl;
    let fetchBody;

    if (isMultiQuery && capturedBody?.requests) {
      // Multi-index query format
      const requests = capturedBody.requests.map((req) => ({
        ...req,
        params:
          typeof req.params === "string"
            ? req.params.replace(/page=\d+/, `page=${page}`).replace(/hitsPerPage=\d+/, `hitsPerPage=${hitsPerPage}`)
            : req.params,
        page: page,
        hitsPerPage: hitsPerPage,
      }));
      fetchBody = JSON.stringify({ requests });
    } else if (capturedBody) {
      // Single index query
      fetchBody = JSON.stringify({
        ...capturedBody,
        page,
        hitsPerPage,
      });
    } else {
      // Reconstruct from URL params
      const urlObj = new URL(capturedUrl);
      fetchBody = JSON.stringify({
        query: "",
        page,
        hitsPerPage,
      });
      fetchUrl = capturedUrl.split("?")[0];
    }

    try {
      const response = await fetchWithRetry(fetchUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Algolia-Application-Id": appId,
          "X-Algolia-API-Key": apiKey,
        },
        body: fetchBody,
      }, { retries: 3, baseDelayMs: 500, label: "Algolia" });

      if (!response.ok) {
        throw new Error(`Algolia API returned ${response.status}: ${await response.text()}`);
      }

      const data = await response.json();

      // Handle multi-query response
      const result = data.results ? data.results[0] : data;

      if (page === 0) {
        totalPages = result.nbPages || Math.ceil((result.nbHits || 0) / (result.hitsPerPage || 20));
        hitsPerPage = result.hitsPerPage || 20;
        log(`Algolia: ${result.nbHits} total hits, ${totalPages} pages of ${hitsPerPage}`);
      }

      const hits = result.hits || [];
      if (page === 0 && hits.length > 0) {
        log(`First hit keys: ${Object.keys(hits[0]).join(", ")}`);
        // Log a sample hit for debugging field names (truncated)
        const sample = {};
        for (const [k, v] of Object.entries(hits[0])) {
          if (k.startsWith("_")) continue;
          sample[k] = typeof v === "string" ? v.slice(0, 120) : v;
        }
        log(`Sample hit: ${JSON.stringify(sample).slice(0, 800)}`);
      }
      for (const hit of hits) {
        // The Algolia index may return jobs (with company info embedded) or companies directly.
        // Detect by checking for job-specific fields.
        const isJobHit = !!(hit.job_title || hit.role || hit.title) && !!(hit.company_name || hit.startup_name);

        if (isJobHit) {
          // Job-centric hit: extract company info and group later
          allHits.push({
            name: hit.company_name || hit.startup_name || hit.company || "Unknown",
            slug: hit.company_slug || hit.startup_slug || hit.company_id?.toString() || "",
            description: hit.company_one_liner || hit.one_liner || hit.company_description || "",
            url: hit.company_slug
              ? `https://www.workatastartup.com/companies/${hit.company_slug}`
              : hit.startup_slug
                ? `https://www.workatastartup.com/companies/${hit.startup_slug}`
                : "",
            industry: hit.industry || hit.vertical || "",
            teamSize: hit.team_size?.toString() || hit.teamSize || "",
            tags: hit.tags || hit._tags || [],
            batch: hit.batch || hit.yc_batch || "",
            jobCount: 1,
            // Embedded job data from the hit
            _embeddedJob: {
              title: hit.job_title || hit.role || hit.title || "",
              url: hit.url || hit.job_url || "",
              description: hit.description || hit.job_description || "",
            },
            _raw: hit,
          });
        } else {
          // Company-centric hit
          allHits.push({
            name: hit.name || hit.company_name || hit.startup_name || hit.title || "Unknown",
            slug: hit.slug || hit.company_slug || hit.startup_slug || hit.id?.toString() || "",
            description: hit.one_liner || hit.description || hit.short_description || "",
            url: `https://www.workatastartup.com/companies/${hit.slug || hit.company_slug || hit.startup_slug || ""}`,
            industry: hit.industry || hit.vertical || "",
            teamSize: hit.team_size?.toString() || hit.teamSize || "",
            tags: hit.tags || hit._tags || [],
            batch: hit.batch || hit.yc_batch || "",
            jobCount: hit.job_count || hit.jobs_count || 0,
            _raw: hit,
          });
        }
      }

      log(`Page ${page + 1}: ${hits.length} hits (total so far: ${allHits.length})`);
    } catch (err) {
      log(`Error fetching Algolia page ${page}: ${err.message}`, "error");
      // Continue to next page on non-fatal errors
      if (page === 0) throw err; // First page failure is fatal
    }

    page++;
    if (page < totalPages) await sleep(300); // Small delay between pages
  }

  // Deduplicate by company: if hits are job-centric, group by slug/name
  const hasEmbeddedJobs = allHits.some((h) => h._embeddedJob);
  if (hasEmbeddedJobs) {
    const companyMap = new Map();
    for (const hit of allHits) {
      const key = hit.slug || hit.name;
      if (!key || key === "Unknown") continue;
      if (!companyMap.has(key)) {
        const company = { ...hit, _embeddedJobs: [] };
        if (hit._embeddedJob) {
          company._embeddedJobs.push(hit._embeddedJob);
          delete company._embeddedJob;
        }
        companyMap.set(key, company);
      } else {
        const existing = companyMap.get(key);
        existing.jobCount = (existing.jobCount || 0) + 1;
        if (hit._embeddedJob) {
          existing._embeddedJobs.push(hit._embeddedJob);
        }
      }
    }
    const deduped = Array.from(companyMap.values());
    log(`Deduplicated ${allHits.length} job hits → ${deduped.length} unique companies`);
    return deduped;
  }

  return allHits;
}

// ── Job Scraping ─────────────────────────────────────────────────────────

async function getContentScriptTab() {
  const tabs = await chrome.tabs.query({ url: "https://www.workatastartup.com/*" });
  if (tabs.length > 0) return tabs[0];
  return null;
}

async function sendToContentScript(tabId, message) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      if (chrome.runtime.lastError) {
        resolve({ error: chrome.runtime.lastError.message });
      } else {
        resolve(response || {});
      }
    });
  });
}

async function fetchJobsForCompany(tabId, company) {
  // Ask content script to fetch and parse the company page
  const result = await sendToContentScript(tabId, {
    type: "FETCH_AND_PARSE_COMPANY",
    url: company.url,
    slug: company.slug,
  });

  if (result.error) {
    log(`Error scraping ${company.name}: ${result.error}`, "error");
    return [];
  }

  return result.jobs || [];
}

async function fetchJobDetails(tabId, job) {
  const result = await sendToContentScript(tabId, {
    type: "FETCH_AND_PARSE_JOB",
    url: job.url,
  });

  if (result.error) {
    log(`Error scraping job ${job.id}: ${result.error}`, "error");
    return job; // Return original job data
  }

  return { ...job, ...result.job };
}

// ── AI Matching ──────────────────────────────────────────────────────────

async function matchCompanyWithAI(company, jobs) {
  const payload = {
    company: {
      name: company.name,
      slug: company.slug,
      description: company.description,
      url: company.url,
      tags: company.tags,
      teamSize: company.teamSize,
      industry: company.industry,
      batch: company.batch,
    },
    jobs: jobs.map((j) => ({
      id: j.id,
      title: j.title,
      description: j.description || "",
      url: j.url,
      location: j.location || "",
      type: j.type || "",
      salary: j.salary || "",
    })),
    aiProvider: state.config.aiProvider,
    aiModel: state.config.aiModel,
    aiApiKey: state.config.aiApiKey,
  };

  if (state.config.useDirectApi || !state.config.workerUrl) {
    // Call AI API directly from service worker
    return await directAIMatch(payload);
  }

  // Call Cloudflare Worker
  const url = state.config.workerUrl.replace(/\/$/, "") + "/api/match";
  const headers = { "Content-Type": "application/json" };
  if (state.config.workerToken) {
    headers["Authorization"] = `Bearer ${state.config.workerToken}`;
  }
  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Worker API error ${response.status}: ${err}`);
  }

  return await response.json();
}

async function directAIMatch(payload) {
  if (!payload.aiApiKey) {
    throw new Error(`No API key configured for ${payload.aiProvider}. Set it in the popup Configuration section.`);
  }
  const MAX_DESC_CHARS = 3000;
  const jobList = payload.jobs
    .map(
      (j, i) => {
        const desc = (j.description || "(No description)").slice(0, MAX_DESC_CHARS);
        return `### Job ${i + 1}: ${j.title}\nURL: ${j.url}\n${j.location ? `Location: ${j.location}` : ""}\n${desc}\n`;
      }
    )
    .join("\n---\n");

  const prompt = `You are a job-matching AI. Match this candidate to the best job.

## Candidate
${KIARASH_PROFILE}

## Company: ${payload.company.name}
${payload.company.description || ""}
${payload.company.industry ? `Industry: ${payload.company.industry}` : ""}

## Jobs
${jobList}

Select the BEST job. Return ONLY JSON:
{"selectedJobIndex":<0-based>,"selectedJobTitle":"...","matchScore":<0-100>,"reasoning":"...","personalNote":"<2-3 sentences, max 500 chars, start with substance not greetings>","keyMatchingSkills":["..."],"allJobScores":[{"index":0,"title":"...","score":<0-100>},...]}`;

  let rawResponse;

  if (payload.aiProvider === "anthropic") {
    const resp = await fetchWithRetry("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": payload.aiApiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: payload.aiModel || "claude-sonnet-4-6",
        max_tokens: 64000,
        messages: [{ role: "user", content: prompt }],
      }),
    }, { label: "Anthropic" });
    if (!resp.ok) throw new Error(`Anthropic error ${resp.status}: ${await resp.text()}`);
    const data = await resp.json();
    rawResponse = data.content[0].text;
  } else {
    const resp = await fetchWithRetry("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${payload.aiApiKey}`,
      },
      body: JSON.stringify({
        model: payload.aiModel || "gpt-4o",
        max_tokens: 16384,
        temperature: 0.3,
        messages: [{ role: "user", content: prompt }],
      }),
    }, { label: "OpenAI" });
    if (!resp.ok) throw new Error(`OpenAI error ${resp.status}: ${await resp.text()}`);
    const data = await resp.json();
    rawResponse = data.choices[0].message.content;
  }

  // Parse response
  let cleaned = rawResponse.trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
  }

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (parseErr) {
    log(`AI response JSON parse failed. Raw (first 500 chars): ${rawResponse.slice(0, 500)}`, "error");
    throw new Error(`AI returned invalid JSON: ${parseErr.message}`);
  }

  const selectedIdx = parsed.selectedJobIndex ?? 0;
  return {
    selectedJob: {
      id: payload.jobs[selectedIdx]?.id || "0",
      title: parsed.selectedJobTitle || payload.jobs[selectedIdx]?.title || "Unknown",
      matchScore: parsed.matchScore || 0,
      reasoning: parsed.reasoning || "",
      personalNote: parsed.personalNote || "",
      keySkills: parsed.keyMatchingSkills || [],
    },
    allJobScores: (parsed.allJobScores || []).map((s, i) => ({
      id: payload.jobs[s.index ?? i]?.id || String(i),
      title: s.title || payload.jobs[s.index ?? i]?.title || "",
      score: s.score || 0,
    })),
  };
}

// ── Application Sending ──────────────────────────────────────────────────

async function applyToJob(reviewItem) {
  const { jobUrl, note, dryRun } = reviewItem;

  log(`${dryRun ? "[DRY RUN] " : ""}Applying to: ${jobUrl}`);

  // Open job page in a new tab
  const tab = await chrome.tabs.create({ url: jobUrl, active: false });
  const tabId = tab.id;

  // Wait for the tab to load (with timeout)
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      chrome.tabs.remove(tabId).catch(() => {});
      reject(new Error(`Tab load timeout for ${jobUrl}`));
    }, 30000);
    const listener = (updatedTabId, changeInfo) => {
      if (updatedTabId === tabId && changeInfo.status === "complete") {
        clearTimeout(timeout);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
  });

  // Give the page a moment to fully render
  await sleep(2000);

  // Send apply command to content script
  const result = await sendToContentScript(tabId, {
    type: "APPLY_JOB",
    note,
    dryRun,
  });

  // Close the tab
  try {
    await chrome.tabs.remove(tabId);
  } catch (err) {
    console.warn("[DirectoryApply:SW] Failed to close tab:", tabId, err.message);
  }

  return result;
}

// ── Pipeline Orchestration ───────────────────────────────────────────────

async function runFullPipeline() {
  if (state.running) {
    log("Pipeline already running!", "error");
    return;
  }

  // Pre-flight validation — fail fast before scraping hundreds of pages
  if (!state.config.aiApiKey) {
    log("❌ No AI API key configured. Set it in Configuration → AI API Key.", "error");
    return;
  }
  if (!state.config.useDirectApi && state.config.workerUrl && !state.config.workerToken) {
    log("⚠️ Worker URL set but no Worker Token — requests may fail if the worker requires auth.", "error");
  }

  state.running = true;
  state.aborted = false;
  state.matchResults = [];
  state.reviewQueue = [];
  state.appliedJobs = [];
  state.skippedJobs = [];
  startKeepalive();

  try {
    // Step 1: Ensure we have Algolia config
    state.currentStep = "extracting";
    log("Step 1: Checking Algolia configuration...");

    if (!state.algoliaConfig) {
      const tab = await getContentScriptTab();
      if (!tab) {
        throw new Error("No workatastartup.com tab found. Open the companies page first.");
      }
      // Reuse the Step 1 test logic which has multiple extraction strategies
      const stepResult = await testStep(1);
      if (!stepResult.success) {
        throw new Error(
          "Could not extract Algolia config. Navigate to workatastartup.com/companies and try again."
        );
      }
    }
    log(`✓ Algolia config ready: appId=${state.algoliaConfig.appId}`);

    // Step 2: Fetch all companies via Algolia
    state.currentStep = "fetching_companies";
    log("Step 2: Fetching all companies via Algolia API...");

    state.companies = await fetchAllCompaniesViaAlgolia();
    if (state.config.maxCompanies > 0) {
      state.companies = state.companies.slice(0, state.config.maxCompanies);
      log(`Limited to first ${state.config.maxCompanies} companies`);
    }
    log(`✓ Fetched ${state.companies.length} companies`);

    if (state.aborted) throw new Error("Aborted by user");

    // Step 3: Fetch jobs for each company
    state.currentStep = "fetching_jobs";
    log("Step 3: Fetching job listings for each company...");

    const tab = await getContentScriptTab();
    if (!tab) throw new Error("No workatastartup.com tab found.");

    for (let i = 0; i < state.companies.length; i++) {
      if (state.aborted) throw new Error("Aborted by user");

      const company = state.companies[i];
      state.progress = {
        current: i + 1,
        total: state.companies.length,
        message: `Fetching jobs: ${company.name} (${i + 1}/${state.companies.length})`,
      };
      broadcastState();

      const jobs = await fetchJobsForCompany(tab.id, company);

      // Fetch full details for each job
      const detailedJobs = [];
      for (const job of jobs) {
        if (state.aborted) throw new Error("Aborted by user");
        const detailed = await fetchJobDetails(tab.id, job);
        detailedJobs.push(detailed);
        await sleep(Math.max(200, state.config.delayMs / 2)); // Rate limit
      }

      state.jobsByCompany[company.slug] = detailedJobs;
      log(`${company.name}: ${detailedJobs.length} jobs found`);

      await sleep(state.config.delayMs);
    }

    const totalJobs = Object.values(state.jobsByCompany).reduce((s, j) => s + j.length, 0);
    log(`✓ Scraped ${totalJobs} total jobs across ${state.companies.length} companies`);

    if (state.aborted) throw new Error("Aborted by user");

    // Step 4: AI matching for each company
    state.currentStep = "matching";
    log("Step 4: Running AI matching...");

    for (let i = 0; i < state.companies.length; i++) {
      if (state.aborted) throw new Error("Aborted by user");

      const company = state.companies[i];
      const jobs = state.jobsByCompany[company.slug] || [];

      if (jobs.length === 0) {
        log(`Skipping ${company.name} — no jobs found`);
        continue;
      }

      state.progress = {
        current: i + 1,
        total: state.companies.length,
        message: `AI matching: ${company.name} (${i + 1}/${state.companies.length})`,
      };
      broadcastState();

      try {
        const matchResult = await matchCompanyWithAI(company, jobs);

        const resultEntry = {
          company,
          ...matchResult,
          timestamp: new Date().toISOString(),
        };

        state.matchResults.push(resultEntry);

        // Add to review queue if above minimum score
        if (matchResult.selectedJob.matchScore >= state.config.minMatchScore) {
          state.reviewQueue.push({
            id: `${company.slug}-${matchResult.selectedJob.id}`,
            company,
            selectedJob: matchResult.selectedJob,
            allJobScores: matchResult.allJobScores,
            jobUrl: `https://www.workatastartup.com/jobs/${matchResult.selectedJob.id}`,
            note: matchResult.selectedJob.personalNote,
            status: "pending", // pending | approved | rejected | sent
          });
        }

        log(
          `${company.name}: Best match = "${matchResult.selectedJob.title}" (score: ${matchResult.selectedJob.matchScore})`
        );
      } catch (err) {
        log(`AI matching error for ${company.name}: ${err.message}`, "error");
      }

      await sleep(state.config.delayMs);
    }

    log(`✓ AI matching complete. ${state.reviewQueue.length} items in review queue`);

    // Step 5: Wait for human review
    state.currentStep = "reviewing";
    state.progress = {
      current: state.reviewQueue.length,
      total: state.reviewQueue.length,
      message: "Waiting for review — approve or skip items in the popup",
    };
    broadcastState();
    log("Step 5: Review queue ready. Approve items in the popup to send applications.");
  } catch (err) {
    if (err.message === "Aborted by user") {
      log("Pipeline aborted by user.");
    } else {
      log(`Pipeline error: ${err.message}`, "error");
    }
  } finally {
    stopKeepalive();
    state.running = false;
    state.currentStep = state.reviewQueue.some((r) => r.status === "pending")
      ? "reviewing"
      : "idle";
    broadcastState();
  }
}

async function sendApprovedApplications() {
  const approved = state.reviewQueue.filter((r) => r.status === "approved");
  if (approved.length === 0) {
    log("No approved applications to send.");
    return;
  }

  state.currentStep = "applying";
  log(`Sending ${approved.length} approved applications...`);
  startKeepalive();

  for (let i = 0; i < approved.length; i++) {
    if (state.aborted) break;

    const item = approved[i];
    state.progress = {
      current: i + 1,
      total: approved.length,
      message: `Applying: ${item.company.name} (${i + 1}/${approved.length})`,
    };
    broadcastState();

    const result = await applyToJob({
      jobUrl: item.jobUrl,
      note: item.note,
      dryRun: state.config.dryRun,
    });

    if (result.success) {
      item.status = "sent";
      state.appliedJobs.push(item);
      log(
        `${state.config.dryRun ? "[DRY RUN] " : ""}✓ Applied to ${item.company.name}: ${item.selectedJob.title}`
      );
    } else {
      log(`✗ Failed to apply to ${item.company.name}: ${result.error}`, "error");
      item.status = "error";
      item.error = result.error;
    }

    if (result.log) {
      result.log.forEach((l) => log(`  ↳ ${l}`));
    }

    await sleep(state.config.delayMs * 2); // Extra delay between applications
  }

  state.currentStep = "idle";
  stopKeepalive();
  log(
    `✓ Application sending complete. ${state.appliedJobs.length} sent, ${approved.filter((a) => a.status === "error").length} failed.`
  );
  broadcastState();
}

// ── Individual Step Testing ──────────────────────────────────────────────

async function testStep(stepNum) {
  const tab = await getContentScriptTab();

  switch (stepNum) {
    case 1: {
      // Test Algolia config extraction
      log("Testing: Algolia config extraction...");
      if (state.algoliaConfig) {
        log(`Already have Algolia config: appId=${state.algoliaConfig.appId}`);
        return { success: true, data: state.algoliaConfig };
      }
      if (!tab) return { success: false, error: "No WaaS tab found" };

      // Strategy 1: Check if content script already has cached data
      const result = await sendToContentScript(tab.id, { type: "EXTRACT_ALGOLIA_CONFIG" });
      if (result.config?.appId && result.config?.apiKey) {
        state.algoliaConfig = result.config;
        log(`Extracted from content script: appId=${result.config.appId}`);
        return { success: true, data: state.algoliaConfig };
      }
      log("Content script extraction failed. Trying MAIN world probe...");

      // Strategy 2: Directly probe MAIN world for cached interceptor data or page globals
      try {
        const probeResults = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          world: "MAIN",
          func: () => {
            // Check interceptor cache
            if (window.__DA_ALGOLIA_DATA?.appId && window.__DA_ALGOLIA_DATA?.apiKey) {
              return window.__DA_ALGOLIA_DATA;
            }
            // Search for Algolia client instances on common global objects
            const globals = [window.__NEXT_DATA__, window.__algoliaClient, window.__STORE__];
            for (const g of globals) {
              if (!g) continue;
              const str = JSON.stringify(g);
              const appIdMatch = str.match(/"(?:algoliaAppId|ALGOLIA_APP_ID|appId|applicationID)"\s*:\s*"([A-Z0-9]{6,20})"/i);
              const apiKeyMatch = str.match(/"(?:algoliaApiKey|ALGOLIA_API_KEY|apiKey|searchApiKey|searchOnlyAPIKey)"\s*:\s*"([a-f0-9]{20,64})"/i);
              if (appIdMatch && apiKeyMatch) {
                return { appId: appIdMatch[1], apiKey: apiKeyMatch[1] };
              }
            }
            return null;
          },
        });
        const probeData = probeResults?.[0]?.result;
        if (probeData?.appId && probeData?.apiKey) {
          state.algoliaConfig = probeData;
          log(`Probed MAIN world: appId=${probeData.appId}`);
          return { success: true, data: state.algoliaConfig };
        }
      } catch (err) {
        log(`MAIN world probe failed: ${err.message}`);
      }

      // Strategy 3: Reload page to trigger fresh Algolia requests, then wait for interceptor
      log("Reloading page to capture Algolia API calls...");
      await chrome.tabs.reload(tab.id);
      // Wait for page load + interceptor
      for (let i = 0; i < 20; i++) {
        await sleep(1000);
        if (state.algoliaConfig) {
          log(`Interceptor captured Algolia config after reload: appId=${state.algoliaConfig.appId}`);
          return { success: true, data: state.algoliaConfig };
        }
      }

      // Strategy 4: After reload, probe MAIN world one more time
      try {
        const postReloadResults = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          world: "MAIN",
          func: () => window.__DA_ALGOLIA_DATA || null,
        });
        const postData = postReloadResults?.[0]?.result;
        if (postData?.appId && postData?.apiKey) {
          state.algoliaConfig = postData;
          log(`Post-reload MAIN world probe: appId=${postData.appId}`);
          return { success: true, data: state.algoliaConfig };
        }
      } catch (err) {
        log(`Post-reload probe failed: ${err.message}`);
      }

      // Strategy 5: Try triggering an Algolia call by simulating user interaction
      log("Trying to trigger Algolia call via search input...");
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          world: "MAIN",
          func: () => {
            const searchInput = document.querySelector('input[type="search"], input[placeholder*="Search"], input[class*="search"], .ais-SearchBox-input');
            if (searchInput) {
              searchInput.focus();
              searchInput.value = "a";
              searchInput.dispatchEvent(new Event("input", { bubbles: true }));
              // Reset after a moment
              setTimeout(() => {
                searchInput.value = "";
                searchInput.dispatchEvent(new Event("input", { bubbles: true }));
              }, 500);
            }
          },
        });
        // Wait for the triggered call
        for (let i = 0; i < 5; i++) {
          await sleep(1000);
          if (state.algoliaConfig) {
            log(`Triggered Algolia call captured: appId=${state.algoliaConfig.appId}`);
            return { success: true, data: state.algoliaConfig };
          }
        }
      } catch (err) {
        log(`Search trigger failed: ${err.message}`);
      }

      // Strategy 6: Inspect network requests via Performance API
      try {
        const perfResults = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          world: "MAIN",
          func: () => {
            const entries = performance.getEntriesByType("resource");
            for (const entry of entries) {
              if (entry.name.includes("algolia.net") || entry.name.includes("algolianet.com")) {
                const urlObj = new URL(entry.name);
                const appId = urlObj.hostname.split("-")[0] || urlObj.hostname.split(".")[0];
                return { appId, url: entry.name, foundVia: "performance" };
              }
            }
            return null;
          },
        });
        const perfData = perfResults?.[0]?.result;
        if (perfData?.appId) {
          log(`Found Algolia request via Performance API: appId=${perfData.appId}, url=${perfData.url}`);
          // We have the appId but still need apiKey — check page scripts
          const scriptResults = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            world: "MAIN",
            func: (knownAppId) => {
              // Search all script content for the API key associated with this app ID
              const scripts = document.querySelectorAll('script:not([type="application/ld+json"])');
              for (const script of scripts) {
                const text = script.textContent || "";
                if (text.includes(knownAppId)) {
                  const keyMatch = text.match(/["']([a-f0-9]{20,64})["']/);
                  if (keyMatch) return keyMatch[1];
                }
              }
              // Check all text content for the key pattern near our app ID
              const html = document.documentElement.innerHTML;
              const appIdPos = html.indexOf(knownAppId);
              if (appIdPos >= 0) {
                const nearby = html.substring(Math.max(0, appIdPos - 500), appIdPos + 500);
                const keyMatch = nearby.match(/['"]((?=[a-f0-9]*[a-f])[a-f0-9]{20,64})['"]/);
                if (keyMatch) return keyMatch[1];
              }
              return null;
            },
            args: [perfData.appId],
          });
          const apiKey = scriptResults?.[0]?.result;
          if (apiKey) {
            state.algoliaConfig = { appId: perfData.appId, apiKey, url: perfData.url };
            log(`Assembled config from Performance API + page scripts: appId=${perfData.appId}`);
            return { success: true, data: state.algoliaConfig };
          }
        }
      } catch (err) {
        log(`Performance API probe failed: ${err.message}`);
      }

      log("All Algolia extraction strategies failed. Check browser console for [DirectoryApply] messages.", "error");
      return { success: false, error: "Could not extract Algolia config after multiple strategies" };
    }

    case 2: {
      // Test company fetching
      log("Testing: Fetch all companies via Algolia...");
      if (!state.algoliaConfig) {
        return { success: false, error: "Run step 1 first to extract Algolia config" };
      }
      state.companies = await fetchAllCompaniesViaAlgolia();
      log(`Fetched ${state.companies.length} companies. First 3:`);
      state.companies.slice(0, 3).forEach((c) => log(`  - ${c.name} (${c.slug}): ${c.description}`));
      return { success: true, count: state.companies.length };
    }

    case 3: {
      // Test job fetching (first 3 companies only)
      log("Testing: Fetch jobs for first 3 companies...");
      if (!tab) return { success: false, error: "No WaaS tab found" };
      const testCompanies = state.companies.slice(0, 3);
      if (testCompanies.length === 0) return { success: false, error: "Run step 2 first" };

      for (const company of testCompanies) {
        const jobs = await fetchJobsForCompany(tab.id, company);
        const detailedJobs = [];
        for (const job of jobs.slice(0, 2)) {
          // First 2 jobs per company
          const detailed = await fetchJobDetails(tab.id, job);
          detailedJobs.push(detailed);
          await sleep(500);
        }
        state.jobsByCompany[company.slug] = detailedJobs;
        log(`${company.name}: ${detailedJobs.length} jobs`);
        detailedJobs.forEach((j) =>
          log(`  - ${j.title} (${j.url}) — ${(j.description || "").slice(0, 80)}...`)
        );
        await sleep(500);
      }
      return { success: true, data: state.jobsByCompany };
    }

    case 4: {
      // Test AI matching (first company with jobs)
      log("Testing: AI matching for first company...");
      const entry = Object.entries(state.jobsByCompany).find(([, jobs]) => jobs.length > 0);
      if (!entry) return { success: false, error: "Run step 3 first to get job data" };

      const [slug, jobs] = entry;
      const company = state.companies.find((c) => c.slug === slug);
      if (!company) return { success: false, error: "Company data not found" };

      log(`Matching: ${company.name} (${jobs.length} jobs)...`);
      const result = await matchCompanyWithAI(company, jobs);
      log(`Best match: "${result.selectedJob.title}" (score: ${result.selectedJob.matchScore})`);
      log(`Reasoning: ${result.selectedJob.reasoning}`);
      log(`Note: "${result.selectedJob.personalNote}"`);
      log(`Key skills: ${result.selectedJob.keySkills.join(", ")}`);
      return { success: true, data: result };
    }

    case 5: {
      // Test modal interaction (dry run only)
      log("Testing: Modal interaction (dry run)...");
      if (!tab) return { success: false, error: "No WaaS tab found" };

      // Find first job URL
      const firstJobs = Object.values(state.jobsByCompany).flat();
      if (firstJobs.length === 0) return { success: false, error: "Run step 3 first" };

      const testJob = firstJobs[0];
      log(`Opening job page: ${testJob.url}`);

      const result = await applyToJob({
        jobUrl: testJob.url,
        note: "Test note from DirectoryApply dry run — please ignore.",
        dryRun: true,
      });

      result.log?.forEach((l) => log(`  ↳ ${l}`));
      return result;
    }

    default:
      return { success: false, error: `Unknown step: ${stepNum}` };
  }
}

// ── Message Handler ──────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.type) {
    case "ALGOLIA_CREDENTIALS": {
      // Received from content script via injected.js interceptor
      if (!state.algoliaConfig || !state.algoliaConfig.appId) {
        state.algoliaConfig = message.data;
        log(`Algolia credentials captured: appId=${message.data.appId}`);
        broadcastState();
      }
      break;
    }

    case "CONTENT_SCRIPT_READY": {
      log(`Content script ready on: ${message.url}`);
      break;
    }

    case "GET_STATE": {
      sendResponse(getPublicState());
      break;
    }

    case "SAVE_CONFIG": {
      // Don't overwrite real secrets with masked placeholder values
      const incoming = { ...message.config };
      if (incoming.aiApiKey === "***") delete incoming.aiApiKey;
      if (incoming.workerToken === "***") delete incoming.workerToken;
      Object.assign(state.config, incoming);
      chrome.storage.local.set({ daConfig: state.config });
      log("Configuration saved");
      sendResponse({ success: true });
      break;
    }

    case "START_PIPELINE": {
      runFullPipeline();
      sendResponse({ success: true });
      break;
    }

    case "STOP_PIPELINE": {
      state.aborted = true;
      log("Pipeline stop requested...");
      sendResponse({ success: true });
      break;
    }

    case "TEST_STEP": {
      testStep(message.step).then((result) => sendResponse(result));
      return true; // async
    }

    case "APPROVE_ITEM": {
      const item = state.reviewQueue.find((r) => r.id === message.id);
      if (item) {
        item.status = "approved";
        if (message.note) item.note = message.note; // Allow note editing
        log(`Approved: ${item.company.name} — ${item.selectedJob.title}`);
      }
      broadcastState();
      sendResponse({ success: true });
      break;
    }

    case "REJECT_ITEM": {
      const rItem = state.reviewQueue.find((r) => r.id === message.id);
      if (rItem) {
        rItem.status = "rejected";
        state.skippedJobs.push(rItem);
        log(`Skipped: ${rItem.company.name}`);
      }
      broadcastState();
      sendResponse({ success: true });
      break;
    }

    case "EDIT_NOTE": {
      const eItem = state.reviewQueue.find((r) => r.id === message.id);
      if (eItem) {
        eItem.note = message.note;
        log(`Note edited for: ${eItem.company.name}`);
      }
      broadcastState();
      sendResponse({ success: true });
      break;
    }

    case "SEND_APPROVED": {
      sendApprovedApplications();
      sendResponse({ success: true });
      break;
    }

    case "EXPORT_RESULTS": {
      const stripRaw = (c) => { const { _raw, ...rest } = c; return rest; };
      sendResponse({
        companies: state.companies.map(stripRaw),
        jobsByCompany: state.jobsByCompany,
        matchResults: state.matchResults,
        reviewQueue: state.reviewQueue,
        appliedJobs: state.appliedJobs,
      });
      break;
    }

    case "CLEAR_STATE": {
      state.companies = [];
      state.jobsByCompany = {};
      state.matchResults = [];
      state.reviewQueue = [];
      state.appliedJobs = [];
      state.skippedJobs = [];
      state.currentStep = "idle";
      state.logs = [];
      log("State cleared");
      broadcastState();
      sendResponse({ success: true });
      break;
    }
  }
});

// ── Initialization ───────────────────────────────────────────────────────

chrome.storage.local.get(["daConfig"], (result) => {
  if (result.daConfig) {
    Object.assign(state.config, result.daConfig);
    console.log("[DirectoryApply:SW] Config loaded from storage");
  }
});

console.log("[DirectoryApply:SW] Service worker started");
