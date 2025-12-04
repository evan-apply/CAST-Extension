const statusEl = document.getElementById("status");
const reportBox = document.getElementById("reportBox");
const apiKeyInput = document.getElementById("apiKey");
const depthInput = document.getElementById("crawlDepth");
const pageLimitSelect = document.getElementById("pageLimit");

// Restore state when popup opens
function restoreCrawlState() {
  chrome.storage.local.get([
    "CAST_crawlActive", 
    "CAST_crawlStatus", 
    "CAST_crawlDepth",
    "CAST_visitedCount",
    "CAST_queuedCount",
    "CAST_pageLimit"
  ], (res) => {
    if (res.CAST_crawlActive) {
      const status = res.CAST_crawlStatus || "Crawl in progress...";
      statusEl.textContent = status;
      statusEl.style.display = "block";
      
      // Also request current status from background for real-time updates
      chrome.runtime.sendMessage({ type: "get-crawl-status" }, (response) => {
        if (response && response.active) {
          statusEl.textContent = response.status || status;
        } else if (!response || !response.active) {
          // Crawl might have finished
          statusEl.textContent = res.CAST_crawlStatus || "Crawl complete.";
        }
      });
    } else if (res.CAST_crawlStatus) {
      // Show last status even if crawl is not active
      statusEl.textContent = res.CAST_crawlStatus;
      statusEl.style.display = "block";
    }
    
    if (res.CAST_crawlDepth !== undefined) {
      depthInput.value = res.CAST_crawlDepth;
    }
    if (res.CAST_pageLimit !== undefined) {
      if (res.CAST_pageLimit === "all") {
        pageLimitSelect.value = "all";
      } else if (typeof res.CAST_pageLimit === "number") {
        pageLimitSelect.value = String(res.CAST_pageLimit);
      }
    }
  });
  
  // Set up polling for status updates (in case popup stays open)
  if (window.statusPollInterval) {
    clearInterval(window.statusPollInterval);
  }
  window.statusPollInterval = setInterval(() => {
    chrome.storage.local.get(["CAST_crawlStatus", "CAST_crawlActive"], (res) => {
      if (res.CAST_crawlActive && res.CAST_crawlStatus) {
        statusEl.textContent = res.CAST_crawlStatus;
        statusEl.style.display = "block";
      }
    });
  }, 1000); // Poll every second
}

// Listen for status updates from background
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "crawl-status-update") {
    statusEl.textContent = msg.status || "Crawling...";
    statusEl.style.display = "block";
    // Update stored status
    chrome.storage.local.set({
      CAST_crawlStatus: msg.status,
      CAST_crawlActive: msg.active
    });
  }
});

// Restore state on popup open
restoreCrawlState();

function downloadCSV(filename, rows) {
  const csvContent = rows.map(r => r.map(v => `"${String(v ?? "").replace(/"/g,'""')}"`).join(",")).join("\n");
  const blob = new Blob([csvContent], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
}

const apiKeyCheckmark = document.getElementById("apiKeyCheckmark");

// Load saved key
chrome.storage.local.get(["geminiApiKey"], (res) => {
  if (res.geminiApiKey) {
    apiKeyInput.value = res.geminiApiKey;
    apiKeyCheckmark.classList.add("visible");
  }
});

// Auto-save API key when changed
let saveTimeout;
apiKeyInput.addEventListener("input", () => {
  const val = apiKeyInput.value.trim();
  
  // Hide checkmark while typing
  apiKeyCheckmark.classList.remove("visible");
  
  // Clear previous timeout
  clearTimeout(saveTimeout);
  
  // Auto-save after user stops typing (500ms delay)
  saveTimeout = setTimeout(() => {
    if (val) {
      chrome.storage.local.set({ geminiApiKey: val }, () => {
        apiKeyCheckmark.classList.add("visible");
      });
    } else {
      // Remove key if input is cleared
      chrome.storage.local.remove(["geminiApiKey"], () => {
        apiKeyCheckmark.classList.remove("visible");
      });
    }
  }, 500);
});

document.getElementById("start").onclick = () => {
  const depth = parseInt(depthInput.value, 10);
  if (isNaN(depth) || depth < 0 || depth > 5) {
    statusEl.textContent = "Please enter a valid depth (0-5).";
    statusEl.style.display = "block";
    return;
  }
  const limitValue = pageLimitSelect.value;
  const pageLimit = limitValue === "all" ? null : parseInt(limitValue, 10);
  const limitLabel = limitValue === "all" ? "all pages" : `${limitValue} pages`;
  statusEl.textContent = `Starting crawl (depth ${depth}, limit ${limitLabel})… browser will navigate within this domain.`;
  statusEl.style.display = "block";
  reportBox.textContent = "";
  chrome.storage.local.set({ 
    CAST_crawlDepth: depth,
    CAST_pageLimit: limitValue === "all" ? "all" : pageLimit
  });
  chrome.runtime.sendMessage({ type: "crawl-start", depth: depth, pageLimit });
};

document.getElementById("downloadJSON").onclick = () => {
  chrome.runtime.sendMessage({ type: "get-report" }, (data) => {
    const calls = data?.networkCalls || [];
    if (!calls.length) {
      statusEl.textContent = "No network calls captured yet. Run a crawl first.";
      statusEl.style.display = "block";
      return;
    }
    const blob = new Blob([JSON.stringify(calls, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "CAST_network_calls.json";
    a.click();
    statusEl.textContent = "Raw network calls downloaded.";
    statusEl.style.display = "block";
  });
};

document.getElementById("runAI").onclick = () => {
  statusEl.textContent = "Running AI network recon (slim)…";
  reportBox.textContent = "";
  chrome.runtime.sendMessage({ type: "ai-summary" }, (res) => {
    if (!res) {
      statusEl.textContent = "No response from background.";
      return;
    }
    if (res.error) {
      statusEl.textContent = "AI error: " + res.error;
      return;
    }

    const summaryMarkdown = res.summary_markdown || "";
    const tech = res.tech_stack || [];
    const analytics = res.analytics_events || [];

    statusEl.textContent = "AI recon complete. CSVs downloaded.";
    reportBox.textContent = summaryMarkdown;

    if (tech.length) {
      const techRows = [["Technology","Category","Confidence","Evidence"]];
      tech.forEach(t => {
        techRows.push([
          t.name || "",
          t.category || "",
          typeof t.confidence === "number" ? t.confidence : "",
          (t.evidence || []).join(" | ")
        ]);
      });
      downloadCSV("CAST_tech_stack.csv", techRows);
    }

    if (analytics.length) {
      const aRows = [["Provider","Event Name","Page URL","Request URL","Notes"]];
      analytics.forEach(a =>
        aRows.push([
          a.provider || "",
          a.event_name || "",
          a.page_url || "",
          a.request_url || "",
          a.notes || ""
        ])
      );
      downloadCSV("CAST_analytics_events.csv", aRows);
    }
  });
};
