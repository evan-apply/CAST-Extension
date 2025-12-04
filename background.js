// Import RAG module
importScripts('rag.js');

let maxDepth = 2; // Default depth, can be overridden by user input

let logs = {};
let queue = [];
let visited = new Set();
let allDiscoveredLinks = new Set(); // Index of all discovered links before visiting
let crawlActive = false;
let activeTabId = null;
let origin = null;
let currentTask = null;
let rag = null;
let currentSessionId = null;
let pageTimeout = null; // Timeout for page loading
const PAGE_LOAD_TIMEOUT = 15000; // 15 seconds max per page

// Normalize URL to remove fragments and normalize query params for deduplication
function normalizeUrl(url) {
  try {
    const u = new URL(url);
    // Remove fragment (hash)
    u.hash = '';
    // Sort query params for consistent comparison
    const params = Array.from(u.searchParams.entries()).sort((a, b) => a[0].localeCompare(b[0]));
    u.search = '';
    params.forEach(([key, value]) => u.searchParams.append(key, value));
    return u.href;
  } catch (e) {
    return url;
  }
}

// Helper to notify popup of status changes
function notifyPopupStatus(status) {
  // Update storage (popup will read from here)
  chrome.storage.local.set({
    CAST_crawlStatus: status,
    CAST_crawlActive: crawlActive,
    CAST_visitedCount: visited.size,
    CAST_queuedCount: queue.length,
    CAST_lastUpdate: Date.now()
  });
  
  // Also try to send message if popup is open (optional)
  try {
    chrome.runtime.sendMessage({ 
      type: "crawl-status-update", 
      status: status,
      active: crawlActive,
      visited: visited.size,
      queued: queue.length
    }).catch(() => {
      // Popup not open, that's okay - storage is the source of truth
    });
  } catch (e) {
    // Ignore errors - storage is the source of truth
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "crawl-start") {
    // Use provided depth or default to 2
    maxDepth = typeof msg.depth === 'number' && msg.depth >= 0 && msg.depth <= 5 
      ? msg.depth 
      : 2;
    startCrawl();
    return true;
  }

  if (msg.type === "page-scanned") {
    handlePageScanned(msg);
    return true;
  }

  if (msg.type === "get-report") {
    sendResponse(logs);
    return true;
  }
  
  if (msg.type === "get-crawl-status") {
    // Return current crawl status for popup restoration
    sendResponse({
      active: crawlActive,
      status: crawlActive ? `Crawling... (${visited.size} visited, ${queue.length} queued)` : "No active crawl",
      visited: visited.size,
      queued: queue.length
    });
    return true;
  }

  if (msg.type === "ai-summary") {
    chrome.storage.local.get(["geminiApiKey"], async (res) => {
      const apiKey = res.geminiApiKey;
      if (!apiKey) {
        sendResponse({ error: "No Gemini API key saved. Please save it first." });
        return;
      }
      try {
        // Use RAG for intelligent retrieval
        if (!rag) {
          rag = new CASTRAG();
          await rag.initDB();
        }

        // Generate session ID if not exists
        if (!currentSessionId) {
          currentSessionId = `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        }

        // Process network logs and create embeddings
        const processResult = await rag.processNetworkLogs(apiKey, logs, currentSessionId);
        
        // Retrieve relevant requests using semantic search
        // Add more specific queries for GA4 and event tracking
        // More queries to ensure we capture all analytics events
        const queries = [
          "google analytics 4 GA4 events tracking",
          "analytics tracking events button clicks",
          "analytics scroll events user interactions",
          "analytics form submission events",
          "analytics page view events",
          "analytics custom events tracking",
          "tech stack framework hosting",
          "google analytics gtm segment",
          "hubspot form submission",
          "CDN hosting provider",
          "event tracking user interactions",
          "analytics collect gtag events",
          "analytics measurement protocol",
          "analytics event parameters"
        ];
        
        const retrieved = await rag.retrieveForAnalysis(apiKey, queries, currentSessionId);
        
        // Don't limit analytics - we want ALL analytics events
        // Only limit tech stack and other requests
        // retrieved.analytics = retrieved.analytics.slice(0, 200); // REMOVED - keep all analytics
        retrieved.techStack = retrieved.techStack.slice(0, 200);
        retrieved.allRelevant = retrieved.allRelevant.slice(0, 300);
        
        // Build optimized payload from retrieved data
        let payload = buildRAGPayload(retrieved, logs);
        
        // Final safety check - if still too large, use filtered version
        const payloadStr = JSON.stringify(payload);
        const estimatedTokens = Math.ceil(payloadStr.length / 4);
        if (estimatedTokens > 700000) {
          console.warn('Payload still too large after RAG, using filtered version');
          payload = buildNetworkPayloadSlim(logs);
        }
        
        const aiResult = await callGemini(apiKey, payload);
        sendResponse(aiResult);
      } catch (e) {
        sendResponse({ error: e.message || String(e) });
      }
    });
    return true;
  }

  return false;
});

function startCrawl() {
  chrome.tabs.query({ active: true, lastFocusedWindow: true }, ([tab]) => {
    if (!tab || !tab.url || !tab.url.startsWith("http")) {
      return;
    }

    const u = new URL(tab.url);
    origin = u.origin;
    activeTabId = tab.id;

    logs = {};
    const seedUrl = normalizeUrl(u.href);
    queue = [{ url: u.href, depth: 0 }];
    visited = new Set();
    allDiscoveredLinks = new Set([seedUrl]); // Initialize with seed URL
    crawlActive = true;
    currentTask = null;
    
    // Store crawl state for popup persistence
    chrome.storage.local.set({
      CAST_crawlActive: true,
      CAST_crawlStatus: `Starting crawl (depth ${maxDepth})… browser will navigate within this domain.`,
      CAST_crawlStartTime: Date.now(),
      CAST_crawlDepth: maxDepth
    });
    
    // Notify popup if open
    notifyPopupStatus(`Starting crawl (depth ${maxDepth})… browser will navigate within this domain.`);
    
    // Initialize new RAG session
    currentSessionId = `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    if (rag) {
      rag.clearSession(currentSessionId).catch(console.error);
    }

    // Clear submitted forms and searched inputs for new crawl session
    chrome.storage.local.remove(['CAST_submittedForms', 'CAST_searchedInputs']);

    // Clear any existing timeout
    if (pageTimeout) {
      clearTimeout(pageTimeout);
      pageTimeout = null;
    }

      chrome.debugger.attach({ tabId: tab.id }, "1.3", (error) => {
      if (error) {
        console.error('Failed to attach debugger:', error);
        crawlActive = false;
        chrome.storage.local.set({
          CAST_crawlActive: false,
          CAST_crawlStatus: "Failed to attach debugger. Please reload the extension."
        });
        notifyPopupStatus("Failed to attach debugger. Please reload the extension.");
        return;
      }
      chrome.debugger.sendCommand({ tabId: tab.id }, "Network.enable", {
        maxResourceBufferSize: 10000000, // 10MB
        maxPostDataSize: 10000000
      });
      
      // Ensure content script is injected and ready
      chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['content/crawler.js']
      }).catch(err => {
        // Script might already be injected, that's okay
        console.log('Content script injection note:', err.message);
      });
      
      // Small delay to ensure content script is ready, then start
      setTimeout(() => {
        processNext();
      }, 500);
    });
  });
}

function processNext() {
  if (!crawlActive) {
    if (pageTimeout) {
      clearTimeout(pageTimeout);
      pageTimeout = null;
    }
    // Update storage when crawl stops
    chrome.storage.local.set({
      CAST_crawlActive: false,
      CAST_crawlStatus: "Crawl stopped."
    });
    return;
  }
  
  if (!queue.length) {
    console.log('Crawl complete: queue is empty');
    crawlActive = false;
    if (pageTimeout) {
      clearTimeout(pageTimeout);
      pageTimeout = null;
    }
    // Update stored state
    chrome.storage.local.set({
      CAST_crawlActive: false,
      CAST_crawlStatus: `Crawl complete. Visited ${visited.size} pages.`
    });
    notifyPopupStatus(`Crawl complete. Visited ${visited.size} pages.`);
    return;
  }

  const task = queue.shift();
  
  // Safety check: ensure task is valid
  if (!task || !task.url) {
    console.error('Invalid task in queue:', task);
    setTimeout(() => processNext(), 0);
    return;
  }
  
  let normalizedUrl;
  try {
    normalizedUrl = normalizeUrl(task.url);
  } catch (e) {
    console.error('Error normalizing URL:', task.url, e);
    setTimeout(() => processNext(), 0);
    return;
  }
  
  // Check if already visited (using normalized URL for better deduplication)
  if (visited.has(normalizedUrl)) {
    console.log(`Skipping already visited: ${task.url}`);
    // Use setTimeout to avoid stack overflow with deep recursion
    setTimeout(() => processNext(), 0);
    return;
  }
  
  if (task.depth > maxDepth) {
    console.log(`Skipping depth ${task.depth} (max: ${maxDepth}): ${task.url}`);
    // Use setTimeout to avoid stack overflow with deep recursion
    setTimeout(() => processNext(), 0);
    return;
  }
  
  console.log(`Processing: ${task.url} (depth ${task.depth}, queue: ${queue.length} remaining)`);
  
  // Update status
  const statusMsg = `Crawling: ${task.url} (${visited.size} visited, ${queue.length} queued)`;
  chrome.storage.local.set({ CAST_crawlStatus: statusMsg });
  notifyPopupStatus(statusMsg);

  visited.add(normalizedUrl);
  currentTask = task;
  const taskStartTime = Date.now();

  // Safety check: ensure activeTabId is valid
  if (!activeTabId) {
    console.error('activeTabId is not set, cannot navigate');
    currentTask = null;
    if (pageTimeout) clearTimeout(pageTimeout);
    processNext();
    return;
  }

  // Set timeout for page load - if page doesn't load in time, skip it
  if (pageTimeout) clearTimeout(pageTimeout);
  const taskUrlForTimeout = task.url; // Store original URL for logging
  pageTimeout = setTimeout(() => {
    if (currentTask && normalizeUrl(currentTask.url) === normalizedUrl) {
      console.warn(`Page timeout: ${taskUrlForTimeout}, skipping...`);
      // Mark as visited but with empty data
      logs[taskUrlForTimeout] = logs[taskUrlForTimeout] || {
        dom: "",
        clicks: 0,
        internalLinks: [],
        network: []
      };
      currentTask = null;
      pageTimeout = null;
      processNext();
    }
  }, PAGE_LOAD_TIMEOUT);

  // If navigating to the same URL (initial page), trigger scan directly
  chrome.tabs.get(activeTabId, (tab) => {
    if (chrome.runtime.lastError) {
      console.error('Error getting tab:', chrome.runtime.lastError.message);
      currentTask = null;
      if (pageTimeout) clearTimeout(pageTimeout);
      processNext();
      return;
    }
    
    if (!tab || !tab.url) {
      console.error('Tab not found or has no URL');
      currentTask = null;
      if (pageTimeout) clearTimeout(pageTimeout);
      processNext();
      return;
    }
    
    if (normalizeUrl(tab.url) === normalizedUrl) {
      // Already on this page, trigger scan directly
      console.log(`Already on page ${task?.url || 'unknown'}, triggering scan directly`);
      setTimeout(() => {
        sendScanMessageToTab(activeTabId, task?.depth || 0);
      }, 500);
      return;
    }
    
    // Navigate to new URL
    if (!task || !task.url) {
      console.error('Task or task.url is undefined');
      currentTask = null;
      if (pageTimeout) clearTimeout(pageTimeout);
      processNext();
      return;
    }
    
    chrome.tabs.update(activeTabId, { url: task.url }, (tab) => {
      // chrome.tabs.update callback receives the tab object, not an error
      // Check chrome.runtime.lastError for actual errors
      if (chrome.runtime.lastError) {
        console.error(`Failed to navigate to ${task?.url || 'unknown URL'}:`, chrome.runtime.lastError.message);
        currentTask = null;
        if (pageTimeout) clearTimeout(pageTimeout);
        processNext();
        return;
      }
      
      // Navigation started successfully - the onUpdated listener will handle page load
      console.log(`Navigation started to ${task.url}`);
    });
  });
}

// Helper function to send scan message with retry and injection fallback
function sendScanMessageToTab(tabId, depth) {
  let retryCount = 0;
  const maxRetries = 5;
  
  function attemptSend() {
    chrome.tabs.sendMessage(
      tabId,
      { type: "scan-page", depth: depth },
      (response) => {
        if (chrome.runtime.lastError) {
          if (retryCount < maxRetries) {
            retryCount++;
            console.log(`Retrying content script message (attempt ${retryCount}/${maxRetries})...`);
            setTimeout(() => attemptSend(), 500);
          } else {
            console.error(`Failed to communicate with content script after ${maxRetries} attempts:`, chrome.runtime.lastError.message);
            // Try to inject script manually
            chrome.scripting.executeScript({
              target: { tabId: tabId },
              files: ['content/crawler.js']
            }).then(() => {
              console.log('Content script injected, retrying message...');
              // Retry once more after injection
              setTimeout(() => attemptSend(), 500);
            }).catch(err => {
              console.error('Failed to inject content script:', err);
              // Continue anyway
              if (currentTask) {
                const taskUrl = currentTask.url;
                logs[taskUrl] = logs[taskUrl] || {
                  dom: "",
                  clicks: 0,
                  internalLinks: [],
                  network: []
                };
                currentTask = null;
                processNext();
              }
            });
          }
        } else {
          console.log(`Successfully sent scan message to content script (depth ${depth})`);
        }
      }
    );
  }
  
  attemptSend();
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!crawlActive) return;
  if (tabId !== activeTabId) return;
  if (changeInfo.status !== "complete") return;
  if (!currentTask) return;
  if (!tab.url) return;
  
  // Normalize URLs for comparison - be more flexible with redirects
  const currentUrl = normalizeUrl(tab.url);
  const taskUrl = normalizeUrl(currentTask.url);
  
  // Allow URL to match even if redirected (same origin and similar path)
  const currentUrlObj = new URL(tab.url);
  const taskUrlObj = new URL(currentTask.url);
  const urlMatches = currentUrl === taskUrl || 
                     (currentUrlObj.origin === taskUrlObj.origin && 
                      currentUrlObj.pathname === taskUrlObj.pathname);
  
  if (!urlMatches) {
    // If URL doesn't match but we're waiting for this page, it might be a redirect
    // Check if we should still process it
    if (currentTask && currentUrlObj.origin === origin) {
      // Same origin, might be a redirect - process it anyway
      console.log(`URL mismatch (possible redirect): expected ${taskUrl}, got ${currentUrl}`);
    } else {
      return; // Different origin, skip
    }
  }

  // Clear page timeout since page loaded
  if (pageTimeout) {
    clearTimeout(pageTimeout);
    pageTimeout = null;
  }

  // Use the shared helper function to send scan message
  // Wait a bit for content script to be ready
  setTimeout(() => sendScanMessageToTab(tabId, currentTask.depth), 500);
});

function handlePageScanned(msg) {
  const { url, depth, dom, clicks, internalLinks } = msg;
  
  // Only process if this matches the current task (prevent processing old messages)
  // But be flexible - if no current task, still process it (might be from a redirect)
  if (currentTask) {
    const msgUrl = normalizeUrl(url);
    const taskUrl = normalizeUrl(currentTask.url);
    if (msgUrl !== taskUrl) {
      // Check if it's same origin - might be a redirect
      try {
        const msgUrlObj = new URL(url);
        const taskUrlObj = new URL(currentTask.url);
        if (msgUrlObj.origin !== taskUrlObj.origin) {
          console.log(`Ignoring page-scanned for ${url} (different origin), current task is ${currentTask.url}`);
          return;
        }
        // Same origin, accept it (likely a redirect)
        console.log(`Accepting page-scanned for ${url} (redirect from ${currentTask.url})`);
      } catch (e) {
        console.log(`Ignoring page-scanned for ${url}, current task is ${currentTask.url}`);
        return;
      }
    }
  }
  
  logs[url] = logs[url] || {
    dom,
    clicks,
    internalLinks: [],
    network: []
  };
  logs[url].dom = dom;
  logs[url].clicks = clicks;
  logs[url].internalLinks = internalLinks || [];

  if (depth < maxDepth && internalLinks && internalLinks.length) {
    // Index and deduplicate links before adding to queue
    const newLinks = [];
    for (const href of internalLinks) {
      try {
        const u = new URL(href);
        if (u.origin === origin) {
          const normalized = normalizeUrl(u.href);
          
          // Check if we've already discovered this link (even if not visited yet)
          if (!allDiscoveredLinks.has(normalized) && !visited.has(normalized)) {
            allDiscoveredLinks.add(normalized);
            newLinks.push({ url: u.href, depth: depth + 1 });
          }
        }
      } catch (e) {
        console.warn('CAST: Error processing link:', href, e);
      }
    }
    
    // Add all new unique links to queue at once
    if (newLinks.length > 0) {
      queue.push(...newLinks);
      // Sort queue by depth to prioritize breadth-first crawling
      queue.sort((a, b) => a.depth - b.depth);
      console.log(`CAST: Added ${newLinks.length} new links from ${url}. Queue now has ${queue.length} items.`);
    }
  }
  
  // Update status after discovering links
  const statusMsg = `Page scanned: ${url} (${visited.size} visited, ${queue.length} queued)`;
  chrome.storage.local.set({ CAST_crawlStatus: statusMsg });
  notifyPopupStatus(statusMsg);

  // Clear any pending timeout
  if (pageTimeout) {
    clearTimeout(pageTimeout);
    pageTimeout = null;
  }

  // Clear current task
  currentTask = null;

  // Wait briefly to capture analytics events before moving to next page
  setTimeout(() => {
    processNext();
  }, 400); // Reduced from 800ms to 400ms - faster page transitions
}

chrome.debugger.onEvent.addListener((src, method, params) => {
  if (!activeTabId || src.tabId !== activeTabId) return;

  chrome.tabs.get(activeTabId, (tab) => {
    const url = tab?.url;
    if (!url) return;
    logs[url] = logs[url] || {
      dom: "",
      clicks: 0,
      internalLinks: [],
      network: []
    };
    logs[url].network.push({ method, params });
  });
});

// --- Intelligent network payload - prioritize analytics & tech stack, limit others ---
// Strategy: Keep ALL analytics requests with full data, keep tech stack indicators,
// but limit/summarize other requests to stay within token limits

function buildNetworkPayloadSlim(logs) {
  const pages = [];
  const entries = Object.entries(logs);

  // Sort pages deterministically (by URL)
  entries.sort((a, b) => a[0].localeCompare(b[0]));
  
  // Limit to first 20 pages to prevent token overflow (still comprehensive)
  const limitedPages = entries.slice(0, 20);

  // Patterns to identify analytics and tech stack domains
  const analyticsPattern = /(google-analytics|googletagmanager|segment|mixpanel|amplitude|hotjar|clarity|hubspot|adroll|facebook|meta|tiktok|linkedin|twitter|pinterest|reddit|quora|bing|microsoft|sentry|datadog|newrelic|fullstory|heap|pendo|optimizely|vwo|ab-tasty)/i;
  const techStackPattern = /(vercel|netlify|cloudflare|aws|azure|gcp|fastly|akamai|cloudfront|contentful|wordpress|shopify|sanity|strapi|prismic|drupal|squarespace|wix|webflow|nextjs|react|vue|angular|svelte|nuxt|gatsby)/i;
  const cdnPattern = /(cdn|static|assets|jsdelivr|unpkg|cdnjs)/i;

  for (const [pageUrl, entry] of limitedPages) {
    const net = entry.network || [];
    const requests = [];
    const responses = [];
    const seenUrls = new Set(); // Deduplicate similar requests

    for (const n of net) {
      if (n.method === "Network.requestWillBeSent") {
        const req = n.params && n.params.request;
        const requestId = n.params.requestId;
        if (!req || !req.url) continue;

        try {
          const u = new URL(req.url);
          const hostname = u.hostname;
          const pathname = u.pathname;
          
          // Determine if this is analytics, tech stack, or other
          const isAnalytics = analyticsPattern.test(hostname) || analyticsPattern.test(pathname);
          const isTechStack = techStackPattern.test(hostname) || techStackPattern.test(pathname) || cdnPattern.test(hostname);
          const isImportant = isAnalytics || isTechStack;
          
          // For non-important requests, create a simplified signature to deduplicate
          if (!isImportant) {
            const signature = `${hostname}${pathname}`;
            if (seenUrls.has(signature)) {
              continue; // Skip duplicate non-important requests
            }
            seenUrls.add(signature);
          }
          
          const queryKeys = Array.from(u.searchParams.keys());
          const queryParams = Object.fromEntries(u.searchParams.entries());
          const headers = req.headers || {};
          const headerKeys = Object.keys(headers);
          
          // Full data for analytics and tech stack, limited for others
          let headerValues = {};
          let postData = null;
          
          if (isImportant) {
            // Full headers and POST data for analytics/tech stack
            headerValues = headers;
            postData = req.postData || null;
            
            // Truncate very large POST bodies (keep first 2000 chars)
            if (postData && postData.length > 2000) {
              postData = postData.slice(0, 2000) + '...[truncated]';
            }
          } else {
            // For other requests, only include essential headers
            const essentialHeaders = ['user-agent', 'referer', 'origin', 'content-type', 'authorization'];
            for (const key of essentialHeaders) {
              if (headers[key]) {
                headerValues[key] = headers[key];
              }
            }
            // No POST data for non-important requests
          }

          const item = {
            requestId,
            host: hostname,
            pathname: pathname,
            method: req.method || "GET",
            queryKeys,
            queryParams: isImportant ? queryParams : {}, // Full query params only for important
            headerKeys,
            headerValues,
            hasBody: !!req.postData,
            postData: postData
          };
          
          requests.push(item);
        } catch (e) {
          continue;
        }
      } else if (n.method === "Network.responseReceived") {
        const response = n.params && n.params.response;
        const requestId = n.params.requestId;
        if (!response || !response.url) continue;

        try {
          const u = new URL(response.url);
          const isAnalytics = analyticsPattern.test(u.hostname) || analyticsPattern.test(u.pathname);
          const isTechStack = techStackPattern.test(u.hostname) || techStackPattern.test(u.pathname) || cdnPattern.test(u.hostname);
          const isImportant = isAnalytics || isTechStack;
          
          responses.push({
            requestId,
            url: response.url,
            status: response.status,
            statusText: response.statusText,
            mimeType: response.mimeType,
            headers: isImportant ? (response.headers || {}) : {} // Full headers only for important
          });
        } catch (e) {
          continue;
        }
      }
    }

    // Only include pages with requests (skip empty pages)
    if (requests.length > 0) {
      pages.push({
        pageUrl,
        requests,
        responses
      });
    }
  }

  // Estimate payload size (rough approximation: 1 token ≈ 4 characters)
  const payloadStr = JSON.stringify({ pages });
  const estimatedTokens = Math.ceil(payloadStr.length / 4);
  
  // If still too large (>800k tokens to leave room), reduce further
  if (estimatedTokens > 800000) {
    // Further reduce: limit to 15 pages and 200 requests per page for non-analytics
    const furtherReduced = pages.slice(0, 15).map(page => {
      const analyticsRequests = page.requests.filter(r => 
        analyticsPattern.test(r.host) || analyticsPattern.test(r.pathname)
      );
      const techStackRequests = page.requests.filter(r => 
        !analyticsPattern.test(r.host) && !analyticsPattern.test(r.pathname) &&
        (techStackPattern.test(r.host) || techStackPattern.test(r.pathname) || cdnPattern.test(r.host))
      );
      const otherRequests = page.requests.filter(r => 
        !analyticsPattern.test(r.host) && !analyticsPattern.test(r.pathname) &&
        !techStackPattern.test(r.host) && !techStackPattern.test(r.pathname) && !cdnPattern.test(r.host)
      ).slice(0, 200); // Limit to 200 other requests per page
      
      return {
        ...page,
        requests: [...analyticsRequests, ...techStackRequests, ...otherRequests]
      };
    });
    
    return { pages: furtherReduced };
  }
  
  return { pages };
}

// Build payload from RAG-retrieved data
function buildRAGPayload(retrieved, logs) {
  const pages = [];
  const pageMap = new Map();
  // Higher limits for analytics to capture all events - NO LIMIT for analytics
  const MAX_ANALYTICS_REQUESTS_PER_PAGE = 9999; // Effectively unlimited for analytics
  const MAX_OTHER_REQUESTS_PER_PAGE = 100; // Limit for non-analytics
  const MAX_POST_BODY_SIZE = 5000; // Increased to 5000 to capture batched GA4 events
  const MAX_ANALYTICS_POST_BODY_SIZE = 20000; // Even larger for analytics POST bodies (20KB)
  const MAX_PAGES = 30; // Increased from 20 to capture more pages

  // Deduplicate requests - but for analytics, include POST data in key to avoid deduplicating different events
  const seenRequests = new Set();
  const uniqueRequests = [];
  
  for (const request of [...retrieved.analytics, ...retrieved.techStack, ...retrieved.allRelevant]) {
    const isAnalytics = /(google-analytics|analytics\.google|googletagmanager|gtag|gtm|segment|mixpanel|amplitude|hotjar|clarity|hubspot|adroll|facebook|meta|tiktok)/i.test(request.host);
    
    // For analytics, include POST data preview in deduplication key (different events = different POST bodies)
    // For others, just use URL + query params
    const postPreview = isAnalytics && request.postData 
      ? (typeof request.postData === 'string' ? request.postData.slice(0, 200) : JSON.stringify(request.postData).slice(0, 200))
      : '';
    const requestKey = `${request.host}${request.pathname}${JSON.stringify(request.queryParams || {})}${postPreview}`;
    
    if (!seenRequests.has(requestKey)) {
      seenRequests.add(requestKey);
      
      // Truncate POST body if too large (but keep full data for analytics)
      const isAnalytics = /(google-analytics|analytics\.google|googletagmanager|gtag|gtm|segment|mixpanel|amplitude|hotjar|clarity|hubspot|adroll|facebook|meta|tiktok)/i.test(request.host);
      const maxPostSize = isAnalytics ? MAX_ANALYTICS_POST_BODY_SIZE : MAX_POST_BODY_SIZE;
      
      if (request.postData && typeof request.postData === 'string' && request.postData.length > maxPostSize) {
        request.postData = request.postData.slice(0, maxPostSize) + '...[truncated]';
      }
      
      // Limit header values to essential ones only
      if (request.headerValues) {
        const essentialHeaders = ['user-agent', 'referer', 'content-type', 'authorization', 'x-forwarded-for'];
        const filteredHeaders = {};
        for (const key of essentialHeaders) {
          if (request.headerValues[key]) {
            filteredHeaders[key] = request.headerValues[key];
          }
        }
        request.headerValues = filteredHeaders;
      }
      
      uniqueRequests.push(request);
    }
  }

  // Group retrieved requests by page URL
  for (const request of uniqueRequests) {
    const pageUrl = request.pageUrl || 'unknown';
    if (!pageMap.has(pageUrl)) {
      pageMap.set(pageUrl, {
        pageUrl,
        requests: [],
        responses: []
      });
    }
    const page = pageMap.get(pageUrl);
    // Check if it's analytics - allow more requests for analytics
    const isAnalytics = /(google-analytics|analytics\.google|googletagmanager|gtag|gtm|segment|mixpanel|amplitude|hotjar|clarity|hubspot|adroll|facebook|meta|tiktok)/i.test(request.host);
    const maxRequests = isAnalytics ? MAX_ANALYTICS_REQUESTS_PER_PAGE : MAX_OTHER_REQUESTS_PER_PAGE;
    
    if (page.requests.length < maxRequests) {
      page.requests.push(request);
    }
  }

  // Add pages from logs that have retrieved requests (limit to MAX_PAGES)
  const entries = Object.entries(logs).slice(0, MAX_PAGES);
  for (const [pageUrl, entry] of entries) {
    if (pageMap.has(pageUrl)) {
      const page = pageMap.get(pageUrl);
      
      // Add responses if available (limit responses too)
      const net = entry.network || [];
      let responseCount = 0;
      const maxResponses = MAX_ANALYTICS_REQUESTS_PER_PAGE; // Use same limit as requests
      for (const n of net) {
        if (responseCount >= maxResponses) break;
        if (n.method === "Network.responseReceived") {
          const response = n.params?.response;
          if (response) {
            page.responses.push({
              requestId: n.params.requestId,
              url: response.url,
              status: response.status,
              mimeType: response.mimeType,
              headers: {} // Don't include response headers to save space
            });
            responseCount++;
          }
        }
      }
      
      pages.push(page);
    }
  }

  // Final size check - estimate tokens (1 token ≈ 4 characters)
  const payload = { 
    pages,
    summary: {
      totalAnalyticsRequests: retrieved.analytics.length,
      totalTechStackRequests: retrieved.techStack.length,
      totalRelevantRequests: retrieved.allRelevant.length
    }
  };
  
  const payloadStr = JSON.stringify(payload);
  const estimatedTokens = Math.ceil(payloadStr.length / 4);
  
  // If still too large, use fallback to filtered version
  if (estimatedTokens > 700000) {
    console.warn('RAG payload too large, using filtered fallback');
    return buildNetworkPayloadSlim(logs);
  }

  return payload;
}

// ---- Gemini 2.5 Flash call ----

async function callGemini(apiKey, networkPayload) {
  const endpoint =
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=" +
    encodeURIComponent(apiKey);

  const systemPrompt = `
You are CAST, a web reconnaissance analyst.

You will receive JSON data from a RAG (Retrieval-Augmented Generation) system that has semantically retrieved the most relevant network requests.

The data includes:
- Analytics requests: Semantically retrieved requests from Google Analytics, GTM, Segment, Mixpanel, HubSpot, etc. with FULL data
- Tech stack requests: Semantically retrieved requests from CDN, hosting, CMS, frameworks with FULL data
- All relevant requests: Other requests that are semantically similar to analytics/tech stack queries

Each request includes:
- host, pathname, method, requestId, pageUrl
- query parameter KEYS and VALUES (full data)
- header KEYS and VALUES (full data)
- hasBody flag
- postData (full POST body when present)
- Response data (status, mimeType, headers) when available, matched by requestId

The RAG system has already filtered and retrieved the most relevant requests using semantic search, so you can focus on comprehensive analysis without worrying about missing critical data. Extract ALL analytics events and complete tech stack information from this intelligently retrieved dataset.

From ONLY that evidence, you must infer:

1) The web technology stack:
   - Frameworks (e.g., Next.js, React, Vue, Angular, etc.)
   - Hosting/CDN (e.g., Vercel, Cloudflare, Netlify, Akamai, etc.)
   - CMS or content platforms (e.g., Contentful, WordPress, Shopify, etc.)
   - Other notable infrastructure / APIs (auth, search, experimentation, etc.)

2) Analytics and tracking tools & events:
   - Identify providers (Google Analytics, GTM, Segment, Mixpanel, Amplitude, Meta Pixel, TikTok, Hotjar, Clarity, HubSpot, etc.)
   - For each provider, generate a comprehensive list of event types based on URL paths, query keys, and request patterns:
     * Page view events: "page_view", "pageview", "pv", etc.
     * Scroll events: "scroll", "scroll_depth", "scroll_percentage", etc. (look for scroll-related query params or paths)
     * Click events: "click", "button_click", "link_click", "cta_click", etc.
     * Form events: "form_submit", "form_view", "form_start", "email_submit", "newsletter_signup", etc.
     * Search events: "search", "search_query", "site_search", etc.
     * Engagement events: "engagement", "time_on_page", "video_play", etc.
     * Custom events: infer from query parameter names, URL paths, or request bodies
   - Be thorough: if you see multiple requests to the same analytics provider, list each distinct event pattern
   - Include events even if the exact event name isn't clear - infer from context (e.g., if you see a HubSpot form script, include "form_view" and "form_submit" events)

You MUST respond with valid JSON ONLY, matching this TypeScript interface exactly:

interface AIReconResult {
  summary_markdown: string;
  tech_stack: {
    name: string;
    category: string;    // "framework", "cdn", "cms", "analytics", "infrastructure", "other"
    confidence: number;  // 0.0 - 1.0
    evidence: string[];  // short strings explaining why you believe this
  }[];
  analytics_events: {
    provider: string;
    event_name: string | null;
    page_url: string | null;
    request_url: string | null;
    notes: string | null;
  }[];
}

Rules:
- Analyze ALL pages and ALL requests - this is comprehensive data with no limits.
- Do NOT hallucinate technologies that you cannot reasonably tie to evidence.
- The "evidence" field should quote hostnames, URL paths, or recognizable header/query keys/values.
- For analytics events: use FULL query parameter VALUES and postData when available to extract actual event names.
- For GA4 specifically: Look for parameters like "en" (event_name), "ep" (event_parameters), "_p" (page), "epn" (event parameter name), "epv" (event parameter value).
- Common GA4 event patterns: "en=click", "en=page_view", "en=scroll", "en=form_submit", "en=button_click", "en=link_click", "en=scroll_milestone", etc.
- CRITICAL: GA4 often batches multiple events in a single POST body, separated by spaces or newlines. Each event starts with "en=" (event name).
  Example: "en=scroll_milestone&ep.percent_scrolled=25% en=scroll_milestone&ep.percent_scrolled=50% en=click&ep.button_id=submit"
  You MUST extract EACH event separately from batched POST data. Split on spaces/newlines and parse each event individually.
- For batched events: Parse each "en=..." segment as a separate event, even if they're in the same POST request.
- Look for scroll-related parameters (scroll, scroll_depth, scroll_percentage, scroll_pct, etc.) to identify scroll events.
- Look for form-related parameters (form_id, form_name, email, form_submit, etc.) to identify form submission events.
- Look for search-related parameters (q, query, search_term, search_query, etc.) to identify search events.
- Look for click/interaction parameters (click, button_click, link_click, cta_click, interaction, element_click, etc.).
- Extract event names from POST body data when present (often JSON or form-encoded) - GA4 often sends events in POST bodies.
- GA4 BATCHED EVENTS: GA4 frequently sends multiple events in a single POST body, separated by spaces.
  Format: "en=event1&params... en=event2&params... en=event3&params..."
  You MUST split the POST body on spaces/newlines and extract EACH event separately.
  Example: "en=scroll_milestone&ep.percent_scrolled=25% en=scroll_milestone&ep.percent_scrolled=50%"
  Should produce 2 separate events: scroll_milestone (25%) and scroll_milestone (50%).
- Match requests with their responses when requestId matches to get complete picture.
- Be EXHAUSTIVE: list EVERY distinct event you find, even if similar. If you see 10 different button clicks, list all 10.
- For GA4: Each request to /g/collect or /collect may contain multiple batched events - extract ALL of them as separate events.
- Event parameters: Extract event parameters (ep.*) like ep.percent_scrolled, ep.button_id, ep.link_url, etc. and include in notes.
- Include the page_url and request_url for each event to show where it was captured.
- It is OK to leave event_name or URLs null when not available, but be thorough in extracting event names from available data.
- IMPORTANT: Don't group similar events - list each unique event separately with its specific parameters.
- Return ONLY a single JSON object, no prose before or after.
`.trim();

  const body = {
    contents: [
      {
        parts: [
          { text: systemPrompt },
          { text: "\\n\\nSlim network payload JSON:\\n" + JSON.stringify(networkPayload, null, 2) }
        ]
      }
    ]
  };

  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error("Gemini API error: " + text);
  }

  const data = await res.json();
  const cand = data.candidates && data.candidates[0];
  if (!cand || !cand.content || !cand.content.parts) {
    throw new Error("No content returned from Gemini.");
  }

  const text = cand.content.parts.map((p) => p.text || "").join("");
  
  // Strip markdown code blocks if present (Gemini sometimes wraps JSON in ```json ... ```)
  let cleanedText = text.trim();
  if (cleanedText.startsWith("```")) {
    // Remove opening ```json or ```
    cleanedText = cleanedText.replace(/^```(?:json)?\s*\n?/, "");
    // Remove closing ```
    cleanedText = cleanedText.replace(/\n?```\s*$/, "");
    cleanedText = cleanedText.trim();
  }
  
  let parsed;
  try {
    parsed = JSON.parse(cleanedText);
  } catch (e) {
    throw new Error("Failed to parse Gemini JSON: " + cleanedText.slice(0, 200));
  }
  return parsed;
}
