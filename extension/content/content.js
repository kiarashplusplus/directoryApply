// DirectoryApply — Content script (ISOLATED world)
// Handles: Algolia credential relay, page scraping, modal interaction
(function () {
  "use strict";

  const LOG_PREFIX = "[DirectoryApply:content]";

  // ── Algolia Credential Relay ──────────────────────────────────────────
  // Cache the latest Algolia data received from injected.js (MAIN world) via postMessage.
  // Content scripts run in an ISOLATED world and cannot access window properties
  // set in the MAIN world, so postMessage is the only communication channel.
  let _lastAlgoliaData = null;

  // Listen for messages from injected.js (MAIN world) and forward to service worker
  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    if (event.data?.type === "DIRECTORY_APPLY_ALGOLIA_INTERCEPTED") {
      console.log(LOG_PREFIX, "Algolia credentials intercepted:", event.data.data);
      _lastAlgoliaData = event.data.data;
      chrome.runtime.sendMessage({
        type: "ALGOLIA_CREDENTIALS",
        data: event.data.data,
      });
    }
  });

  // Ask injected.js (MAIN world) to re-broadcast any cached Algolia data.
  // content.js loads at document_idle and may have missed the initial postMessage.
  window.postMessage({ type: "DIRECTORY_APPLY_REQUEST_ALGOLIA" }, window.location.origin);

  // ── Fallback: Extract Algolia credentials from page scripts ───────────
  function extractAlgoliaFromScripts() {
    const results = { appId: null, apiKey: null, indexName: null };

    // Strategy 1: Look in __NEXT_DATA__ (Next.js)
    try {
      const nextDataEl = document.querySelector("#__NEXT_DATA__");
      if (nextDataEl) {
        const nextData = JSON.parse(nextDataEl.textContent);
        const jsonStr = JSON.stringify(nextData);
        // Search for common Algolia key patterns
        const appIdMatch = jsonStr.match(
          /["'](?:algoliaAppId|ALGOLIA_APP_ID|appId)["']\s*:\s*["']([A-Z0-9]+)["']/i
        );
        const apiKeyMatch = jsonStr.match(
          /["'](?:algoliaApiKey|ALGOLIA_API_KEY|apiKey|searchApiKey)["']\s*:\s*["']([a-f0-9]+)["']/i
        );
        const indexMatch = jsonStr.match(
          /["'](?:algoliaIndex|ALGOLIA_INDEX|indexName)["']\s*:\s*["']([^"']+)["']/i
        );
        if (appIdMatch) results.appId = appIdMatch[1];
        if (apiKeyMatch) results.apiKey = apiKeyMatch[1];
        if (indexMatch) results.indexName = indexMatch[1];
      }
    } catch (err) {
      console.warn(LOG_PREFIX, "Algolia extraction from __NEXT_DATA__ failed:", err.message);
    }

    // Strategy 2: Search inline script tags
    if (!results.appId || !results.apiKey) {
      const scripts = document.querySelectorAll(
        'script:not([src]):not([type="application/ld+json"])'
      );
      for (const script of scripts) {
        const text = script.textContent || "";
        if (!results.appId) {
          const m = text.match(
            /(?:algoliaAppId|ALGOLIA_APP_ID|applicationID|appId)\s*[:=]\s*["']([A-Z0-9]{6,20})["']/i
          );
          if (m) results.appId = m[1];
        }
        if (!results.apiKey) {
          const m = text.match(
            /(?:algoliaApiKey|ALGOLIA_API_KEY|searchOnlyAPIKey|apiKey)\s*[:=]\s*["']([a-f0-9]{20,64})["']/i
          );
          if (m) results.apiKey = m[1];
        }
        if (!results.indexName) {
          const m = text.match(
            /(?:indexName|algoliaIndex|ALGOLIA_INDEX)\s*[:=]\s*["']([A-Za-z0-9_-]+)["']/i
          );
          if (m) results.indexName = m[1];
        }
      }
    }

    return results.appId && results.apiKey ? results : null;
  }

  // ── Page Parsing Functions ────────────────────────────────────────────

  // Parse the company listing page DOM to extract company cards
  function parseCompanyListings() {
    const companies = [];

    // Primary: look for links to company pages
    const companyLinks = document.querySelectorAll('a[href*="/companies/"]');
    const seen = new Set();

    for (const link of companyLinks) {
      const href = link.getAttribute("href");
      const slug = href?.match(/\/companies\/([^/?#]+)/)?.[1];
      if (!slug || seen.has(slug)) continue;
      seen.add(slug);

      // Walk up to find the card container
      const card = link.closest(
        "[data-company], .company-card, .company-row, .startup-card, li, tr, [class*='company']"
      ) || link.parentElement;

      const name =
        card?.querySelector("h2, h3, h4, [class*='name'], [class*='title']")
          ?.textContent?.trim() || slug;
      const desc =
        card?.querySelector(
          "p, [class*='description'], [class*='tagline'], [class*='one-liner']"
        )?.textContent?.trim() || "";

      companies.push({
        name,
        slug,
        description: desc,
        url: `https://www.workatastartup.com/companies/${slug}`,
      });
    }

    return companies;
  }

  // Parse a company page HTML string for job listings
  function parseCompanyPageForJobs(html, slug) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, "text/html");
    const jobs = [];

    // Strategy 1: Look for __NEXT_DATA__ with job data
    try {
      const nextData = doc.querySelector("#__NEXT_DATA__");
      if (nextData) {
        const data = JSON.parse(nextData.textContent);
        const jsonStr = JSON.stringify(data);
        // Find job objects
        const jobMatches = jsonStr.matchAll(
          /\{[^{}]*"id"\s*:\s*(\d+)[^{}]*"title"\s*:\s*"([^"]+)"[^{}]*\}/g
        );
        for (const m of jobMatches) {
          jobs.push({
            id: m[1],
            title: m[2],
            url: `https://www.workatastartup.com/jobs/${m[1]}`,
          });
        }
        if (jobs.length > 0) return jobs;
      }
    } catch (err) {
      console.warn(LOG_PREFIX, `parseCompanyPageForJobs(${slug}) __NEXT_DATA__ parse failed:`, err.message);
    }

    // Strategy 2: DOM parsing for job links
    const jobLinks = doc.querySelectorAll('a[href*="/jobs/"]');
    const seen = new Set();
    for (const link of jobLinks) {
      const href = link.getAttribute("href");
      const jobId = href?.match(/\/jobs\/(\d+)/)?.[1];
      if (!jobId || seen.has(jobId)) continue;
      seen.add(jobId);

      const row =
        link.closest("tr, li, div, [class*='job']") || link.parentElement;

      const title =
        row?.querySelector("h3, h4, [class*='title'], [class*='name']")
          ?.textContent?.trim() ||
        link.textContent?.trim() ||
        "Unknown Position";

      const location =
        row
          ?.querySelector("[class*='location']")
          ?.textContent?.trim() || "";
      const type =
        row
          ?.querySelector("[class*='type']")
          ?.textContent?.trim() || "";

      jobs.push({
        id: jobId,
        title,
        url: `https://www.workatastartup.com/jobs/${jobId}`,
        location,
        type,
      });
    }

    // Strategy 3: Look for "View Job" or "Apply" buttons
    if (jobs.length === 0) {
      const buttons = doc.querySelectorAll(
        'a[href*="/jobs/"], button[data-job-id]'
      );
      for (const btn of buttons) {
        const href = btn.getAttribute("href") || "";
        const jobId =
          href.match(/\/jobs\/(\d+)/)?.[1] ||
          btn.getAttribute("data-job-id");
        if (jobId && !seen.has(jobId)) {
          seen.add(jobId);
          jobs.push({
            id: jobId,
            title: btn.textContent?.trim() || "Unknown",
            url: `https://www.workatastartup.com/jobs/${jobId}`,
          });
        }
      }
    }

    return jobs;
  }

  // Parse a job page HTML string for full details
  function parseJobPage(html) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, "text/html");

    // Try __NEXT_DATA__ first
    try {
      const nextData = doc.querySelector("#__NEXT_DATA__");
      if (nextData) {
        const data = JSON.parse(nextData.textContent);
        const props = data?.props?.pageProps;
        if (props?.job || props?.listing) {
          const job = props.job || props.listing;
          return {
            title: job.title || "",
            description: job.description || job.body || "",
            location: job.location || (job.remote ? "Remote" : ""),
            type: job.type || job.jobType || "",
            salary: job.salary || job.salaryRange || "",
            skills: job.skills || job.tags || [],
            companyName: job.company?.name || props.company?.name || "",
            companyDescription:
              job.company?.description || props.company?.description || "",
          };
        }
      }
    } catch (err) {
      console.warn(LOG_PREFIX, "parseJobPage __NEXT_DATA__ parse failed:", err.message);
    }

    // Fallback: DOM parsing
    const title =
      doc.querySelector(
        "h1, [class*='job-title'], [class*='listing-title']"
      )?.textContent?.trim() || "";

    // Get all text from the main content area
    const mainContent =
      doc.querySelector(
        "main, [class*='job-description'], [class*='listing-content'], [class*='posting'], article"
      ) || doc.body;

    const description = mainContent?.textContent?.trim().slice(0, 5000) || "";

    const companyEl = doc.querySelector(
      "[class*='company-name'], [class*='company'] h2, [class*='company'] h3"
    );

    return {
      title,
      description,
      location: "",
      type: "",
      salary: "",
      skills: [],
      companyName: companyEl?.textContent?.trim() || "",
      companyDescription: "",
    };
  }

  // ── Modal Interaction ─────────────────────────────────────────────────

  async function interactWithApplyModal(note, dryRun) {
    const log = [];

    try {
      // Step 1: Find and click the Apply button
      const applySelectors = [
        'button:has-text("Apply")',
        'a:has-text("Apply")',
        '[class*="apply"] button',
        '[class*="apply"] a',
        'button[data-action="apply"]',
      ];

      let applyBtn = null;
      // Use text-based search since :has-text is not standard CSS
      const allButtons = document.querySelectorAll("button, a");
      for (const btn of allButtons) {
        const text = btn.textContent?.trim().toLowerCase();
        if (text === "apply" || text === "apply now" || text === "quick apply") {
          applyBtn = btn;
          break;
        }
      }

      if (!applyBtn) {
        // Try CSS selectors (some may be non-standard and throw)
        for (const sel of applySelectors) {
          try {
            applyBtn = document.querySelector(sel);
            if (applyBtn) break;
          } catch (e) {
            // Expected for non-standard selectors like :has-text()
          }
        }
      }

      if (!applyBtn) {
        log.push("ERROR: Could not find Apply button");
        return { success: false, log, error: "Apply button not found" };
      }

      log.push(`Found Apply button: "${applyBtn.textContent?.trim()}"`);

      if (dryRun) {
        log.push("[DRY RUN] Would click Apply button");
        log.push(`[DRY RUN] Would fill note: "${note}"`);
        log.push("[DRY RUN] Would click Send button");
        return { success: true, log, dryRun: true };
      }

      // Click Apply
      applyBtn.click();
      log.push("Clicked Apply button");

      // Step 2: Wait for modal to appear
      await new Promise((r) => setTimeout(r, 1500));

      // Find the textarea/input in the modal
      const inputSelectors = [
        'dialog textarea',
        'dialog input[type="text"]',
        '[class*="modal"] textarea',
        '[class*="modal"] input[type="text"]',
        '[role="dialog"] textarea',
        '[role="dialog"] input[type="text"]',
        // Generic fallback for visible textareas that appeared after click
        'textarea:not([style*="display: none"])',
      ];

      let inputEl = null;
      for (const sel of inputSelectors) {
        inputEl = document.querySelector(sel);
        if (inputEl) break;
      }

      if (!inputEl) {
        // Wait more and try again
        await new Promise((r) => setTimeout(r, 2000));
        for (const sel of inputSelectors) {
          inputEl = document.querySelector(sel);
          if (inputEl) break;
        }
      }

      if (!inputEl) {
        log.push("ERROR: Could not find text input in modal");
        return { success: false, log, error: "Modal input not found" };
      }

      log.push(`Found input field: <${inputEl.tagName.toLowerCase()}>`);

      // Fill in the note
      inputEl.focus();
      inputEl.value = note;
      // Dispatch events to trigger React state updates
      inputEl.dispatchEvent(new Event("input", { bubbles: true }));
      inputEl.dispatchEvent(new Event("change", { bubbles: true }));
      // Also try React's synthetic event approach
      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement?.prototype || window.HTMLInputElement.prototype,
        "value"
      )?.set;
      if (nativeInputValueSetter) {
        nativeInputValueSetter.call(inputEl, note);
        inputEl.dispatchEvent(new Event("input", { bubbles: true }));
      }
      log.push(`Filled note (${note.length} chars)`);

      // Step 3: Find and click Send button
      let sendBtn = null;
      const modalButtons = document.querySelectorAll(
        'dialog button, [class*="modal"] button, [role="dialog"] button'
      );
      for (const btn of modalButtons) {
        const text = btn.textContent?.trim().toLowerCase();
        if (
          text === "send" ||
          text === "submit" ||
          text === "send application" ||
          text === "send message"
        ) {
          sendBtn = btn;
          break;
        }
      }

      if (!sendBtn) {
        log.push("WARNING: Could not find Send button — note is filled, manual send needed");
        return { success: false, log, error: "Send button not found", noteFilled: true };
      }

      log.push(`Found Send button: "${sendBtn.textContent?.trim()}"`);
      sendBtn.click();
      log.push("Clicked Send button");

      // Wait for confirmation
      await new Promise((r) => setTimeout(r, 2000));
      log.push("Application sent successfully");

      return { success: true, log };
    } catch (err) {
      log.push(`ERROR: ${err.message}`);
      return { success: false, log, error: err.message };
    }
  }

  // ── Message Handler ───────────────────────────────────────────────────
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    console.log(LOG_PREFIX, "Received message:", message.type);

    switch (message.type) {
      case "EXTRACT_ALGOLIA_CONFIG": {
        // First try the cached data relayed from injected.js via postMessage
        let config = _lastAlgoliaData || null;
        if (!config || !config.appId) {
          // Fall back to parsing page scripts
          config = extractAlgoliaFromScripts();
        }
        console.log(LOG_PREFIX, "Extracted Algolia config:", config);
        sendResponse({ config });
        break;
      }

      case "PARSE_COMPANY_LISTINGS": {
        const companies = parseCompanyListings();
        console.log(LOG_PREFIX, `Parsed ${companies.length} companies from page`);
        sendResponse({ companies });
        break;
      }

      case "FETCH_AND_PARSE_COMPANY": {
        fetch(message.url, { credentials: "include" })
          .then((r) => r.text())
          .then((html) => {
            const jobs = parseCompanyPageForJobs(html, message.slug);
            sendResponse({ jobs });
          })
          .catch((err) =>
            sendResponse({ jobs: [], error: err.message })
          );
        return true; // async
      }

      case "FETCH_AND_PARSE_JOB": {
        fetch(message.url, { credentials: "include" })
          .then((r) => r.text())
          .then((html) => {
            const job = parseJobPage(html);
            sendResponse({ job });
          })
          .catch((err) =>
            sendResponse({ job: null, error: err.message })
          );
        return true; // async
      }

      case "APPLY_JOB": {
        interactWithApplyModal(message.note, message.dryRun).then((result) =>
          sendResponse(result)
        );
        return true; // async
      }

      case "PING": {
        sendResponse({ alive: true, url: window.location.href });
        break;
      }
    }
  });

  // Notify service worker that content script is ready
  chrome.runtime.sendMessage({ type: "CONTENT_SCRIPT_READY", url: window.location.href });
  console.log(LOG_PREFIX, "Content script loaded on", window.location.href);
})();
