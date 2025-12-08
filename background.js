// RAG module no longer needed - using direct batch processing instead
// importScripts('rag.js');

let maxDepth = 2; // Default depth, can be overridden by user input
let pageLimit = null; // Optional max pages to visit per crawl

let logs = {};
let queue = [];
let visited = new Set();
let allDiscoveredLinks = new Set(); // Index of all discovered links before visiting
let crawlActive = false;
let activeTabId = null;
let origin = null;
let currentTask = null;
let currentSessionId = null;
let pageTimeout = null; // Timeout for page loading
const PAGE_LOAD_TIMEOUT = 15000; // 15 seconds max per page
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// IndexedDB for network calls persistence and AI results
let networkCallsDB = null;
const NETWORK_CALLS_DB_NAME = 'CAST_NetworkCalls_DB';
const NETWORK_CALLS_DB_VERSION = 3; // Increment version to add new tables

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

// Helper to clear entire database
async function clearEntireDatabase() {
  if (!networkCallsDB) {
    try {
      await initNetworkCallsDB();
    } catch (e) {
      // If we can't open it, maybe it doesn't exist or is locked
      return;
    }
  }
  
  const stores = ['networkCalls', 'techStackResults', 'analyticsEventsResults'];
  const clearPromises = stores.map(storeName => {
    return new Promise((resolve, reject) => {
      if (!networkCallsDB.objectStoreNames.contains(storeName)) {
        resolve();
        return;
      }
      const transaction = networkCallsDB.transaction([storeName], 'readwrite');
      const store = transaction.objectStore(storeName);
      const request = store.clear();
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  });
  
  try {
    await Promise.all(clearPromises);
    console.log('CAST: All IndexedDB data cleared on startup.');
  } catch (error) {
    console.error('CAST: Error clearing database on startup:', error);
  }
}

// Open side panel on action click
chrome.action.onClicked.addListener((tab) => {
  // Open side panel for the current window
  chrome.sidePanel.open({ windowId: tab.windowId });
});

// Clear data on browser startup (session-only persistence)
chrome.runtime.onStartup.addListener(() => {
  console.log('CAST: Browser started, clearing previous session data...');
  clearEntireDatabase();
  chrome.storage.local.remove(['CAST_currentSessionId', 'CAST_crawlActive', 'CAST_crawlStatus']);
});

// Initialize IndexedDB for network calls storage
async function initNetworkCallsDB() {
  if (networkCallsDB) return networkCallsDB;
  
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(NETWORK_CALLS_DB_NAME, NETWORK_CALLS_DB_VERSION);
    
    request.onerror = () => {
      console.error('Failed to open network calls IndexedDB:', request.error);
      reject(request.error);
    };
    
    request.onsuccess = () => {
      networkCallsDB = request.result;
      resolve(networkCallsDB);
    };
    
    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      const oldVersion = event.oldVersion || 0;
      
      // Create object store for network calls
      if (!db.objectStoreNames.contains('networkCalls')) {
        const store = db.createObjectStore('networkCalls', { keyPath: 'id', autoIncrement: true });
        store.createIndex('sessionId', 'sessionId', { unique: false });
        store.createIndex('pageUrl', 'pageUrl', { unique: false });
        store.createIndex('timestamp', 'timestamp', { unique: false });
      }
      
      // Create result tables (version 2+)
      if (oldVersion < 2) {
        // Tech Stack Results table
        if (!db.objectStoreNames.contains('techStackResults')) {
          const techStore = db.createObjectStore('techStackResults', { keyPath: 'id', autoIncrement: true });
          techStore.createIndex('sessionId', 'sessionId', { unique: false });
          techStore.createIndex('batchId', 'batchId', { unique: false });
          techStore.createIndex('timestamp', 'timestamp', { unique: false });
        }
        
        // Analytics Events Results table
        if (!db.objectStoreNames.contains('analyticsEventsResults')) {
          const analyticsStore = db.createObjectStore('analyticsEventsResults', { keyPath: 'id', autoIncrement: true });
          analyticsStore.createIndex('sessionId', 'sessionId', { unique: false });
          analyticsStore.createIndex('batchId', 'batchId', { unique: false });
          analyticsStore.createIndex('timestamp', 'timestamp', { unique: false });
        }
      }

      // Create Unique URLs table (version 3+)
      if (oldVersion < 3) {
        if (!db.objectStoreNames.contains('uniqueUrls')) {
          const urlStore = db.createObjectStore('uniqueUrls', { keyPath: 'id', autoIncrement: true });
          urlStore.createIndex('sessionId', 'sessionId', { unique: false });
          urlStore.createIndex('sessionUrl', ['sessionId', 'url'], { unique: true });
          urlStore.createIndex('timestamp', 'timestamp', { unique: false });
        }
      }
    };
  });
}

// Save a network call to IndexedDB incrementally
async function saveNetworkCallToDB(sessionId, pageUrl, event) {
  if (!currentSessionId || !sessionId) return; // No active session
  
  try {
    if (!networkCallsDB) {
      await initNetworkCallsDB();
    }
    
    if (event.method !== "Network.requestWillBeSent") return;
    
    const req = event.params?.request;
    if (!req || !req.url) return;
    
    let urlObj;
    try {
      urlObj = new URL(req.url);
    } catch (e) {
      return; // Invalid URL, skip
    }
    
    const networkCall = {
      sessionId,
      pageUrl,
      url: req.url,
      method: req.method || "GET",
      host: urlObj.host,
      pathname: urlObj.pathname,
      queryParams: Object.fromEntries(urlObj.searchParams.entries()),
      headerValues: req.headers || {},
      postData: req.postData || null,
      requestId: event.params?.requestId || null,
      timestamp: Date.now()
    };
    
    const transaction = networkCallsDB.transaction(['networkCalls'], 'readwrite');
    const store = transaction.objectStore('networkCalls');
    await store.add(networkCall);
    
  } catch (error) {
    // Handle quota exceeded or other errors gracefully
    if (error.name === 'QuotaExceededError') {
      console.warn('IndexedDB quota exceeded, falling back to memory storage');
    } else {
      console.error('Error saving network call to IndexedDB:', error);
    }
    // Continue with memory storage as fallback
  }
}

// Retrieve network calls from IndexedDB by session ID
async function getNetworkCallsFromDB(sessionId) {
  if (!sessionId) return { flat: [], byPage: {} };
  
  try {
    if (!networkCallsDB) {
      await initNetworkCallsDB();
    }
    
    return new Promise((resolve, reject) => {
      const transaction = networkCallsDB.transaction(['networkCalls'], 'readonly');
      const store = transaction.objectStore('networkCalls');
      const index = store.index('sessionId');
      const request = index.getAll(sessionId);
      
      request.onsuccess = () => {
        const calls = request.result;
        const flat = [];
        const byPage = {};
        
        for (const call of calls) {
          flat.push({
            pageUrl: call.pageUrl,
            url: call.url,
            method: call.method,
            host: call.host,
            pathname: call.pathname,
            queryParams: call.queryParams || {},
            headerValues: call.headerValues || {},
            postData: call.postData || null,
            requestId: call.requestId
          });
          
          if (!byPage[call.pageUrl]) {
            byPage[call.pageUrl] = [];
          }
          byPage[call.pageUrl].push({
            pageUrl: call.pageUrl,
            url: call.url,
            method: call.method,
            host: call.host,
            pathname: call.pathname,
            queryParams: call.queryParams || {},
            headerValues: call.headerValues || {},
            postData: call.postData || null,
            requestId: call.requestId
          });
        }
        
        resolve({ flat, byPage });
      };
      
      request.onerror = () => {
        console.error('Error retrieving network calls from IndexedDB:', request.error);
        reject(request.error);
      };
    });
  } catch (error) {
    console.error('Error accessing IndexedDB:', error);
    return { flat: [], byPage: {} };
  }
}

// Clear network calls for a session
async function clearNetworkCallsForSession(sessionId) {
  if (!sessionId || !networkCallsDB) return;
  
  try {
    return new Promise((resolve, reject) => {
      const transaction = networkCallsDB.transaction(['networkCalls'], 'readwrite');
      const store = transaction.objectStore('networkCalls');
      const index = store.index('sessionId');
      const request = index.getAll(sessionId);
      
      request.onsuccess = () => {
        const records = request.result;
        const deletePromises = records.map(record => {
          return new Promise((res, rej) => {
            const delReq = store.delete(record.id);
            delReq.onsuccess = () => res();
            delReq.onerror = () => rej(delReq.error);
          });
        });
        
        Promise.all(deletePromises).then(resolve).catch(reject);
      };
      
      request.onerror = () => reject(request.error);
    });
  } catch (error) {
    console.error('Error clearing network calls:', error);
  }
}

async function countStoreEntries(storeName, sessionId) {
  if (!networkCallsDB) await initNetworkCallsDB();
  if (!networkCallsDB.objectStoreNames.contains(storeName)) return 0;
  
  return new Promise((resolve, reject) => {
    const transaction = networkCallsDB.transaction([storeName], 'readonly');
    const store = transaction.objectStore(storeName);
    if (sessionId && store.indexNames && store.indexNames.contains && store.indexNames.contains('sessionId')) {
      const index = store.index('sessionId');
      const request = index.count(sessionId);
      request.onsuccess = () => resolve(request.result || 0);
      request.onerror = () => reject(request.error);
      return;
    }
    const request = store.count();
    request.onsuccess = () => resolve(request.result || 0);
    request.onerror = () => reject(request.error);
  });
}

async function fetchStoreRecords(storeName, sessionId) {
  if (!networkCallsDB) await initNetworkCallsDB();
  if (!networkCallsDB.objectStoreNames.contains(storeName)) return [];
  
  return new Promise((resolve, reject) => {
    const transaction = networkCallsDB.transaction([storeName], 'readonly');
    const store = transaction.objectStore(storeName);
    let request;
    if (sessionId && store.indexNames && store.indexNames.contains && store.indexNames.contains('sessionId')) {
      const index = store.index('sessionId');
      request = index.getAll(sessionId);
    } else {
      request = store.getAll();
    }
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  });
}

async function clearStoreEntriesForSession(storeName, sessionId) {
  if (!networkCallsDB) await initNetworkCallsDB();
  if (!networkCallsDB.objectStoreNames.contains(storeName)) return;
  if (!sessionId) return;

  await new Promise((resolve, reject) => {
    const transaction = networkCallsDB.transaction([storeName], 'readwrite');
    const store = transaction.objectStore(storeName);
    const index = store.index('sessionId');
    const range = IDBKeyRange.only(sessionId);
    const request = index.openCursor(range);
    request.onsuccess = (event) => {
      const cursor = event.target.result;
      if (cursor) {
        cursor.delete();
        cursor.continue();
      } else {
        resolve();
      }
    };
    request.onerror = () => reject(request.error);
  });
}

// Save a unique URL for the session (deduped by session + url)
async function saveUniqueUrlToDB(sessionId, url, source = 'discovered') {
  if (!sessionId || !url) return;
  try {
    if (!networkCallsDB) {
      await initNetworkCallsDB();
    }
    if (!networkCallsDB.objectStoreNames.contains('uniqueUrls')) return;

    const transaction = networkCallsDB.transaction(['uniqueUrls'], 'readwrite');
    const store = transaction.objectStore('uniqueUrls');
    const record = {
      sessionId,
      url,
      source,
      timestamp: Date.now()
    };
    const request = store.add(record);
    request.onerror = (event) => {
      // Ignore duplicate errors
      if (event?.target?.error?.name !== 'ConstraintError') {
        console.warn('CAST: uniqueUrls add error:', event?.target?.error);
      }
    };
  } catch (error) {
    console.warn('CAST: Failed to save unique URL:', error);
  }
}

async function addEntriesToStore(storeName, entries) {
  if (!networkCallsDB) await initNetworkCallsDB();
  if (!networkCallsDB.objectStoreNames.contains(storeName)) return;
  if (!entries || entries.length === 0) return;

  const transaction = networkCallsDB.transaction([storeName], 'readwrite');
  const store = transaction.objectStore(storeName);

  await Promise.all(entries.map(entry => new Promise((resolve, reject) => {
    const request = store.add(entry);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  })));
}

async function getDatabaseStats(sessionId) {
  try {
    await initNetworkCallsDB();
    const [networkCount, techCount, analyticsCount, uniqueUrlCount] = await Promise.all([
      countStoreEntries('networkCalls', sessionId),
      countStoreEntries('techStackResults', sessionId),
      countStoreEntries('analyticsEventsResults', sessionId),
      countStoreEntries('uniqueUrls', sessionId)
    ]);
    return { networkCount, techCount, analyticsCount, uniqueUrlCount };
  } catch (error) {
    console.error('Error fetching DB stats:', error);
    throw error;
  }
}

async function getActiveSessionId() {
  return new Promise((resolve) => {
    chrome.storage.local.get(["CAST_currentSessionId"], (res) => {
      resolve(res?.CAST_currentSessionId || null);
    });
  });
}

async function ensureCurrentSessionId() {
  if (currentSessionId) return currentSessionId;
  currentSessionId = await getActiveSessionId();
  return currentSessionId;
}

function dedupeTechRecords(records = []) {
  const map = new Map();
  for (const item of records) {
    const key = `${(item.name || '').toLowerCase()}|${(item.category || '').toLowerCase()}`;
    
    // Robust evidence handling: ensure it's an iterable of strings
    let evidenceItems = [];
    if (Array.isArray(item.evidence)) {
      evidenceItems = item.evidence;
    } else if (typeof item.evidence === 'string') {
      evidenceItems = item.evidence.split(' | ');
    }
    
    if (!map.has(key)) {
      map.set(key, {
        name: item.name || '',
        category: item.category || '',
        confidence: Number(item.confidence) || 0,
        evidence: new Set(evidenceItems.filter(Boolean)),
        occurrences: 1
      });
    } else {
      const existing = map.get(key);
      existing.confidence = Math.max(existing.confidence, Number(item.confidence) || 0);
      evidenceItems.filter(Boolean).forEach((ev) => existing.evidence.add(ev));
      existing.occurrences += 1;
    }
  }
  return Array.from(map.values()).map((entry) => ({
    name: entry.name,
    category: entry.category,
    confidence: entry.confidence.toFixed(2),
    occurrences: entry.occurrences,
    evidence: Array.from(entry.evidence).join(' | ')
  }));
}

function dedupeAnalyticsRecords(records = []) {
  const map = new Map();
  for (const item of records) {
    const key = [
      (item.provider || '').toLowerCase(),
      (item.event_name || '').toLowerCase(),
      (item.page_url || '').toLowerCase(),
      (item.request_url || '').toLowerCase(),
      (item.notes || '').toLowerCase()
    ].join('|');
    if (!map.has(key)) {
      map.set(key, {
        provider: item.provider || '',
        event_name: item.event_name || '',
        page_url: item.page_url || '',
        request_url: item.request_url || '',
        notes: item.notes || '',
        occurrences: 1
      });
    } else {
      const existing = map.get(key);
      existing.occurrences += 1;
    }
  }
  return Array.from(map.values());
}

async function buildTechStackExport(sessionId) {
  const records = await fetchStoreRecords('techStackResults', sessionId);
  if (!records.length) return [];
  const deduped = dedupeTechRecords(records);
  const rows = [["Technology", "Category", "Top Confidence", "Occurrences", "Evidence"]];
  deduped.sort((a, b) => Number(b.confidence) - Number(a.confidence));
  deduped.forEach((entry) => {
    rows.push([entry.name, entry.category, entry.confidence, String(entry.occurrences), entry.evidence]);
  });
  return rows;
}

async function buildAnalyticsExport(sessionId) {
  const records = await fetchStoreRecords('analyticsEventsResults', sessionId);
  if (!records.length) return [];
  const deduped = dedupeAnalyticsRecords(records);
  const rows = [["Provider", "Event Name", "Page URL", "Request URL", "Notes", "Occurrences"]];
  deduped.sort((a, b) => b.occurrences - a.occurrences || a.provider.localeCompare(b.provider));
  deduped.forEach((entry) => {
    rows.push([
      entry.provider,
      entry.event_name,
      entry.page_url,
      entry.request_url,
      entry.notes,
      String(entry.occurrences)
    ]);
  });
  return rows;
}

async function consolidateStoredResults(sessionId) {
  try {
    const [techRecords, analyticsRecords] = await Promise.all([
      fetchStoreRecords('techStackResults', sessionId),
      fetchStoreRecords('analyticsEventsResults', sessionId)
    ]);

    const dedupedTech = dedupeTechRecords(techRecords);
    const dedupedAnalytics = dedupeAnalyticsRecords(analyticsRecords);

    if (!networkCallsDB) await initNetworkCallsDB();

    await clearStoreEntriesForSession('techStackResults', sessionId);
    await clearStoreEntriesForSession('analyticsEventsResults', sessionId);

    const techTimestamp = Date.now();
    const techEntries = dedupedTech.map(item => ({
      sessionId,
      batchId: 'consolidated',
      name: item.name,
      category: item.category,
      confidence: Number(item.confidence),
      evidence: item.evidence ? item.evidence.split(' | ').filter(Boolean) : [],
      occurrences: item.occurrences,
      timestamp: techTimestamp
    }));
    await addEntriesToStore('techStackResults', techEntries);

    const analyticsTimestamp = Date.now();
    const analyticsEntries = dedupedAnalytics.map(item => ({
      sessionId,
      batchId: 'consolidated',
      provider: item.provider,
      event_name: item.event_name,
      page_url: item.page_url,
      request_url: item.request_url,
      notes: item.notes,
      occurrences: item.occurrences,
      timestamp: analyticsTimestamp
    }));
    await addEntriesToStore('analyticsEventsResults', analyticsEntries);
  } catch (error) {
    console.error('Error consolidating stored results:', error);
  }
}

// Store AI analysis results in IndexedDB
async function storeAIResults(sessionId, batchId, techStack, analyticsEvents) {
  if (!networkCallsDB) await initNetworkCallsDB();
  
  const timestamp = Date.now();
  
  // Store tech stack results (batch insert for efficiency)
  if (techStack && techStack.length > 0) {
    const techTransaction = networkCallsDB.transaction(['techStackResults'], 'readwrite');
    const techStore = techTransaction.objectStore('techStackResults');
    
    const techPromises = techStack.map(item => {
      return new Promise((resolve, reject) => {
        const request = techStore.add({
          sessionId,
          batchId,
          name: item.name || '',
          category: item.category || '',
          confidence: item.confidence || 0,
          evidence: item.evidence || [],
          timestamp
        });
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
      });
    });
    
    await Promise.all(techPromises);
  }
  
  // Store analytics events results (batch insert for efficiency)
  if (analyticsEvents && analyticsEvents.length > 0) {
    const analyticsTransaction = networkCallsDB.transaction(['analyticsEventsResults'], 'readwrite');
    const analyticsStore = analyticsTransaction.objectStore('analyticsEventsResults');
    
    const analyticsPromises = analyticsEvents.map(item => {
      return new Promise((resolve, reject) => {
        const request = analyticsStore.add({
          sessionId,
          batchId,
          provider: item.provider || '',
          event_name: item.event_name || null,
          page_url: item.page_url || null,
          request_url: item.request_url || null,
          notes: item.notes || null,
          timestamp
        });
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
      });
    });
    
    await Promise.all(analyticsPromises);
  }
}

// Build network payload for a batch of calls (optimized for Gemini)
function buildBatchPayload(networkCalls, maxTokens = 700000) {
  const pages = [];
  const pageMap = new Map();
  const MAX_POST_BODY_SIZE = 8000;
  const MAX_ANALYTICS_POST_BODY_SIZE = 20000;
  const analyticsPattern = /(google-analytics|analytics\.google|googletagmanager|gtag|gtm|segment|mixpanel|amplitude|hotjar|clarity|hubspot)/i;
  
  let estimatedTokens = 0;
  const baseOverhead = 2000; // System prompt overhead
  const summary = {
    totalCalls: 0,
    analyticsCalls: 0,
    otherCalls: 0
  };
  
  for (const call of networkCalls) {
    let callSize = 0;
    callSize += (call.url || '').length;
    callSize += (call.method || '').length;
    callSize += JSON.stringify(call.queryParams || {}).length;
    
    // Truncate POST data if needed
    let postData = call.postData;
    const isAnalytics = analyticsPattern.test(call.host || '');
    const maxPostSize = isAnalytics ? MAX_ANALYTICS_POST_BODY_SIZE : MAX_POST_BODY_SIZE;
    
    if (postData && typeof postData === 'string' && postData.length > maxPostSize) {
      postData = postData.slice(0, maxPostSize) + '...[truncated]';
    } else if (postData && typeof postData !== 'string') {
      const stringified = JSON.stringify(postData);
      if (stringified.length > maxPostSize) {
        postData = stringified.slice(0, maxPostSize) + '...[truncated]';
      } else {
        postData = stringified;
      }
    }
    callSize += (postData || '').length;
    
    const callTokens = Math.ceil(callSize / 4);
    
    if (estimatedTokens + callTokens + baseOverhead > maxTokens && pages.length > 0) {
      break;
    }
    
    const pageUrl = call.pageUrl || 'unknown';
    if (!pageMap.has(pageUrl)) {
      pageMap.set(pageUrl, {
        pageUrl,
        requests: []
      });
    }
    
    const page = pageMap.get(pageUrl);
    page.requests.push({
      url: call.url,
      method: call.method || 'GET',
      host: call.host,
      pathname: call.pathname,
      queryParams: call.queryParams || {},
      postData: postData || null
    });
    
    estimatedTokens += callTokens;
    summary.totalCalls++;
    if (isAnalytics) {
      summary.analyticsCalls++;
    } else {
      summary.otherCalls++;
    }
  }
  
  const pagesArray = Array.from(pageMap.values());
  const payload = { pages: pagesArray, summary };
  payload.summary.totalCalls = pagesArray.reduce((acc, page) => acc + page.requests.length, 0);
  return { ...payload, estimatedTokens };
}

function estimateTokensForPayload(payload) {
  return Math.ceil(JSON.stringify(payload).length / 4);
}

function updatePayloadSummary(payload) {
  const summary = {
    totalCalls: 0,
    analyticsCalls: 0,
    otherCalls: 0
  };
  const analyticsPattern = /(google-analytics|analytics\.google|googletagmanager|gtag|gtm|segment|mixpanel|amplitude|hotjar|clarity|hubspot)/i;
  for (const page of payload.pages || []) {
    for (const request of page.requests || []) {
      summary.totalCalls++;
      if (analyticsPattern.test(request.host || '')) {
        summary.analyticsCalls++;
      } else {
        summary.otherCalls++;
      }
    }
  }
  payload.summary = summary;
}

function trimPayloadToLimit(payload, maxTokens) {
  let pages = [...payload.pages];
  if (pages.length === 0) return payload;
  
  let trimmedPayload = { ...payload, pages };
  let tokens = estimateTokensForPayload(trimmedPayload);
  if (tokens <= maxTokens) return trimmedPayload;
  
  // Remove pages from the end until within limit
  while (pages.length > 1 && tokens > maxTokens) {
    pages.pop();
    trimmedPayload = { ...payload, pages };
    tokens = estimateTokensForPayload(trimmedPayload);
  }
  
  // If still too large, trim requests within the last page
  if (tokens > maxTokens && pages.length === 1) {
    const page = { ...pages[0] };
    while (page.requests.length > 1 && tokens > maxTokens) {
      page.requests.pop();
      trimmedPayload = { ...payload, pages: [page] };
      tokens = estimateTokensForPayload(trimmedPayload);
    }
    trimmedPayload = { ...payload, pages: [page] };
  }
  
  updatePayloadSummary(trimmedPayload);
  return trimmedPayload;
}

// Use Offscreen API or simplified keep-alive interval to prevent SW termination
// In MV3, Offscreen API is the official way, but for now we can use a "pinger" via the content script
// or just rely on the open messaging channel.

// Simple self-ping to keep alive during analysis
let keepAliveInterval;
let aiCancelRequested = false;
function startKeepAlive() {
  if (keepAliveInterval) clearInterval(keepAliveInterval);
  keepAliveInterval = setInterval(() => {
    // Reading storage is a simple async op that resets the idle timer
    chrome.storage.local.get(['CAST_keepAlive'], () => {});
  }, 20000); // Ping every 20s (timeout is usually 30s)
}

function stopKeepAlive() {
  if (keepAliveInterval) {
    clearInterval(keepAliveInterval);
    keepAliveInterval = null;
  }
}

// Process network calls in batches and store results
async function processBatchesDirect(apiKey, networkCalls, sessionId, progressCallback) {
  startKeepAlive();
  if (!networkCallsDB) await initNetworkCallsDB();
  
  const batches = []; // Move variable outside try block
  let processedBatches = 0;
  
  try {
    const MAX_TOKENS_PER_BATCH = 100000; // Drastically reduced limit (100k) to prevent 1M limit error
    let currentBatch = [];
    let currentBatchTokens = 0;
    const baseOverhead = 2000; // System prompt overhead
  
  // Split network calls into batches based on token estimation
  for (const call of networkCalls) {
    // Estimate tokens for this call (more accurate)
    let callSize = 0;
    callSize += (call.url || '').length;
    callSize += (call.method || '').length;
    callSize += JSON.stringify(call.queryParams || {}).length;
    callSize += (call.postData ? (typeof call.postData === 'string' ? call.postData : JSON.stringify(call.postData)) : '').length;
    const callTokens = Math.ceil(callSize / 4);
    
    // Check if adding this call would exceed limit
    if (currentBatchTokens + callTokens + baseOverhead > MAX_TOKENS_PER_BATCH && currentBatch.length > 0) {
      // Save current batch and start new one
      batches.push([...currentBatch]);
      currentBatch = [call];
      currentBatchTokens = callTokens;
    } else {
      currentBatch.push(call);
      currentBatchTokens += callTokens;
    }
  }
  
  // Add final batch
  if (currentBatch.length > 0) {
    batches.push(currentBatch);
  }
  
  console.log(`CAST: Split ${networkCalls.length} calls into ${batches.length} batches`);
  
  // Process each batch
  for (let i = 0; i < batches.length; i++) {
    if (aiCancelRequested) {
      console.warn('CAST: AI analysis cancelled before batch', i + 1);
      break;
    }
    const batch = batches[i];
    const batchId = `batch_${i + 1}_${Date.now()}`; // Unique ID for this run
    
    // Skip if we think we've already processed this specific batch logic? 
    // No, simple batch ID generation based on time means we always process.
    // The user wants to see it run through the data.
    
    try {
      // Build payload for this batch
      let payload = buildBatchPayload(batch, MAX_TOKENS_PER_BATCH);
      let payloadTokens = payload.estimatedTokens || estimateTokensForPayload(payload);
      
      if (payload.pages.length === 0) {
        console.warn(`CAST: Batch ${i + 1} has no pages, skipping`);
        continue;
      }
      
      // Trim if exceeds limit (redundant but safe)
      if (payloadTokens > MAX_TOKENS_PER_BATCH) {
        console.warn(`CAST: Batch ${i + 1} payload exceeds token limit (${payloadTokens}), trimming...`);
        payload = trimPayloadToLimit(payload, MAX_TOKENS_PER_BATCH);
        payloadTokens = estimateTokensForPayload(payload);
      }
      
      // HARD CHECK: Ensure payload is under 1M tokens (approx 4M characters) no matter what
      // Gemini 1.5 Pro limit is ~1M tokens. 1 token ~= 4 chars.
      // 4MB limit is safe.
      const payloadStr = JSON.stringify(payload);
      if (payloadStr.length > 3500000) { // ~875k tokens, safe buffer
         console.warn(`CAST: Batch ${i + 1} payload is dangerously large (${payloadStr.length} chars). Trimming aggressively.`);
         payload = trimPayloadToLimit(payload, 200000); // Trim to very small size (50k tokens approx)
      }

      // Call Gemini
      const result = await callGemini(apiKey, payload);
      
      // Store results
      if (result.tech_stack && result.analytics_events) {
        await storeAIResults(sessionId, batchId, result.tech_stack, result.analytics_events);
        console.log(`CAST: Batch ${i + 1}/${batches.length} processed - ${result.tech_stack.length} tech items, ${result.analytics_events.length} analytics events`);
        
        if (progressCallback) {
          progressCallback({
            processed: i + 1,
            total: batches.length,
            percentage: Math.round(((i + 1) / batches.length) * 100),
            current: `Completed batch ${i + 1}/${batches.length}`,
            stage: 'AI Analysis'
          });
        }
      } else {
        console.warn(`CAST: Batch ${i + 1} returned no results`);
      }
      processedBatches = i + 1;
    } catch (error) {
      console.error(`CAST: Error processing batch ${i + 1}:`, error);
      // Continue with next batch
    }
  }
  
  if (progressCallback) {
    progressCallback({
      processed: batches.length,
      total: batches.length,
      percentage: 100,
      current: 'AI analysis complete',
      stage: 'AI Analysis'
    });
  }
  
  } finally {
    stopKeepAlive();
  }
  
  return { batchesProcessed: processedBatches, totalCalls: networkCalls.length, cancelled: aiCancelRequested };
}

// Get all stored results for a session
async function getAllStoredResults(sessionId) {
  if (!networkCallsDB) await initNetworkCallsDB();
  
  // Get tech stack results
  const techResults = await new Promise((resolve, reject) => {
    const transaction = networkCallsDB.transaction(['techStackResults'], 'readonly');
    const store = transaction.objectStore('techStackResults');
    const index = store.index('sessionId');
    const request = index.getAll(sessionId);
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  });
  
  // Get analytics events results
  const analyticsResults = await new Promise((resolve, reject) => {
    const transaction = networkCallsDB.transaction(['analyticsEventsResults'], 'readonly');
    const store = transaction.objectStore('analyticsEventsResults');
    const index = store.index('sessionId');
    const request = index.getAll(sessionId);
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  });
  
  return { techStack: techResults, analyticsEvents: analyticsResults };
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

// Manual mode state
let manualModeActive = false;

async function startManualMode() {
  chrome.tabs.query({ active: true, lastFocusedWindow: true }, async ([tab]) => {
    if (!tab || !tab.url || !tab.url.startsWith("http")) {
      notifyPopupStatus("Please navigate to a valid web page first.");
      return;
    }

    const u = new URL(tab.url);
    origin = u.origin;
    activeTabId = tab.id;
    manualModeActive = true;
    
    // Ensure logs exist for this page
    logs = logs || {};
    const normalizedUrl = normalizeUrl(u.href);
    visited = visited || new Set();
    visited.add(normalizedUrl);

    // Initialize IndexedDB/Session similar to auto-crawl
    try {
      await initNetworkCallsDB();
    } catch (error) {
      console.warn('Failed to initialize IndexedDB:', error);
    }
    
    // Restore or create session ID
    chrome.storage.local.get(['CAST_currentSessionId'], async (res) => {
      if (!currentSessionId) {
        currentSessionId = res.CAST_currentSessionId || `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        chrome.storage.local.set({ CAST_currentSessionId: currentSessionId });
      }
      
      notifyPopupStatus("Manual Mode Active. Navigate and interact freely. Traffic is being recorded.");
      
      chrome.debugger.attach({ tabId: tab.id }, "1.3", (error) => {
        if (error) {
          console.error('Failed to attach debugger:', error);
          manualModeActive = false;
          notifyPopupStatus("Failed to attach debugger. Please reload the extension.");
          return;
        }
        chrome.debugger.sendCommand({ tabId: tab.id }, "Network.enable", {
          maxResourceBufferSize: 10000000, 
          maxPostDataSize: 10000000
        });
        
        // Inject content script to capture clicks/DOM even in manual mode
        chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ['content/crawler.js']
        }).catch(err => console.log('Content script note:', err.message));
      });
    });
  });
}

function stopManualMode() {
  manualModeActive = false;
  if (activeTabId) {
    chrome.debugger.detach({ tabId: activeTabId }, () => {
      if (chrome.runtime.lastError) {
        console.warn('Debugger detach warning:', chrome.runtime.lastError.message);
      }
    });
  }
  notifyPopupStatus("Manual Mode Stopped. Traffic recorded.");
}

// Keep-alive connection handling
chrome.runtime.onConnect.addListener((port) => {
  if (port.name === "cast-popup-connection") {
    console.log("CAST: Popup connected, keeping service worker alive");
    port.onDisconnect.addListener(() => {
      console.log("CAST: Popup disconnected");
    });
  }
});

// Generate analytics strategy recommendation
async function generateAnalyticsStrategy(apiKey, domData) {
  const endpoint =
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=" +
    encodeURIComponent(apiKey);

  const systemPrompt = `
You are an expert in digital analytics, product strategy, user experience, and data architecture.

Your job is to generate a complete analytics recommendation for a modern website or product, focusing ONLY on the "Recommend Strategy" output. Keep the JSON output schema the same:
{
  "recommendations": [
    {
      "selector": "string (unique CSS selector)",
      "eventName": "string (snake_case, GA4-friendly)",
      "category": "string (e.g., Navigation, Conversion, User Journey, Engagement, E-commerce, Lead Generation, Content, Utility)",
      "reasoning": "string (why this matters in the journey; note if auto-collected by GA4 Enhanced Measurement)",
      "priority": "High" | "Medium" | "Low",
      "codeSnippet": "string (JavaScript dataLayer.push code using the data layer schema below)",
      "triggerType": "string (CSS Selector or Text Match)",
      "triggerValue": "string (selector or text for GTM)",
      "isAutoCollected": boolean
    }
  ]
}

Apply this prompt when generating recommendations:

1) User Experience + Journey Understanding
- Identify core audience types and jobs-to-be-done.
- Map the journey: awareness → exploration → evaluation → conversion → retention.
- Identify friction points and critical interaction moments.

2) Component-Based Product Interaction Model
- Analyze UI components/blocks: navigation (header, mega menu, mobile nav, footer), content blocks (hero, promo, FAQ, grids, carousels), forms and micro-interactions (field interactions, progress, errors), product/service cards, pricing, search/filters/sorting, checkout or lead paths, utility (chat, sticky CTA, account actions).

3) Analytics Naming Conventions
- Event names: snake_case (e.g., navigation_interaction, content_block_impression).
- Parameters: dot.notation namespaces (e.g., navigation.item_label, form.field_name).
- Component names: short, semantic (e.g., hero_banner, product_grid, faq_section).
- Every event must include: page_type, page_path, component_id (when applicable), component_type.

4) Event Taxonomy Design (GA4-ready)
- For each event: event name, description, trigger conditions, parameters (name + type + description), example payload.
- Group events by: Navigation interactions; Content block interactions & impressions; Search; Forms; Conversions; Product engagement; Utility interactions (chat, sticky CTA, account actions).

5) Data Layer Schema (use in codeSnippet)
{
  "event": "",
  "page": { "type": "", "path": "", "language": "" },
  "component": { "id": "", "type": "", "position": "", "metadata": {} },
  "interaction": { "type": "", "value": "", "target": "" }
}
- Include rules for: component impressions (IntersectionObserver), component clicks, form start/field interaction/submit success-failure, nav hierarchy (level 1–3), scroll depth, personalization experiments (variant, algorithm).

6) User Journey KPIs
- KPIs for: navigation discoverability, block engagement, content depth, conversion & form drop-off, product evaluation patterns, retention & repeat engagement.

7) Recommendations
- Provide implementation notes, suggested event consolidation, how to push to GA4 + BigQuery, personalization insights, and dashboard outline (Looker Studio/PowerBI) – embed the most relevant notes into reasoning.

Additional rules to fit our DOM and navigation detection:
- Use navigation metadata when present: navigation.location ('header' | 'footer' | 'dropdown'), navigation.hasDropdown, navigation.parentNav, navigation.dropdownItems.
- Track ALL header and footer navigation links, and ALL dropdown/popup menu items. Parents and children each get their own event.
- Use select_content for navigation with parameters: navigation_location, navigation_parent (if dropdown), item_id or navigation.item_label, link_url.
- For forms: form_start, field interaction, generate_lead/sign_up submit success/failure with form_id, form_name, error/message when relevant.
- For impressions: use IntersectionObserver-driven component impressions (content_block_impression) with component_id/component_type.
- For search: search event with search_term; for filters/sorting: filter_interaction, sort_interaction.
- For e-commerce: view_item_list, select_item, view_item, add_to_cart, begin_checkout, purchase with items array; keep GA4 alignment.
- For auto-collected events (page_view, scroll, file_download, outbound_click, site_search): set isAutoCollected: true and explain when a custom layer is still helpful (e.g., virtual page views, scroll milestones, segmented file types).
- ALWAYS include the core GA4 Enhanced Measurement autos as individual recommendations (one per event, NOT grouped), each marked isAutoCollected: true: page_view, scroll, outbound_click, file_download, site_search, video_start, video_progress, video_complete. Treat them like other events: one per line with its own selector/trigger and reasoning. Make clear these fire when the GA4 base tag is present; include a short codeSnippet showing how to extend/segment if needed (e.g., virtual page views, scroll depth thresholds, file type filtering).

Implementation expectations for codeSnippet:
- Use dataLayer.push with the schema above.
- Include page_type, page_path, component_id, component_type, and relevant parameters per event.
- Use snake_case for event and dot.notation for parameters where helpful (e.g., navigation.item_label, form.field_name).
- Keep payload concise and production-ready.
`.trim();

  const body = {
    contents: [
      {
        parts: [
          { text: systemPrompt },
          { text: "DOM Structure:\n" + JSON.stringify(domData, null, 2) }
        ]
      }
    ]
  };

  try {
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
    let cleanedText = text.trim();
    
    // More robust JSON extraction: find first '{' and last '}'
    const firstBrace = cleanedText.indexOf('{');
    const lastBrace = cleanedText.lastIndexOf('}');
    
    if (firstBrace !== -1 && lastBrace !== -1) {
      cleanedText = cleanedText.substring(firstBrace, lastBrace + 1);
    } else if (cleanedText.startsWith("```")) {
      // Fallback to old logic just in case
      cleanedText = cleanedText.replace(/^```(?:json)?\s*\n?/, "");
      cleanedText = cleanedText.replace(/\n?```\s*$/, "");
      cleanedText = cleanedText.trim();
    }

    return JSON.parse(cleanedText);
  } catch (error) {
    console.error('CAST: Error generating analytics strategy:', error);
    throw error;
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "recommend-strategy") {
    (async () => {
      try {
        // 1. Get API Key
        const { geminiApiKey } = await chrome.storage.local.get("geminiApiKey");
        if (!geminiApiKey) {
          sendResponse({ error: "No API key found. Please configure it first." });
          return;
        }

        // 2. Get DOM from active tab
        const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        if (!tab || !tab.id) {
          sendResponse({ error: "No active tab found." });
          return;
        }

        // Retry mechanism for content script communication
        let domResponse = null;
        let retries = 0;
        while (!domResponse && retries < 3) {
          try {
            domResponse = await chrome.tabs.sendMessage(tab.id, { type: "get-page-structure" });
          } catch (e) {
            console.log(`Content script not ready (attempt ${retries + 1}), injecting...`);
            try {
              await chrome.scripting.executeScript({
                target: { tabId: tab.id },
                files: ['content/crawler.js']
              });
              await sleep(500); // Wait for script to initialize
            } catch (injectError) {
              console.error("Failed to inject content script:", injectError);
            }
          }
          retries++;
        }

        if (!domResponse || !domResponse.dom) {
          sendResponse({ error: "Failed to retrieve page structure. Please refresh the page and try again." });
          return;
        }

        // 3. Call Gemini
        const strategy = await generateAnalyticsStrategy(geminiApiKey, domResponse.dom);
        
        // 4. Return results
        sendResponse({ success: true, strategy });

      } catch (error) {
        console.error("Strategy generation failed:", error);
        sendResponse({ error: error.message });
      }
    })();
    return true; // Async response
  }
  
  if (msg.type === "highlight-element") {
    // Forward to content script
    (async () => {
        const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        if (tab && tab.id) {
            // Use same retry/injection logic for highlighting
            let retries = 0;
            let success = false;
            while (!success && retries < 3) {
                try {
                    await chrome.tabs.sendMessage(tab.id, { 
                        type: "show-highlight", 
                        selector: msg.selector, 
                        label: msg.label 
                    });
                    success = true;
                } catch (e) {
                    try {
                        await chrome.scripting.executeScript({
                            target: { tabId: tab.id },
                            files: ['content/crawler.js']
                        });
                        await sleep(500);
                    } catch (err) {}
                }
                retries++;
            }
        }
    })();
    return false;
  }
  
  if (msg.type === "highlight-all-elements") {
    // Forward to content script to highlight multiple elements
    (async () => {
        const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        if (tab && tab.id) {
            let retries = 0;
            let success = false;
            while (!success && retries < 3) {
                try {
                    await chrome.tabs.sendMessage(tab.id, { 
                        type: "show-highlight-batch", 
                        highlights: msg.highlights 
                    });
                    success = true;
                } catch (e) {
                    try {
                        await chrome.scripting.executeScript({
                            target: { tabId: tab.id },
                            files: ['content/crawler.js']
                        });
                        await sleep(500);
                    } catch (err) {}
                }
                retries++;
            }
        }
    })();
    return false;
  }

  if (msg.type === "recommend-strategy") {
    (async () => {
      try {
        // 1. Get API Key
        const { geminiApiKey } = await chrome.storage.local.get("geminiApiKey");
        if (!geminiApiKey) {
          sendResponse({ error: "No API key found. Please configure it first." });
          return;
        }

        // 2. Get DOM from active tab
        const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        if (!tab || !tab.id) {
          sendResponse({ error: "No active tab found." });
          return;
        }

        // Retry mechanism for content script communication
        let domResponse = null;
        let retries = 0;
        while (!domResponse && retries < 3) {
          try {
            domResponse = await chrome.tabs.sendMessage(tab.id, { type: "get-page-structure" });
          } catch (e) {
            console.log(`Content script not ready (attempt ${retries + 1}), injecting...`);
            try {
              await chrome.scripting.executeScript({
                target: { tabId: tab.id },
                files: ['content/crawler.js']
              });
              await sleep(500); // Wait for script to initialize
            } catch (injectError) {
              console.error("Failed to inject content script:", injectError);
            }
          }
          retries++;
        }

        if (!domResponse || !domResponse.dom) {
          sendResponse({ error: "Failed to retrieve page structure. Please refresh the page and try again." });
          return;
        }

        // 3. Call Gemini
        const strategy = await generateAnalyticsStrategy(geminiApiKey, domResponse.dom);
        
        // 4. Return results
        sendResponse({ success: true, strategy });

      } catch (error) {
        console.error("Strategy generation failed:", error);
        sendResponse({ error: error.message });
      }
    })();
    return true; // Async response
  }
  
  if (msg.type === "highlight-element") {
    // Forward to content script
    (async () => {
        const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        if (tab && tab.id) {
            // Use same retry/injection logic for highlighting
            let retries = 0;
            let success = false;
            while (!success && retries < 3) {
                try {
                    await chrome.tabs.sendMessage(tab.id, { 
                        type: "show-highlight", 
                        selector: msg.selector, 
                        label: msg.label 
                    });
                    success = true;
                } catch (e) {
                    try {
                        await chrome.scripting.executeScript({
                            target: { tabId: tab.id },
                            files: ['content/crawler.js']
                        });
                        await sleep(500);
                    } catch (err) {}
                }
                retries++;
            }
        }
    })();
    return false;
  }

  if (msg.type === "crawl-start") {
    // Use provided depth or default to 2
    maxDepth = typeof msg.depth === 'number' && msg.depth >= 0 && msg.depth <= 5 
      ? msg.depth 
      : 2;
    pageLimit = typeof msg.pageLimit === 'number' && msg.pageLimit > 0 ? msg.pageLimit : null;
    startCrawl();
    // No response needed for crawl-start, popup doesn't wait for it
    return false;
  }

  if (msg.type === "manual-start") {
    startManualMode();
    sendResponse({ success: true });
    return false;
  }

  if (msg.type === "manual-stop") {
    stopManualMode();
    sendResponse({ success: true });
    return false;
  }

  if (msg.type === "ai-cancel") {
    aiCancelRequested = true;
    stopKeepAlive();
    sendResponse({ cancelled: true });
    return false;
  }

  if (msg.type === "get-db-stats") {
    (async () => {
      try {
        const sessionId = await ensureCurrentSessionId();
        const stats = await getDatabaseStats(sessionId);
        sendResponse(stats);
      } catch (error) {
        sendResponse({ error: error.message || String(error) });
      }
    })();
    return true;
  }

  if (msg.type === "page-scanned") {
    handlePageScanned(msg);
    // No response needed for page-scanned
    return false;
  }

  if (msg.type === "get-report") {
    // Restore session ID if not set (e.g., after extension reload)
    if (!currentSessionId) {
      chrome.storage.local.get(['CAST_currentSessionId'], async (res) => {
        if (res.CAST_currentSessionId) {
          currentSessionId = res.CAST_currentSessionId;
        }
        // Initialize IndexedDB if needed
        try {
          await initNetworkCallsDB();
        } catch (error) {
          console.warn('Failed to initialize IndexedDB:', error);
        }
        // Use async to get from IndexedDB
        try {
          const { flat: networkCalls } = await collectNetworkCalls();
          sendResponse({ networkCalls });
        } catch (error) {
          console.error('Error collecting network calls:', error);
          sendResponse({ networkCalls: [] });
        }
      });
    } else {
      // Use async to get from IndexedDB
      collectNetworkCalls().then(({ flat: networkCalls }) => {
        sendResponse({ networkCalls });
      }).catch(error => {
        console.error('Error collecting network calls:', error);
        sendResponse({ networkCalls: [] });
      });
    }
    return true; // Indicate async response - keep channel open
  }
  
  if (msg.type === "get-crawl-status") {
    // Return current crawl status for popup restoration
    sendResponse({
      active: crawlActive,
      manualMode: manualModeActive,
      status: crawlActive ? `Crawling... (${visited.size} visited, ${queue.length} queued)` 
             : manualModeActive ? "Manual Mode Active" 
             : "No active crawl",
      visited: visited.size,
      queued: queue.length
    });
    return false; // Synchronous response, no need to keep channel open
  }

  if (msg.type === "get-db-stats") {
    (async () => {
      try {
        const sessionId = await getActiveSessionId();
        const stats = await getDatabaseStats(sessionId);
        sendResponse(stats);
      } catch (error) {
        sendResponse({ error: error.message || String(error) });
      }
    })();
    return true;
  }

  if (msg.type === "export-tech-csv") {
    (async () => {
      try {
        const sessionId = await getActiveSessionId();
        if (!sessionId) {
          sendResponse({ error: "No session data available. Run a crawl first." });
          return;
        }
        const rows = await buildTechStackExport(sessionId);
        if (!rows.length) {
          sendResponse({ error: "No tech stack records found. Run AI analysis first." });
          return;
        }
        sendResponse({ rows, filename: "CAST_tech_stack_consolidated.csv" });
      } catch (error) {
        console.error('Tech stack export error:', error);
        sendResponse({ error: error.message || String(error) });
      }
    })();
    return true;
  }

  if (msg.type === "export-analytics-csv") {
    (async () => {
      try {
        const sessionId = await getActiveSessionId();
        if (!sessionId) {
          sendResponse({ error: "No session data available. Run a crawl first." });
          return;
        }
        const rows = await buildAnalyticsExport(sessionId);
        if (!rows.length) {
          sendResponse({ error: "No analytics events found. Run AI analysis first." });
          return;
        }
        sendResponse({ rows, filename: "CAST_analytics_events_consolidated.csv" });
      } catch (error) {
        console.error('Analytics export error:', error);
        sendResponse({ error: error.message || String(error) });
      }
    })();
    return true;
  }

  if (msg.type === "download-network-csv") {
    (async () => {
      try {
        const sessionId = await ensureCurrentSessionId();
        if (!sessionId) {
          sendResponse({ error: "No session data available. Run a crawl first." });
          return;
        }
        const { flat: networkCalls } = await collectNetworkCalls();
        if (!networkCalls.length) {
          sendResponse({ error: "No network calls captured yet. Run a crawl first." });
          return;
        }

        const rows = [["Page URL", "Request URL", "Method", "Host", "Pathname", "Query Params", "Has POST Data", "POST Data Preview"]];
        networkCalls.forEach(call => {
          const queryParamsStr = call.queryParams ? JSON.stringify(call.queryParams) : "";
          const postDataPreview = call.postData 
            ? (typeof call.postData === 'string' ? call.postData.substring(0, 500) : JSON.stringify(call.postData).substring(0, 500))
            : "";
          const hasPostData = call.postData ? "Yes" : "No";
          rows.push([
            call.pageUrl || "",
            call.url || "",
            call.method || "GET",
            call.host || "",
            call.pathname || "",
            queryParamsStr,
            hasPostData,
            postDataPreview
          ]);
        });

        const csvContent = rows.map(row =>
          row.map(cell => {
            const cellStr = String(cell || "").replace(/"/g, '""');
            if (cellStr.includes(',') || cellStr.includes('"') || cellStr.includes('\n')) {
              return `"${cellStr}"`;
            }
            return cellStr;
          }).join(',')
        ).join('\n');

        const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
        
        // Use FileReader to generate a Data URL, as URL.createObjectURL is sometimes unavailable in Service Workers
        const reader = new FileReader();
        reader.onload = function() {
          chrome.downloads.download({
            url: reader.result,
            filename: "CAST_network_calls.csv",
            saveAs: true
          }, (downloadId) => {
            if (chrome.runtime.lastError) {
              sendResponse({ error: chrome.runtime.lastError.message });
            } else {
              sendResponse({ success: true, count: networkCalls.length, downloadId });
            }
          });
        };
        reader.readAsDataURL(blob);
      } catch (error) {
        console.error('Network CSV export error:', error);
        sendResponse({ error: error.message || String(error) });
      }
    })();
    return true;
  }

  if (msg.type === "ai-summary") {
    chrome.storage.local.get(["geminiApiKey", "CAST_currentSessionId"], async (res) => {
      const apiKey = res.geminiApiKey;
      if (!apiKey) {
        sendResponse({ error: "No Gemini API key saved. Please save it first." });
        return;
      }
      aiCancelRequested = false;
      
      // Restore session ID if not set (e.g., after extension reload)
      if (!currentSessionId && res.CAST_currentSessionId) {
        currentSessionId = res.CAST_currentSessionId;
      }
      
      // Initialize IndexedDB if needed
      try {
        await initNetworkCallsDB();
      } catch (error) {
        console.warn('Failed to initialize IndexedDB:', error);
      }
      
      try {
        // Get network calls from IndexedDB (persistent) or memory (fallback)
        const { flat: networkCalls } = await collectNetworkCalls();
        if (!networkCalls.length) {
          sendResponse({ error: "No network calls captured yet. Run a crawl first." });
          return;
        }
        
        // Use existing session ID or create new one if none exists
        if (!currentSessionId) {
          currentSessionId = `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
          chrome.storage.local.set({ CAST_currentSessionId: currentSessionId });
        }

        // Check if we already have results stored
        const existingResults = await getAllStoredResults(currentSessionId);
        const hasExistingResults = existingResults.techStack.length > 0 || existingResults.analyticsEvents.length > 0;
        
        // Progress callback
        const progressCallback = (progress) => {
          chrome.storage.local.set({
            CAST_ragProgress: {
              processed: progress.processed,
              total: progress.total,
              percentage: progress.percentage,
              current: progress.current,
              stage: progress.stage || 'AI Analysis'
            }
          });
          
          try {
            chrome.runtime.sendMessage({
              type: 'rag-progress',
              progress: {
                processed: progress.processed,
                total: progress.total,
                percentage: progress.percentage,
                current: progress.current,
                stage: progress.stage || 'AI Analysis'
              }
            }).catch(() => {});
          } catch (e) {}
        };
        
        // Check which network calls have already been processed
        // Get all processed batch IDs to track what's been done
        const processedBatches = await new Promise((resolve) => {
          const transaction = networkCallsDB.transaction(['techStackResults'], 'readonly');
          const store = transaction.objectStore('techStackResults');
          const index = store.index('sessionId');
          const request = index.getAll(currentSessionId);
          request.onsuccess = () => {
            const batches = new Set((request.result || []).map(r => r.batchId).filter(Boolean));
            resolve(batches);
          };
          request.onerror = () => resolve(new Set());
        });
        
        // Force reprocessing if requested or if we're in a debugging state
        // The previous logic might skip processing if it sees ANY results, even incomplete ones.
        // We want to ensure it processes ALL batches if they aren't fully done.
        // For now, let's simplify: if we are running AI analysis, we should probably just run it on whatever data we have
        // that hasn't been processed yet, OR just re-run it if the user asks.
        
        // However, the user issue is that it's NOT running through all data.
        // Let's modify the condition to be more aggressive about processing.
        // If we have network calls but no/partial results, we should process.
        
        // Let's check if we have ANY processed batches.
        const hasProcessedBatches = processedBatches.size > 0;
        
        // If the user clicks "Run AI", they likely expect it to run on the current set of network calls.
        // If we already have results for this session, we might want to skip ALREADY PROCESSED batches,
        // but we shouldn't skip the whole thing just because *some* results exist.
        
        // The critical fix: We will calculate the batches first, then check which are done.
        // But `processBatchesDirect` handles the splitting. 
        // So we should pass the `processedBatches` set to `processBatchesDirect` and let it skip internally?
        // OR, just for now, to ensure it runs, let's force it to run if there are network calls.
        
        const needsProcessing = true; // FORCE processing to ensure we loop through data. deduplication handles the rest.
        
        if (needsProcessing) {
          // Pre-filter network calls (remove static assets)
          const staticAssetPattern = /\.(jpg|jpeg|png|gif|svg|webp|ico|woff|woff2|ttf|eot|css|js|map|pdf|zip|mp4|mp3|webm|ogg)(\?|$)/i;
          const filteredCalls = networkCalls.filter(call => {
            const url = call.url || '';
            // Filter out static assets
            if (staticAssetPattern.test(url)) {
              return false;
            }
            return true; // Keep everything else
          });
          
          console.log(`CAST: Processing ${filteredCalls.length} network calls in batches`);
          
          // Update progress
          chrome.storage.local.set({
            CAST_ragProgress: {
              processed: 0,
              total: filteredCalls.length,
              percentage: 0,
              current: 'Preparing batches...',
              stage: 'AI Analysis'
            }
          });
          
          // Process in batches and store results
          const result = await processBatchesDirect(apiKey, filteredCalls, currentSessionId, progressCallback);
          if (result?.cancelled) {
            sendResponse({ error: "AI analysis cancelled." });
            return;
          }
        } else {
          console.log('CAST: Using existing results from previous analysis');
          chrome.storage.local.set({
            CAST_ragProgress: {
              processed: 100,
              total: 100,
              percentage: 100,
              current: 'Using existing results',
              stage: 'Complete'
            }
          });
        }
        
        // Get all stored results
        // Consolidate stored results to remove duplicates before final retrieval
        console.log('CAST: Starting cleanup service to consolidate and deduplicate results...');
        await consolidateStoredResults(currentSessionId);
        const allResults = await getAllStoredResults(currentSessionId);
        
        // Deduplicate and format results
        const techStackMap = new Map();
        for (const item of allResults.techStack) {
          const key = `${item.name}_${item.category}`;
          if (!techStackMap.has(key) || techStackMap.get(key).confidence < item.confidence) {
            techStackMap.set(key, {
              name: item.name,
              category: item.category,
              confidence: item.confidence,
              evidence: item.evidence
            });
          }
        }
        
        const analyticsMap = new Map();
        for (const item of allResults.analyticsEvents) {
          const key = `${item.provider}_${item.event_name}_${item.request_url}`;
          if (!analyticsMap.has(key)) {
            analyticsMap.set(key, {
              provider: item.provider,
              event_name: item.event_name,
              page_url: item.page_url,
              request_url: item.request_url,
              notes: item.notes
            });
          }
        }
        
        // Create summary
        const techStack = Array.from(techStackMap.values());
        const analyticsEvents = Array.from(analyticsMap.values());
        
        const summary = `# CAST Analysis Summary\n\n` +
          `**Tech Stack Found:** ${techStack.length} technologies\n` +
          `**Analytics Events Found:** ${analyticsEvents.length} events\n\n` +
          `Analysis completed using direct batch processing (no RAG).`;
        
        // Return results in expected format
        sendResponse({
          summary_markdown: summary,
          tech_stack: techStack,
          analytics_events: analyticsEvents
        });
      } catch (e) {
        console.error('Error in AI analysis:', e);
        sendResponse({ error: e.message || String(e) });
      }
    });
    return true;
  }

  return false;
});

async function startCrawl() {
  chrome.tabs.query({ active: true, lastFocusedWindow: true }, async ([tab]) => {
    if (!tab || !tab.url || !tab.url.startsWith("http")) {
      return;
    }

    const u = new URL(tab.url);
    origin = u.origin;
    activeTabId = tab.id;

    logs = {};
    const seedUrl = normalizeUrl(u.href);
    queue = [{ url: u.href, depth: 1 }]; // Seed page is depth 1
    visited = new Set();
    allDiscoveredLinks = new Set([seedUrl]); // Initialize with seed URL
    crawlActive = true;
    currentTask = null;

    // Initialize IndexedDB for network calls persistence
    try {
      await initNetworkCallsDB();
    } catch (error) {
      console.warn('Failed to initialize IndexedDB, will use memory storage only:', error);
    }
    
    // Restore or create session ID
    chrome.storage.local.get(['CAST_currentSessionId'], async (res) => {
      const oldSessionId = res.CAST_currentSessionId;
      
      // Create new session ID
      currentSessionId = `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      
      // Clear old session data if starting a new crawl (not a resume)
      if (oldSessionId && oldSessionId !== currentSessionId) {
        try {
          await clearNetworkCallsForSession(oldSessionId);
          await clearStoreEntriesForSession('uniqueUrls', oldSessionId);
        } catch (error) {
          console.warn('Failed to clear old session data:', error);
        }
      }
      
      // Store new session ID for persistence across reloads
      chrome.storage.local.set({ CAST_currentSessionId: currentSessionId });

      // Save seed URL to uniqueUrls store
      try {
        await saveUniqueUrlToDB(currentSessionId, seedUrl, 'seed');
      } catch (e) {
        console.warn('CAST: Failed to save seed URL:', e);
      }
      
      // Store crawl state for popup persistence
      chrome.storage.local.set({
        CAST_crawlActive: true,
        CAST_crawlStatus: `Starting crawl (depth ${maxDepth}, limit ${pageLimit ? pageLimit : 'all'})… browser will navigate within this domain.`,
        CAST_crawlStartTime: Date.now(),
        CAST_crawlDepth: maxDepth,
        CAST_pageLimit: pageLimit ?? "all"
      });
      
      // Notify popup if open
      const startStatus = `Starting crawl (depth ${maxDepth}, limit ${pageLimit ? pageLimit : 'all'})… browser will navigate within this domain.`;
      notifyPopupStatus(startStatus);
      
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
    }); // End chrome.storage.local.get
  }); // End chrome.tabs.query
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

  if (pageLimit && visited.size >= pageLimit) {
    console.log(`Page limit of ${pageLimit} reached, ending crawl.`);
    crawlActive = false;
    if (pageTimeout) {
      clearTimeout(pageTimeout);
      pageTimeout = null;
    }
    const limitStatus = `Crawl complete: reached page limit (${visited.size}/${pageLimit} pages).`;
    chrome.storage.local.set({
      CAST_crawlActive: false,
      CAST_crawlStatus: limitStatus
    });
    notifyPopupStatus(limitStatus);
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
            // Persist unique URL
            saveUniqueUrlToDB(currentSessionId, normalized, 'discovered').catch(() => {});
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
    
    // Save to IndexedDB incrementally (non-blocking)
    if (currentSessionId) {
      saveNetworkCallToDB(currentSessionId, url, { method, params }).catch(err => {
        // Error already logged in saveNetworkCallToDB, continue silently
      });
    }
  });
});

// --- Intelligent network payload - prioritize analytics & tech stack, limit others ---
// Strategy: Keep ALL analytics requests with full data, keep tech stack indicators,
// but limit/summarize other requests to stay within token limits

function buildNetworkPayloadFromCalls(networkCallsByPage, options = {}) {
  const pages = [];
  const maxPages = options.maxPages || 20;
  const maxRequestsPerPage = options.maxCallsPerPage || 200;
  const essentialHeaders = ['user-agent', 'referer', 'content-type', 'authorization', 'x-forwarded-for'];
  const entries = Object.entries(networkCallsByPage)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .slice(0, maxPages);

  for (const [pageUrl, calls] of entries) {
    const requests = calls.slice(0, maxRequestsPerPage).map(call => {
      const filteredHeaders = {};
      const headers = call.headerValues || {};
      for (const key of essentialHeaders) {
        if (headers[key]) {
          filteredHeaders[key] = headers[key];
        } else if (headers[key?.toUpperCase?.()]) {
          filteredHeaders[key] = headers[key.toUpperCase()];
        }
      }
      return {
        pageUrl,
        url: call.url,
        host: call.host,
        pathname: call.pathname,
        method: call.method,
        queryParams: call.queryParams || {},
        headerValues: filteredHeaders,
        postData: call.postData || null
      };
    });
    if (requests.length) {
      pages.push({ pageUrl, requests, responses: [] });
    }
  }

  return { pages };
}

// Build payload from RAG-retrieved data
function buildRAGPayload(retrieved, networkCallsByPage) {
  const pages = [];
  const pageMap = new Map();
  // Higher limits for analytics to capture all events - NO LIMIT for analytics
  const MAX_ANALYTICS_REQUESTS_PER_PAGE = 400; // Plenty per page but keeps payload bounded
  const MAX_TOTAL_ANALYTICS_REQUESTS = 6000; // Global cap for analytics across all pages
  const MAX_OTHER_REQUESTS_PER_PAGE = 80; // Limit for non-analytics per page
  const MAX_TOTAL_OTHER_REQUESTS = 2000; // Global cap for other requests
  const MAX_POST_BODY_SIZE = 4000;
  const MAX_ANALYTICS_POST_BODY_SIZE = 12000;
  const MAX_PAGES = 20; // Tighter cap to keep payload within Gemini token limits

  // Deduplicate requests - but for analytics, include POST data in key to avoid deduplicating different events
  const seenRequests = new Set();
  const uniqueRequests = [];
  
  let totalAnalyticsCount = 0;
  let totalOtherCount = 0;
  for (const request of [...retrieved.analytics, ...retrieved.techStack, ...retrieved.allRelevant]) {
    const isAnalytics = /(google-analytics|analytics\.google|googletagmanager|gtag|gtm|segment|mixpanel|amplitude|hotjar|clarity|hubspot|adroll|facebook|meta|tiktok)/i.test(request.host);
    
    // For analytics, include POST data preview in deduplication key (different events = different POST bodies)
    // For others, just use URL + query params
    const postPreview = isAnalytics && request.postData 
      ? (typeof request.postData === 'string' ? request.postData.slice(0, 200) : JSON.stringify(request.postData).slice(0, 200))
      : '';
    const requestKey = `${request.host}${request.pathname}${JSON.stringify(request.queryParams || {})}${postPreview}`;
    
    if (seenRequests.has(requestKey)) continue;
    
    if (isAnalytics && totalAnalyticsCount >= MAX_TOTAL_ANALYTICS_REQUESTS) continue;
    if (!isAnalytics && totalOtherCount >= MAX_TOTAL_OTHER_REQUESTS) continue;
    
    seenRequests.add(requestKey);
    
    const maxPostSize = isAnalytics ? MAX_ANALYTICS_POST_BODY_SIZE : MAX_POST_BODY_SIZE;
    if (request.postData && typeof request.postData === 'string' && request.postData.length > maxPostSize) {
      request.postData = request.postData.slice(0, maxPostSize) + '...[truncated]';
    }
    
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
    if (isAnalytics) {
      totalAnalyticsCount++;
    } else {
      totalOtherCount++;
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

  const entries = Array.from(pageMap.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .slice(0, MAX_PAGES);
  for (const [, page] of entries) {
    pages.push(page);
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
    return buildNetworkPayloadFromCalls(networkCallsByPage, { maxPages: 15, maxCallsPerPage: 150 });
  }

  return payload;
}
// Collect network calls from IndexedDB (preferred) or memory (fallback)
async function collectNetworkCalls() {
  // Try to get from IndexedDB first (persistent storage)
  const sessionId = await ensureCurrentSessionId();
  if (sessionId) {
    try {
      const dbResult = await getNetworkCallsFromDB(sessionId);
      if (dbResult.flat.length > 0) {
        return dbResult; // Return IndexedDB data if available
      }
    } catch (error) {
      console.warn('Failed to retrieve from IndexedDB, falling back to memory:', error);
    }
  } else {
    console.warn('No active session ID found when collecting network calls.');
  }
  
  // Fallback to in-memory logs (for backward compatibility and active crawls)
  const flat = [];
  const byPage = {};
  for (const [pageUrl, entry] of Object.entries(logs)) {
    const networkEvents = entry.network || [];
    for (const event of networkEvents) {
      if (event.method !== "Network.requestWillBeSent") continue;
      const req = event.params?.request;
      if (!req || !req.url) continue;
      let urlObj;
      try {
        urlObj = new URL(req.url);
      } catch (e) {
        continue;
      }
      const call = {
        pageUrl,
        url: req.url,
        method: req.method || "GET",
        host: urlObj.host,
        pathname: urlObj.pathname,
        queryParams: Object.fromEntries(urlObj.searchParams.entries()),
        headerValues: req.headers || {},
        postData: req.postData || null,
        requestId: event.params?.requestId || null
      };
      flat.push(call);
      if (!byPage[pageUrl]) {
        byPage[pageUrl] = [];
      }
      byPage[pageUrl].push(call);
    }
  }
  return { flat, byPage };
}

// ---- Gemini 2.5 Flash call ----

async function callGemini(apiKey, networkPayload, attempt = 1) {
  const MAX_RETRIES = 3;
  const endpoint =
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-preview:generateContent?key=" +
    encodeURIComponent(apiKey);

  const systemPrompt = `
You are CAST, a web reconnaissance analyst.

You will receive JSON data containing network requests captured from a website crawl. This is a batch of network traffic data.

The data includes:
- Network requests organized by page URL
- Each request includes: url, method, host, pathname, queryParams, postData
- Analytics requests: Google Analytics, GTM, Segment, Mixpanel, HubSpot, etc. with FULL data
- Tech stack requests: CDN, hosting, CMS, frameworks with FULL data
- All other network requests

Each request includes:
- url, method, host, pathname, pageUrl
- query parameter KEYS and VALUES (full data)
- postData (full POST body when present)

This is a batch of network traffic. Analyze ALL requests in this batch comprehensively. Extract ALL analytics events and complete tech stack information from this data.

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

  try {
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
    
    // Find JSON object start and end
    const firstBrace = cleanedText.indexOf('{');
    const lastBrace = cleanedText.lastIndexOf('}');
    
    if (firstBrace !== -1 && lastBrace !== -1) {
      cleanedText = cleanedText.substring(firstBrace, lastBrace + 1);
    } else if (cleanedText.startsWith("```")) {
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
  } catch (error) {
    const isLastAttempt = attempt >= MAX_RETRIES;
    const isNetworkError = error.message.includes('Failed to fetch') || error.message.includes('NetworkError');
    const delay = isNetworkError ? 2000 * attempt : 500 * attempt; // Longer backoff for network errors
    
    console.warn(`CAST: Gemini request failed on attempt ${attempt}/${MAX_RETRIES}:`, error);
    if (!isLastAttempt) {
      await sleep(delay);
      return callGemini(apiKey, networkPayload, attempt + 1);
    }
    throw new Error(`Gemini request failed after ${MAX_RETRIES} attempts: ${error.message || error}`);
  }
}
