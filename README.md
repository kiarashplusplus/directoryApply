# DirectoryApply

AI-powered job application assistant for [Work at a Startup](https://www.workatastartup.com). A private Chrome extension that reads job listings via Algolia's client-side API, matches them against a candidate profile using AI, generates personalized application notes, and sends them after human review.

## Architecture

```
┌──────────────────────┐     ┌──────────────────────────┐
│   Chrome Extension   │     │   Cloudflare Worker      │
│                      │     │   (optional)             │
│  ┌────────────────┐  │     │                          │
│  │  Popup UI      │  │     │  POST /api/match         │
│  │  - Config      │  │     │  - Receives company+jobs │
│  │  - Controls    │  │     │  - Calls Claude/GPT      │
│  │  - Review      │  │     │  - Returns best match    │
│  │  - Logs        │  │     │    + personalized note   │
│  └───────┬────────┘  │     │                          │
│          │ messages   │     │  POST /api/preview-prompt│
│  ┌───────▼────────┐  │     │  - Returns prompt text   │
│  │ Service Worker │──┼────▶│    for dry-run review    │
│  │  - Orchestrate │  │     │                          │
│  │  - Algolia API │  │     │  GET /health             │
│  │  - AI calls    │  │     └──────────────────────────┘
│  └───────┬────────┘  │
│          │ messages   │
│  ┌───────▼────────┐  │     ┌──────────────────────────┐
│  │ Content Script │──┼────▶│ workatastartup.com       │
│  │  - Credential  │  │     │  - Company pages         │
│  │    extraction  │  │     │  - Job pages             │
│  │  - Page parse  │  │     │  - Apply modals          │
│  │  - Modal ctrl  │  │     └──────────────────────────┘
│  └───────┬────────┘  │
│  ┌───────▼────────┐  │
│  │ Injected.js    │  │
│  │ (MAIN world)   │  │
│  │  - Intercept   │  │
│  │    fetch/XHR   │  │
│  │  - Capture     │  │
│  │    Algolia creds│ │
│  └────────────────┘  │
└──────────────────────┘
```

## Pipeline Steps

| # | Step | What it does | Dry-run behavior |
|---|------|-------------|-----------------|
| 1 | **Extract Algolia Config** | Intercepts or extracts Algolia app ID, API key, and search params from the page | Read-only, always runs |
| 2 | **Fetch All Companies** | Paginates through Algolia API to get all ~153 matching startups | Read-only, always runs |
| 3 | **Fetch Job Details** | For each company, fetches company page + individual job pages | Read-only, always runs |
| 4 | **AI Matching** | For each company, sends all jobs to AI to select best match and write personalized note | Calls AI API (costs $), always runs |
| 5 | **Human Review** | Displays results in popup for approve/edit/skip | Manual step |
| 6 | **Send Applications** | Opens job pages, fills Apply modal, clicks Send | **Dry Run: skips Send click** |

## Setup

### 1. Chrome Extension

```bash
# No build step needed — plain JS

# Load in Chrome:
# 1. Open chrome://extensions
# 2. Enable "Developer mode" (top right)
# 3. Click "Load unpacked"
# 4. Select the extension/ folder
```

### 2. Cloudflare Worker (optional)

The worker provides a secure server-side AI endpoint. If you skip it, the extension calls the AI API directly (API key stored locally in extension storage).

```bash
cd worker
npm install

# Set API key(s) as secrets:
npx wrangler secret put ANTHROPIC_API_KEY
# or
npx wrangler secret put OPENAI_API_KEY

# Deploy:
npm run deploy

# Dev mode:
npm run dev
```

After deploying, copy the worker URL (e.g., `https://directory-apply-worker.yourname.workers.dev`) into the extension's Configuration → Worker URL field.

### 3. Configuration

Open the extension popup and configure:

| Field | Description |
|-------|-------------|
| **Worker URL** | Your Cloudflare Worker URL. Leave empty to call AI API directly from the extension. |
| **AI Provider** | `Anthropic (Claude)` or `OpenAI (GPT)` |
| **AI API Key** | Your API key. Stored locally in Chrome storage. Sent to Worker or used directly. |
| **Model** | Default: `claude-sonnet-4-6`. Can use `gpt-4o`, `claude-opus-4-20250514`, etc. |
| **Delay (ms)** | Milliseconds between requests. Default 1000. Increase to avoid rate limits. |
| **Min Score** | Minimum AI match score (0-100) to include in review queue. Default 40. |
| **Max Companies** | Limit number of companies to process. 0 = all. Useful for testing. |
| **Dry Run** | When checked, everything runs except the final Send button click. |

## Usage

### Quick Test (Step-by-Step)

1. Navigate to `https://www.workatastartup.com/companies?...` with your filters
2. Open the extension popup
3. Click each step button in order:
   - **Step 1**: Extracts Algolia config from the page
   - **Step 2**: Fetches all companies via Algolia API (paginated)
   - **Step 3**: Fetches jobs for the first 3 companies
   - **Step 4**: Runs AI matching on the first company with jobs
   - **Step 5**: Opens a job page and tests modal interaction (dry run)

### Full Pipeline

1. Configure settings and check **Dry Run**
2. Click **Start Pipeline**
3. Monitor progress in the log section
4. When matching completes, review each recommendation:
   - See the AI's selected job, score, reasoning
   - Edit the personalized note if desired
   - Click **Approve** or **Skip**
5. Click **Send Approved** to apply (or just review in dry-run mode)

### Export Results

Click **Export JSON** to download all data: companies, jobs, match results, and application status.

## Algolia Credential Extraction

The extension uses two strategies to capture Algolia API credentials:

1. **Interceptor** (primary): `injected.js` runs in the page's MAIN world at `document_start`, monkey-patching `fetch()` and `XMLHttpRequest` to capture requests to `*.algolia.net`. Credentials are relayed to the content script via `postMessage`.

2. **Script parsing** (fallback): The content script searches `#__NEXT_DATA__`, inline `<script>` tags, and other common locations for Algolia app IDs and API keys.

**If extraction fails**: Reload the companies page after installing the extension. The interceptor needs to be active before the page makes its Algolia requests.

## AI Matching

The AI prompt includes:
- Kiarash's full resume summary (skills, experience, projects)
- Company info (name, description, industry, batch, team size)
- All available jobs with full descriptions

The AI selects the single best-matching job and writes a 2-3 sentence personalized note that:
- Opens with a specific, relevant accomplishment
- Connects experience to what the company does
- Is conversational, not a formal cover letter

## Cost Estimates

| Operation | Approximate Cost |
|-----------|-----------------|
| Algolia API calls | Free (read-only, uses site's search key) |
| Page fetching | Free (uses browser session) |
| AI matching (per company) | ~$0.01-0.05 (Claude Sonnet) |
| Full run (153 companies) | ~$2-8 depending on model |

## File Structure

```
extension/
├── manifest.json              # MV3 manifest
├── icons/icon128.png          # Extension icon
├── background/
│   └── service-worker.js      # Pipeline orchestrator
├── content/
│   ├── injected.js            # Algolia interceptor (MAIN world)
│   └── content.js             # Page parsing + modal interaction
└── popup/
    ├── popup.html             # Control panel markup
    ├── popup.css              # Dark theme styles
    └── popup.js               # UI logic + state sync

worker/
├── package.json
├── wrangler.toml
├── tsconfig.json
└── src/
    └── index.ts               # Cloudflare Worker AI matching endpoint
```

## Troubleshooting

| Issue | Solution |
|-------|---------|
| "No Algolia config" | Reload the companies page with the extension installed |
| "No WaaS tab found" | Open `workatastartup.com/companies` in a tab |
| AI returns error | Check API key, ensure model name is correct |
| Modal interaction fails | Site may have changed selectors — check content.js |
| Rate limited by Algolia | Increase delay in config |

## Security Notes

- API keys are stored in Chrome's local storage (never synced)
- The Cloudflare Worker only stores secrets via `wrangler secret` (encrypted at rest)
- All requests to AI APIs use HTTPS
- The extension only runs on `workatastartup.com`
- No data is sent to any third party beyond the configured AI provider