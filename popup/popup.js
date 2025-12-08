const statusEl = document.getElementById("status");
const reportBox = document.getElementById("reportBox");
const apiKeyInput = document.getElementById("apiKey");
const depthInput = document.getElementById("crawlDepth");
const pageLimitSelect = document.getElementById("pageLimit");
const inputToggle = document.getElementById("inputToggle");
const inputContent = document.getElementById("inputContent");
const progressContainer = document.getElementById("progressContainer");
const progressStage = document.getElementById("progressStage");
const progressText = document.getElementById("progressText");
const progressBarWrapper = document.getElementById("progressBarWrapper");
const progressBar = document.getElementById("progressBar");
const progressCurrent = document.getElementById("progressCurrent");
const statsGrid = document.getElementById("statsGrid");
const statNetwork = document.getElementById("statNetwork");
const statTech = document.getElementById("statTech");
const statAnalytics = document.getElementById("statAnalytics");

let isAnalyzing = false;
let statsInterval = null;

function setCollapsibleState(expanded) {
  if (!inputContent) return;
  inputToggle.classList.toggle("open", expanded);
  inputContent.classList.toggle("open", expanded);
  if (expanded) {
    inputContent.style.maxHeight = inputContent.scrollHeight + "px";
  } else {
    inputContent.style.maxHeight = "0px";
  }
}

if (inputToggle && inputContent) {
  setCollapsibleState(false); // Default to closed
  inputToggle.addEventListener("click", () => {
    const isOpen = inputContent.classList.contains("open");
    setCollapsibleState(!isOpen);
  });
}

// Establish long-lived connection to keep service worker alive
const port = chrome.runtime.connect({ name: "cast-popup-connection" });
port.onDisconnect.addListener(() => {
  console.log("CAST: Popup connection disconnected");
  // Optional: Try to reconnect if needed
});

// Restore state when popup opens
function restoreCrawlState() {
  chrome.storage.local.get([
    "CAST_crawlActive", 
    "CAST_crawlStatus", 
    "CAST_crawlDepth",
    "CAST_visitedCount",
    "CAST_queuedCount",
    "CAST_pageLimit",
    "CAST_ragProgress" // Fetch progress too
  ], (res) => {
    // Restore Progress Bar if analyzing
    if (res.CAST_ragProgress && res.CAST_ragProgress.percentage < 100) {
      updateProgressBar(res.CAST_ragProgress);
      isAnalyzing = true; // Set flag so it continues updating
    }

    if (res.CAST_crawlActive) {
      const status = res.CAST_crawlStatus || "Crawl in progress...";
      statusEl.textContent = status;
      statusEl.style.display = "block";
      
      // Also request current status from background for real-time updates
      chrome.runtime.sendMessage({ type: "get-crawl-status" }, (response) => {
        if (response && response.active) {
          statusEl.textContent = response.status || status;
        } else if (response && response.manualMode) {
          statusEl.textContent = "Manual Mode Active";
          document.getElementById("startManual").textContent = "Stop Manual Mode";
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
  
  if (msg.type === "rag-progress") {
    updateProgressBar(msg.progress);
  }
  
  // Return false to indicate we're not sending an async response
  return false;
});

// Progress bar elements
function showStatsPanel(stats) {
  if (isAnalyzing) return;
  progressContainer.style.display = "block";
  progressStage.textContent = "Data Stats";
  progressText.textContent = stats?.updatedLabel || "Monitoring data";
  progressBarWrapper.style.display = "none";
  progressBar.style.width = "0%";
  statsGrid.style.display = "grid";
  if (stats) {
    statNetwork.textContent = stats.networkCount ?? 0;
    statTech.textContent = stats.techCount ?? 0;
    statAnalytics.textContent = stats.analyticsCount ?? 0;
    progressCurrent.textContent = "Ready for AI analysis.";
  } else {
    progressCurrent.textContent = "Fetching database stats…";
  }
}

function refreshStats() {
  if (isAnalyzing) return;
  showStatsPanel(null);
  chrome.runtime.sendMessage({ type: "get-db-stats" }, (res) => {
    if (res && !res.error) {
      const updatedLabel = `Updated ${new Date().toLocaleTimeString()}`;
      showStatsPanel({
        networkCount: res.networkCount,
        techCount: res.techCount,
        analyticsCount: res.analyticsCount,
        updatedLabel
      });
    } else {
      progressStage.textContent = "Data Stats";
      progressText.textContent = "Unavailable";
      progressBarWrapper.style.display = "none";
      statsGrid.style.display = "grid";
      progressCurrent.textContent = res?.error || "Unable to load stats.";
    }
  });
}

function updateProgressBar(progress) {
  if (!progress) return;
  
  isAnalyzing = true;
  progressContainer.style.display = "block";
  statsGrid.style.display = "none";
  progressBarWrapper.style.display = "block";
  
  progressStage.textContent = progress.stage || "Processing...";
  progressText.textContent = `${progress.percentage || 0}%`;
  progressBar.style.width = `${progress.percentage || 0}%`;
  
  if (progress.current) {
    progressCurrent.textContent = progress.current;
  } else {
    progressCurrent.textContent = `${progress.processed || 0} of ${progress.total || 0} processed`;
  }
}

// Poll for progress updates (in case popup was opened during processing)
setInterval(() => {
  chrome.storage.local.get(["CAST_ragProgress"], (res) => {
    // Always check for progress if we think we might be analyzing OR if progress exists and is incomplete
    if (res.CAST_ragProgress) {
      if (res.CAST_ragProgress.percentage < 100) {
        isAnalyzing = true;
        updateProgressBar(res.CAST_ragProgress);
      } else if (isAnalyzing) {
        // If we were analyzing but it's done now
        handleAnalysisComplete();
      }
    }
  });
}, 700);

// Restore state on popup open
restoreCrawlState();
refreshStats();
if (statsInterval) clearInterval(statsInterval);
statsInterval = setInterval(() => {
  if (!isAnalyzing) {
    refreshStats();
  }
}, 10000);

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

document.getElementById("startManual").onclick = () => {
  const btn = document.getElementById("startManual");
  const isRunning = btn.textContent.includes("Stop");
  
  if (isRunning) {
    chrome.runtime.sendMessage({ type: "manual-stop" });
    btn.textContent = "Start Manual Mode";
    statusEl.textContent = "Manual mode stopped.";
  } else {
    statusEl.textContent = "Starting Manual Mode... browser is ready for your interactions.";
    statusEl.style.display = "block";
    reportBox.textContent = "";
    
    chrome.runtime.sendMessage({ type: "manual-start" }, (res) => {
      if (res && res.error) {
        statusEl.textContent = "Error: " + res.error;
        return;
      }
      btn.textContent = "Stop Manual Mode";
    });
  }
};

document.getElementById("recommendStrategy").onclick = () => {
  statusEl.textContent = "Analyzing page structure for recommendations...";
  statusEl.style.display = "block";
  
  const strategyBox = document.getElementById("strategyBox");
  const strategyList = document.getElementById("strategyList");
  strategyBox.style.display = "none";
  strategyList.innerHTML = "";

  chrome.runtime.sendMessage({ type: "recommend-strategy" }, (res) => {
    if (!res) {
      statusEl.textContent = "No response from background.";
      return;
    }
    if (res.error) {
      statusEl.textContent = "Strategy Error: " + res.error;
      return;
    }
    
    const strategy = res.strategy;
    if (!strategy || !strategy.recommendations || strategy.recommendations.length === 0) {
      statusEl.textContent = "No specific recommendations found for this page.";
      return;
    }

    statusEl.textContent = `Found ${strategy.recommendations.length} recommendations.`;
    strategyBox.style.display = "block";

    // Store current strategy for CSV download
    window.currentStrategy = strategy.recommendations;

    // Auto-highlight all recommendations by default (as requested)
    const allHighlights = strategy.recommendations.map(rec => ({ selector: rec.selector, label: rec.eventName }));
    chrome.runtime.sendMessage({ 
        type: "highlight-all-elements", 
        highlights: allHighlights
    });

    strategy.recommendations.forEach(rec => {
      const item = document.createElement("div");
      item.style.padding = "10px";
      item.style.borderBottom = "1px solid #e2e8f0";
      item.style.display = "flex";
      item.style.flexDirection = "column";
      item.style.gap = "4px";
      item.style.cursor = "pointer";
      item.style.transition = "background-color 0.2s";
      
      item.onmouseover = () => { item.style.backgroundColor = "#f1f5f9"; };
      item.onmouseout = () => { item.style.backgroundColor = "transparent"; };
      
      item.onclick = () => {
        chrome.runtime.sendMessage({ 
            type: "highlight-element", 
            selector: rec.selector, 
            label: rec.eventName 
        });
      };

      const header = document.createElement("div");
      header.style.display = "flex";
      header.style.justifyContent = "space-between";
      header.style.alignItems = "center";

      const title = document.createElement("span");
      title.style.fontWeight = "600";
      title.style.fontSize = "13px";
      title.style.color = "#1e293b";
      title.textContent = rec.eventName || "Event Name Missing";

      const badge = document.createElement("span");
      badge.style.fontSize = "10px";
      badge.style.padding = "2px 6px";
      badge.style.borderRadius = "4px";
      badge.style.backgroundColor = rec.priority === "High" ? "#fee2e2" : "#e0f2fe";
      badge.style.color = rec.priority === "High" ? "#991b1b" : "#075985";
      badge.textContent = rec.category;

      const badgesContainer = document.createElement("div");
      badgesContainer.style.display = "flex";
      badgesContainer.style.gap = "4px";
      badgesContainer.style.alignItems = "center";

      // Auto-collected indicator (placed before category badge)
      if (rec.isAutoCollected) {
        const autoBadge = document.createElement("span");
        autoBadge.style.fontSize = "9px";
        autoBadge.style.padding = "2px 6px";
        autoBadge.style.borderRadius = "4px";
        autoBadge.style.backgroundColor = "#dcfce7";
        autoBadge.style.color = "#166534";
        autoBadge.textContent = "Auto";
        autoBadge.title = "This event is automatically collected by GA4 Enhanced Measurement";
        badgesContainer.appendChild(autoBadge);
      }

      badgesContainer.appendChild(badge);

      header.appendChild(title);
      header.appendChild(badgesContainer);

      // Append header to item first!
      item.appendChild(header);

      const desc = document.createElement("div");
      desc.style.fontSize = "11px";
      desc.style.color = "#64748b";
      desc.textContent = rec.reasoning;

      // Code Snippet Section
      if (rec.codeSnippet) {
        const codeContainer = document.createElement("div");
        codeContainer.style.marginTop = "8px";
        codeContainer.style.background = "#1e293b";
        codeContainer.style.borderRadius = "4px";
        codeContainer.style.padding = "8px";
        codeContainer.style.display = "none"; // Hidden by default
        
        // Trigger Info
        const triggerInfo = document.createElement("div");
        triggerInfo.style.color = "#94a3b8";
        triggerInfo.style.fontSize = "10px";
        triggerInfo.style.marginBottom = "4px";
        triggerInfo.style.borderBottom = "1px solid #334155";
        triggerInfo.style.paddingBottom = "4px";
        triggerInfo.innerHTML = `<strong>Trigger:</strong> ${rec.triggerType || 'CSS'} - <span style="color: #e2e8f0">${rec.triggerValue || rec.selector}</span>`;
        codeContainer.appendChild(triggerInfo);

        const pre = document.createElement("pre");
        pre.style.margin = "0";
        pre.style.whiteSpace = "pre-wrap";
        pre.style.wordBreak = "break-all";
        
        const code = document.createElement("code");
        code.style.fontFamily = "monospace";
        code.style.fontSize = "10px";
        code.style.color = "#e2e8f0";
        code.textContent = rec.codeSnippet;
        
        pre.appendChild(code);
        codeContainer.appendChild(pre);

        // Toggle button
        const toggleCode = document.createElement("button");
        toggleCode.textContent = "Show Implementation";
        toggleCode.style.fontSize = "10px";
        toggleCode.style.padding = "2px 6px";
        toggleCode.style.marginTop = "4px";
        toggleCode.style.width = "auto";
        toggleCode.style.background = "#e2e8f0";
        toggleCode.style.color = "#334155";
        toggleCode.style.border = "1px solid #cbd5e1";
        toggleCode.style.boxShadow = "none";
        
        toggleCode.onclick = (e) => {
          e.stopPropagation(); // Prevent highlighting when clicking this button
          if (codeContainer.style.display === "none") {
            codeContainer.style.display = "block";
            toggleCode.textContent = "Hide Implementation";
          } else {
            codeContainer.style.display = "none";
            toggleCode.textContent = "Show Implementation";
          }
        };

        item.appendChild(desc);
        item.appendChild(toggleCode);
        item.appendChild(codeContainer);
      } else {
        item.appendChild(desc);
      }

      strategyList.appendChild(item);
    });
  });
};

document.getElementById("closeStrategy").onclick = () => {
  document.getElementById("strategyBox").style.display = "none";
};

document.getElementById("downloadStrategy").onclick = () => {
  if (!window.currentStrategy || !window.currentStrategy.length) {
    return;
  }
  
  const rows = [["Event Name", "Category", "Reasoning", "Priority", "Trigger Type", "Trigger Value", "Selector", "Code Snippet"]];
  window.currentStrategy.forEach(rec => {
    rows.push([
      rec.eventName || "",
      rec.category || "",
      rec.reasoning || "",
      rec.priority || "",
      rec.triggerType || "CSS Selector",
      rec.triggerValue || rec.selector || "",
      rec.selector || "",
      rec.codeSnippet || ""
    ]);
  });
  
  downloadCSV("CAST_analytics_strategy.csv", rows);
};

document.getElementById("downloadJSON").onclick = () => {
  statusEl.textContent = "Preparing raw network export…";
  statusEl.style.display = "block";
  chrome.runtime.sendMessage({ type: "download-network-csv" }, (res) => {
    if (!res) {
      statusEl.textContent = "No response from background.";
      return;
    }
    if (res.error) {
      statusEl.textContent = "Download error: " + res.error;
      return;
    }
    statusEl.textContent = `Raw network calls download started (${res.count || 0} calls).`;
  });
};

document.getElementById("downloadTech").onclick = () => {
  statusEl.textContent = "Preparing consolidated tech stack export…";
  statusEl.style.display = "block";
  chrome.runtime.sendMessage({ type: "export-tech-csv" }, (res) => {
    if (!res || res.error) {
      statusEl.textContent = res?.error || "Unable to export tech stack.";
      return;
    }
    downloadCSV(res.filename || "CAST_tech_stack_consolidated.csv", res.rows || []);
    statusEl.textContent = `Tech stack export ready (${(res.rows?.length || 0) - 1} items).`;
    handleAnalysisComplete();
  });
};

document.getElementById("downloadAnalytics").onclick = () => {
  statusEl.textContent = "Preparing consolidated analytics export…";
  statusEl.style.display = "block";
  chrome.runtime.sendMessage({ type: "export-analytics-csv" }, (res) => {
    if (!res || res.error) {
      statusEl.textContent = res?.error || "Unable to export analytics events.";
      return;
    }
    downloadCSV(res.filename || "CAST_analytics_events_consolidated.csv", res.rows || []);
    statusEl.textContent = `Analytics events export ready (${(res.rows?.length || 0) - 1} events).`;
    handleAnalysisComplete();
  });
};

function handleAnalysisComplete() {
  isAnalyzing = false;
  progressBarWrapper.style.display = "none";
  statsGrid.style.display = "grid";
  progressBar.style.width = "0%";
  chrome.storage.local.remove(["CAST_ragProgress"]);
  refreshStats();
}

document.getElementById("runAI").onclick = () => {
  statusEl.textContent = "Running AI network recon…";
  reportBox.textContent = "";
  isAnalyzing = true;
  progressBarWrapper.style.display = "block";
  statsGrid.style.display = "none";
  updateProgressBar({ stage: "Preparing batches…", percentage: 0, processed: 0, total: 100, current: "Initializing AI analysis" });
  
  chrome.runtime.sendMessage({ type: "ai-summary" }, (res) => {
    handleAnalysisComplete();
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
