// DirectoryApply — Popup control panel
"use strict";

// ── DOM References ───────────────────────────────────────────────────────
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const statusBadge = $("#status-badge");
const progressSection = $("#progress-section");
const progressLabel = $("#progress-label");
const progressFill = $("#progress-fill");
const progressStats = $("#progress-stats");
const reviewSection = $("#review-section");
const reviewCount = $("#review-count");
const reviewList = $("#review-list");
const logList = $("#log-list");
const logCount = $("#log-count");

// ── Config ───────────────────────────────────────────────────────────────

function loadConfigToUI(config) {
  $("#cfg-worker-url").value = config.workerUrl || "";
  $("#cfg-worker-token").value = config.workerToken || "";
  $("#cfg-ai-provider").value = config.aiProvider || "anthropic";
  $("#cfg-ai-key").value = config.aiApiKey || "";
  $("#cfg-model").value = config.aiModel || "claude-sonnet-4-20250514";
  $("#cfg-delay").value = config.delayMs || 1000;
  $("#cfg-min-score").value = config.minMatchScore || 40;
  $("#cfg-max-companies").value = config.maxCompanies || 0;
  $("#cfg-dry-run").checked = config.dryRun !== false;
}

function getConfigFromUI() {
  return {
    workerUrl: $("#cfg-worker-url").value.trim(),
    workerToken: $("#cfg-worker-token").value.trim(),
    aiProvider: $("#cfg-ai-provider").value,
    aiApiKey: $("#cfg-ai-key").value.trim(),
    aiModel: $("#cfg-model").value.trim() || "claude-sonnet-4-20250514",
    delayMs: parseInt($("#cfg-delay").value) || 1000,
    dryRun: $("#cfg-dry-run").checked,
    minMatchScore: parseInt($("#cfg-min-score").value) || 40,
    maxCompanies: parseInt($("#cfg-max-companies").value) || 0,
    useDirectApi: !$("#cfg-worker-url").value.trim(),
  };
}

// ── State Updates ────────────────────────────────────────────────────────

function updateUI(state) {
  // Status badge
  statusBadge.textContent = state.currentStep;
  statusBadge.className = "badge " + (state.running ? "running" : state.currentStep === "reviewing" ? "reviewing" : "idle");

  // Buttons
  $("#btn-start").disabled = state.running;
  $("#btn-stop").disabled = !state.running;

  // Progress
  if (state.progress?.total > 0 || state.running) {
    progressSection.classList.remove("hidden");
    progressLabel.textContent = state.progress?.message || state.currentStep;
    const pct = state.progress?.total > 0
      ? Math.round((state.progress.current / state.progress.total) * 100)
      : 0;
    progressFill.style.width = pct + "%";

    progressStats.innerHTML = `
      <span>Companies: <b class="num">${state.companiesCount || 0}</b></span>
      <span>Jobs: <b class="num">${state.jobsScrapedCount || 0}</b></span>
      <span>Matched: <b class="num">${state.matchResultsCount || 0}</b></span>
      <span>Applied: <b class="num">${state.appliedCount || 0}</b></span>
    `;
  }

  // Review queue
  const approved = (state.reviewQueue || []).filter((r) => r.status === "approved");

  if ((state.reviewQueue || []).length > 0) {
    reviewSection.classList.remove("hidden");
    reviewCount.textContent = state.reviewQueue.length;
    $("#btn-send-approved").disabled = approved.length === 0;
    renderReviewCards(state.reviewQueue);
  }

  // Logs
  renderLogs(state.logs || []);
}

function renderReviewCards(queue) {
  // Skip full re-render when user is editing a note to preserve focus/cursor
  const activeEl = document.activeElement;
  if (activeEl && activeEl.tagName === "TEXTAREA" && reviewList.contains(activeEl)) {
    // Only update non-textarea content (status badges, new cards) via targeted patches
    const existingIds = new Set([...reviewList.querySelectorAll(".review-card")].map(c => c.dataset.id));
    const queueIds = new Set(queue.map(item => item.id));
    // If the queue composition hasn't changed, skip re-render entirely
    if (existingIds.size === queueIds.size && [...existingIds].every(id => queueIds.has(id))) {
      // Update status badges in-place for non-focused cards
      for (const item of queue) {
        const card = reviewList.querySelector(`.review-card[data-id="${CSS.escape(item.id)}"]`);
        if (card && !card.contains(activeEl)) {
          card.className = `review-card ${item.status}`;
        }
      }
      return;
    }
  }

  reviewList.innerHTML = queue
    .map((item) => {
      const scoreClass = item.selectedJob.matchScore >= 70 ? "high" : item.selectedJob.matchScore >= 45 ? "mid" : "low";
      const statusClass = item.status;

      return `
        <div class="review-card ${statusClass}" data-id="${escHtml(item.id)}">
          <div class="rc-header">
            <span class="rc-company">${escHtml(item.company.name)}</span>
            <span class="rc-score ${scoreClass}">${item.selectedJob.matchScore}</span>
          </div>
          <div class="rc-job">📋 ${escHtml(item.selectedJob.title)}</div>
          <div class="rc-reasoning">${escHtml(item.selectedJob.reasoning)}</div>
          <div class="rc-note">
            <textarea data-id="${escHtml(item.id)}" ${item.status !== "pending" ? "readonly" : ""}>${escHtml(item.note)}</textarea>
          </div>
          ${item.status === "pending" ? `
            <div class="rc-actions">
              <button class="btn btn-sm btn-success btn-approve" data-id="${escHtml(item.id)}">✓ Approve</button>
              <button class="btn btn-sm btn-danger btn-reject" data-id="${escHtml(item.id)}">✗ Skip</button>
            </div>
          ` : `
            <div class="rc-actions">
              <span class="badge ${item.status === "approved" ? "running" : item.status === "sent" ? "idle" : "error"}">${item.status}</span>
            </div>
          `}
          ${item.selectedJob.keySkills?.length ? `
            <div class="rc-skills">${item.selectedJob.keySkills.map((s) => `<span>${escHtml(s)}</span>`).join("")}</div>
          ` : ""}
        </div>
      `;
    })
    .join("");

  // Attach card event listeners
  reviewList.querySelectorAll(".btn-approve").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.id;
      const textarea = reviewList.querySelector(`textarea[data-id="${id}"]`);
      const note = textarea?.value || "";
      chrome.runtime.sendMessage({ type: "APPROVE_ITEM", id, note });
    });
  });

  reviewList.querySelectorAll(".btn-reject").forEach((btn) => {
    btn.addEventListener("click", () => {
      chrome.runtime.sendMessage({ type: "REJECT_ITEM", id: btn.dataset.id });
    });
  });

  // Save note edits
  reviewList.querySelectorAll("textarea").forEach((ta) => {
    let timeout;
    ta.addEventListener("input", () => {
      clearTimeout(timeout);
      timeout = setTimeout(() => {
        chrome.runtime.sendMessage({ type: "EDIT_NOTE", id: ta.dataset.id, note: ta.value });
      }, 500);
    });
  });
}

function renderLogs(logs) {
  logCount.textContent = logs.length;
  logList.innerHTML = logs
    .slice(-80)
    .map(
      (l) => `
      <div class="log-entry">
        <span class="log-time">${l.time}</span>
        <span class="log-msg ${l.level === "error" ? "error" : ""}">${escHtml(l.message)}</span>
      </div>
    `
    )
    .join("");
  logList.scrollTop = logList.scrollHeight;
}

function escHtml(str) {
  const div = document.createElement("div");
  div.textContent = str || "";
  return div.innerHTML;
}

// ── Event Listeners ──────────────────────────────────────────────────────

// Collapsible sections
$$(".section-toggle").forEach((btn) => {
  btn.addEventListener("click", () => {
    const target = btn.dataset.target;
    const body = $(`#${target}`);
    body.classList.toggle("collapsed");
  });
});

// Save config
$("#btn-save-config").addEventListener("click", () => {
  const config = getConfigFromUI();
  chrome.runtime.sendMessage({ type: "SAVE_CONFIG", config });
});

// Step testing
$$("[data-step]").forEach((btn) => {
  btn.addEventListener("click", () => {
    const step = parseInt(btn.dataset.step);
    btn.disabled = true;
    btn.textContent += " ⏳";

    // Save config first
    chrome.runtime.sendMessage({ type: "SAVE_CONFIG", config: getConfigFromUI() });

    chrome.runtime.sendMessage({ type: "TEST_STEP", step }, (result) => {
      btn.disabled = false;
      btn.textContent = btn.textContent.replace(" ⏳", result?.success ? " ✓" : " ✗");
      setTimeout(() => {
        btn.textContent = btn.textContent.replace(/ [✓✗]$/, "");
      }, 3000);
    });
  });
});

// Pipeline controls
$("#btn-start").addEventListener("click", () => {
  // Save config first
  chrome.runtime.sendMessage({ type: "SAVE_CONFIG", config: getConfigFromUI() });
  chrome.runtime.sendMessage({ type: "START_PIPELINE" });
});

$("#btn-stop").addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "STOP_PIPELINE" });
});

// Dry run toggle
$("#cfg-dry-run").addEventListener("change", () => {
  chrome.runtime.sendMessage({ type: "SAVE_CONFIG", config: getConfigFromUI() });
});

// Send approved
$("#btn-send-approved").addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "SEND_APPROVED" });
});

// Export
$("#btn-export").addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "EXPORT_RESULTS" }, (data) => {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `directory-apply-results-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  });
});

// Clear state
$("#btn-clear").addEventListener("click", () => {
  if (confirm("Clear all state? This cannot be undone.")) {
    chrome.runtime.sendMessage({ type: "CLEAR_STATE" });
    reviewList.innerHTML = "";
    logList.innerHTML = "";
    progressSection.classList.add("hidden");
    reviewSection.classList.add("hidden");
  }
});

// ── State Sync ───────────────────────────────────────────────────────────

// Listen for state updates from service worker
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "STATE_UPDATE") {
    updateUI(message.state);
  }
});

// Initial state load
chrome.runtime.sendMessage({ type: "GET_STATE" }, (state) => {
  if (state) {
    updateUI(state);
    // Load config into UI
    if (state.config) {
      loadConfigToUI(state.config);
    }
  }
});

// Also load config from storage
chrome.storage.local.get(["daConfig"], (result) => {
  if (result.daConfig) {
    loadConfigToUI(result.daConfig);
  }
});

// Poll for state every 2 seconds (backup for missed messages)
setInterval(() => {
  chrome.runtime.sendMessage({ type: "GET_STATE" }, (state) => {
    if (state) updateUI(state);
  });
}, 2000);
