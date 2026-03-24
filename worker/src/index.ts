// DirectoryApply — Cloudflare Worker for AI job matching
// Receives company + jobs data, returns best match + personalized note

interface Env {
  ANTHROPIC_API_KEY?: string;
  OPENAI_API_KEY?: string;
  DA_WORKER_TOKEN?: string;
  ENVIRONMENT: string;
}

interface Job {
  id: string;
  title: string;
  description: string;
  url: string;
  location?: string;
  type?: string;
  salary?: string;
}

interface Company {
  name: string;
  slug: string;
  description: string;
  url: string;
  tags?: string[];
  teamSize?: string;
  industry?: string;
  batch?: string;
}

interface MatchRequest {
  company: Company;
  jobs: Job[];
  aiProvider: "anthropic" | "openai";
  aiModel?: string;
  aiApiKey?: string; // client-provided key (fallback if env secret not set)
}

interface MatchResult {
  selectedJob: {
    id: string;
    title: string;
    matchScore: number;
    reasoning: string;
    personalNote: string;
    keySkills: string[];
  };
  allJobScores: Array<{ id: string; title: string; score: number }>;
}

// Condensed resume for the AI prompt
const KIARASH_PROFILE = `
KIARASH ADL — Senior SWE, US Citizen, MIT EECS '14, kiarasha@alum.mit.edu

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
• MIT CSAIL: 55x GPU speedup for speech recognition (ICASSP 2012)
`.trim();

async function fetchWithRetry(
  url: string,
  options: RequestInit,
  { retries = 3, baseDelayMs = 1000 } = {}
): Promise<Response> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const resp = await fetch(url, options);
      if (resp.ok || (resp.status < 500 && resp.status !== 429)) return resp;
      if (attempt === retries) return resp;
    } catch (err) {
      if (attempt === retries) throw err;
    }
    await new Promise((r) => setTimeout(r, baseDelayMs * Math.pow(2, attempt)));
  }
  throw new Error("fetchWithRetry: unreachable");
}

function buildPrompt(company: Company, jobs: Job[]): string {
  const MAX_DESC_CHARS = 3000;
  const jobList = jobs
    .map(
      (j, i) => `
### Job ${i + 1}: ${j.title}
URL: ${j.url}
${j.location ? `Location: ${j.location}` : ""}
${j.type ? `Type: ${j.type}` : ""}
${j.salary ? `Salary: ${j.salary}` : ""}

${(j.description || "(No description available)").slice(0, MAX_DESC_CHARS)}
`
    )
    .join("\n---\n");

  return `You are an expert job-matching AI. Your task is to evaluate job openings at a company and determine the best fit for a specific senior software engineer candidate.

## Candidate Profile
${KIARASH_PROFILE}

## Company Information
Company: ${company.name}
URL: ${company.url}
${company.description ? `Description: ${company.description}` : ""}
${company.industry ? `Industry: ${company.industry}` : ""}
${company.tags?.length ? `Tags: ${company.tags.join(", ")}` : ""}
${company.teamSize ? `Team Size: ${company.teamSize}` : ""}
${company.batch ? `YC Batch: ${company.batch}` : ""}

## Available Jobs
${jobList}

## Instructions
1. Evaluate EACH job for fit based on the candidate's skills, experience level, and career trajectory.
2. Select the SINGLE best matching job. If no jobs are a reasonable fit (score < 30), still select the best one but indicate low confidence.
3. For EACH job, assign a match score (0-100) based on:
   - Technical skill overlap (40%)
   - Seniority/experience level match (25%)
   - Domain/industry relevance (20%)
   - Culture/mission alignment (15%)
4. Write a personalized note (2-3 sentences, max 500 chars) for the selected job that:
   - Opens with a specific, relevant accomplishment from the candidate's background
   - Connects that experience to what the company does or needs
   - Is conversational and genuine, NOT a formal cover letter
   - Does NOT start with "Hi" or "Dear" — starts directly with substance
5. List 3-5 key matching skills.

## Output Format
Return ONLY valid JSON (no markdown, no code fences):
{
  "selectedJobIndex": <0-based index>,
  "selectedJobTitle": "<title>",
  "matchScore": <0-100>,
  "reasoning": "<2-3 sentences explaining why this is the best match>",
  "personalNote": "<the 2-3 sentence personal note to send>",
  "keyMatchingSkills": ["skill1", "skill2", ...],
  "allJobScores": [{"index": 0, "title": "<title>", "score": <0-100>}, ...]
}`;
}

async function callAnthropic(
  prompt: string,
  apiKey: string,
  model: string
): Promise<string> {
  const response = await fetchWithRetry("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: 64000,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Anthropic API error ${response.status}: ${err}`);
  }

  const data = (await response.json()) as {
    content: Array<{ type: string; text: string }>;
  };
  return data.content[0].text;
}

async function callOpenAI(
  prompt: string,
  apiKey: string,
  model: string
): Promise<string> {
  const response = await fetchWithRetry("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      max_tokens: 16384,
      temperature: 0.3,
      messages: [
        {
          role: "system",
          content:
            "You are a job matching AI. Return only valid JSON, no markdown formatting.",
        },
        { role: "user", content: prompt },
      ],
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`OpenAI API error ${response.status}: ${err}`);
  }

  const data = (await response.json()) as {
    choices: Array<{ message: { content: string } }>;
  };
  return data.choices[0].message.content;
}

function parseAIResponse(raw: string): MatchResult {
  // Strip any markdown code fences the model might add
  let cleaned = raw.trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
  }

  const parsed = JSON.parse(cleaned);

  return {
    selectedJob: {
      id:
        parsed.selectedJobIndex !== undefined
          ? String(parsed.selectedJobIndex)
          : "0",
      title: parsed.selectedJobTitle || "Unknown",
      matchScore: Number(parsed.matchScore) || 0,
      reasoning: parsed.reasoning || "",
      personalNote: parsed.personalNote || "",
      keySkills: parsed.keyMatchingSkills || [],
    },
    allJobScores: (parsed.allJobScores || []).map(
      (s: { index: number; title: string; score: number }) => ({
        id: String(s.index),
        title: s.title,
        score: s.score,
      })
    ),
  };
}

function getCorsHeaders(request: Request) {
  const origin = request.headers.get("Origin") || "";
  // Allow Chrome extension origins and localhost dev
  const allowed =
    origin.startsWith("chrome-extension://") ||
    origin.startsWith("http://localhost") ||
    origin.startsWith("http://127.0.0.1");
  return {
    "Access-Control-Allow-Origin": allowed ? origin : "",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    Vary: "Origin",
  };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const corsHeaders = getCorsHeaders(request);

    // Handle CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    const url = new URL(request.url);

    // Health check
    if (url.pathname === "/health") {
      return Response.json(
        { status: "ok", timestamp: new Date().toISOString() },
        { headers: corsHeaders }
      );
    }

    // Authenticate API requests (skip health)
    if (env.DA_WORKER_TOKEN) {
      const auth = request.headers.get("Authorization") || "";
      const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
      if (token !== env.DA_WORKER_TOKEN) {
        return Response.json(
          { error: "Unauthorized" },
          { status: 401, headers: corsHeaders }
        );
      }
    }

    // Main matching endpoint
    if (url.pathname === "/api/match" && request.method === "POST") {
      try {
        const body = (await request.json()) as MatchRequest;

        if (!body.company || !body.jobs?.length) {
          return Response.json(
            { error: "company and jobs[] are required" },
            { status: 400, headers: corsHeaders }
          );
        }

        // Resolve API key: request body > env secret
        const provider = body.aiProvider || "anthropic";
        let apiKey = body.aiApiKey || "";
        if (!apiKey) {
          apiKey =
            provider === "anthropic"
              ? env.ANTHROPIC_API_KEY || ""
              : env.OPENAI_API_KEY || "";
        }

        if (!apiKey) {
          return Response.json(
            {
              error: `No API key for ${provider}. Provide via request body or wrangler secret.`,
            },
            { status: 400, headers: corsHeaders }
          );
        }

        const model =
          body.aiModel ||
          (provider === "anthropic" ? "claude-sonnet-4-6" : "gpt-4o");

        const prompt = buildPrompt(body.company, body.jobs);

        // Call AI
        const rawResponse =
          provider === "anthropic"
            ? await callAnthropic(prompt, apiKey, model)
            : await callOpenAI(prompt, apiKey, model);

        const result = parseAIResponse(rawResponse);

        // Map the selectedJobIndex back to the actual job
        const selectedIndex = parseInt(result.selectedJob.id) || 0;
        if (body.jobs[selectedIndex]) {
          result.selectedJob.id = body.jobs[selectedIndex].id;
          result.selectedJob.title = body.jobs[selectedIndex].title;
        }

        // Map allJobScores indices to job IDs
        result.allJobScores = result.allJobScores.map((s, i) => ({
          ...s,
          id: body.jobs[parseInt(s.id) || i]?.id || s.id,
          title: body.jobs[parseInt(s.id) || i]?.title || s.title,
        }));

        return Response.json(result, { headers: corsHeaders });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return Response.json(
          { error: message },
          { status: 500, headers: corsHeaders }
        );
      }
    }

    // Prompt preview (for dry-run inspection)
    if (url.pathname === "/api/preview-prompt" && request.method === "POST") {
      try {
        const body = (await request.json()) as MatchRequest;
        const prompt = buildPrompt(body.company, body.jobs);
        return Response.json(
          { prompt, tokenEstimate: Math.ceil(prompt.length / 4) },
          { headers: corsHeaders }
        );
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return Response.json(
          { error: message },
          { status: 500, headers: corsHeaders }
        );
      }
    }

    return Response.json(
      { error: "Not found" },
      { status: 404, headers: corsHeaders }
    );
  },
};
