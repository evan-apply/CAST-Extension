// RAG (Retrieval-Augmented Generation) module for CAST
// Uses Gemini embeddings to create a searchable vector store of network requests
// This allows analyzing unlimited data without hitting token limits

// Min-heap to keep only top-K results (more efficient than sorting all)
class MinHeap {
  constructor(maxSize) {
    this.heap = [];
    this.maxSize = maxSize;
  }
  
  push(item) {
    if (this.heap.length < this.maxSize) {
      this.heap.push(item);
      this.bubbleUp(this.heap.length - 1);
    } else if (item.similarity > this.heap[0].similarity) {
      this.heap[0] = item;
      this.bubbleDown(0);
    }
  }
  
  bubbleUp(index) {
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (this.heap[parent].similarity <= this.heap[index].similarity) break;
      [this.heap[parent], this.heap[index]] = [this.heap[index], this.heap[parent]];
      index = parent;
    }
  }
  
  bubbleDown(index) {
    while (true) {
      let smallest = index;
      const left = 2 * index + 1;
      const right = 2 * index + 2;
      
      if (left < this.heap.length && this.heap[left].similarity < this.heap[smallest].similarity) {
        smallest = left;
      }
      if (right < this.heap.length && this.heap[right].similarity < this.heap[smallest].similarity) {
        smallest = right;
      }
      if (smallest === index) break;
      [this.heap[index], this.heap[smallest]] = [this.heap[smallest], this.heap[index]];
      index = smallest;
    }
  }
  
  getSorted() {
    return this.heap.sort((a, b) => b.similarity - a.similarity);
  }
}

class CASTRAG {
  constructor() {
    this.dbName = 'CAST_RAG_DB';
    this.dbVersion = 1;
    this.db = null;
    this.embeddingCache = new Map(); // Cache embeddings to avoid duplicate API calls
  }

  // Initialize IndexedDB for storing embeddings
  async initDB() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, this.dbVersion);

      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        this.db = request.result;
        resolve(this.db);
      };

      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        
        // Store for network request embeddings
        if (!db.objectStoreNames.contains('embeddings')) {
          const store = db.createObjectStore('embeddings', { keyPath: 'id' });
          store.createIndex('url', 'url', { unique: false });
          store.createIndex('host', 'host', { unique: false });
          store.createIndex('sessionId', 'sessionId', { unique: false });
          store.createIndex('timestamp', 'timestamp', { unique: false });
        }

        // Store for crawl sessions
        if (!db.objectStoreNames.contains('sessions')) {
          db.createObjectStore('sessions', { keyPath: 'sessionId' });
        }
        
        // Store for embedding cache (persistent across sessions)
        if (!db.objectStoreNames.contains('embeddingCache')) {
          const cacheStore = db.createObjectStore('embeddingCache', { keyPath: 'cacheKey' });
          cacheStore.createIndex('timestamp', 'timestamp', { unique: false });
        }
      };
    });
  }

  // Create embedding for a network request using Gemini
  async createEmbedding(apiKey, requestData) {
    // Create a text representation of the request for embedding
    const text = this.requestToText(requestData);
    
    // Check in-memory cache first
    const cacheKey = this.hashText(text);
    if (this.embeddingCache.has(cacheKey)) {
      return this.embeddingCache.get(cacheKey);
    }
    
    // Ensure DB is initialized for persistent cache check
    if (!this.db) {
      try {
        await this.initDB();
      } catch (error) {
        console.warn('Failed to initialize DB for cache:', error);
      }
    }
    
    // Check persistent cache in IndexedDB
    if (this.db) {
      try {
        const cacheStore = this.db.transaction(['embeddingCache'], 'readonly').objectStore('embeddingCache');
        const cached = await new Promise((resolve, reject) => {
          const request = cacheStore.get(cacheKey);
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        
        if (cached && cached.embedding) {
          // Update in-memory cache
          this.embeddingCache.set(cacheKey, cached.embedding);
          return cached.embedding;
        }
      } catch (error) {
        // Cache read failed, continue to API call
        console.warn('Cache read failed:', error);
      }
    }

    try {
      const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:embedContent?key=${encodeURIComponent(apiKey)}`;
      
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'models/text-embedding-004',
          content: {
            parts: [{ text }]
          }
        })
      });

      if (!response.ok) {
        throw new Error(`Embedding API error: ${await response.text()}`);
      }

      const data = await response.json();
      const embedding = data.embedding?.values;
      
      if (!embedding) {
        throw new Error('No embedding returned');
      }

      // Cache the embedding in memory
      this.embeddingCache.set(cacheKey, embedding);
      
      // Cache the embedding in IndexedDB (persistent)
      if (this.db) {
        try {
          const cacheStore = this.db.transaction(['embeddingCache'], 'readwrite').objectStore('embeddingCache');
          await new Promise((resolve, reject) => {
            const request = cacheStore.put({
              cacheKey,
              embedding,
              text: text.substring(0, 500), // Store text preview for debugging
              timestamp: Date.now()
            });
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
          });
        } catch (error) {
          // Cache write failed, but continue
          console.warn('Cache write failed:', error);
        }
      }
      
      return embedding;
    } catch (error) {
      console.error('Embedding creation failed:', error);
      // Fallback: return a simple hash-based vector (not ideal but works)
      return this.fallbackEmbedding(text);
    }
  }

  // Convert network request to text for embedding
  requestToText(requestData) {
    const parts = [
      `Host: ${requestData.host}`,
      `Path: ${requestData.pathname}`,
      `Method: ${requestData.method}`,
    ];

    if (requestData.queryParams && Object.keys(requestData.queryParams).length > 0) {
      parts.push(`Query: ${JSON.stringify(requestData.queryParams)}`);
    }

    if (requestData.postData) {
      // For analytics, include more of the POST body to capture batched events
      const isAnalytics = /(google-analytics|analytics\.google|googletagmanager|gtag|gtm)/i.test(requestData.host);
      const maxPostPreview = isAnalytics ? 2000 : 500; // More data for analytics
      const postPreview = typeof requestData.postData === 'string' 
        ? requestData.postData.slice(0, maxPostPreview) 
        : JSON.stringify(requestData.postData).slice(0, maxPostPreview);
      parts.push(`Body: ${postPreview}`);
    }

    // Include important headers
    if (requestData.headerValues) {
      const importantHeaders = ['user-agent', 'referer', 'content-type', 'authorization'];
      const headerParts = [];
      for (const key of importantHeaders) {
        if (requestData.headerValues[key]) {
          headerParts.push(`${key}: ${requestData.headerValues[key]}`);
        }
      }
      if (headerParts.length > 0) {
        parts.push(`Headers: ${headerParts.join(', ')}`);
      }
    }

    return parts.join(' | ');
  }

  // Simple hash function for caching
  hashText(text) {
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
      const char = text.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32bit integer
    }
    return hash.toString();
  }

  // Fallback embedding if API fails (simple hash-based)
  fallbackEmbedding(text) {
    const vector = new Array(768).fill(0);
    for (let i = 0; i < text.length; i++) {
      vector[i % 768] += text.charCodeAt(i);
    }
    // Normalize
    const magnitude = Math.sqrt(vector.reduce((sum, val) => sum + val * val, 0));
    return vector.map(val => magnitude > 0 ? val / magnitude : 0);
  }

  // Cosine similarity between two vectors
  cosineSimilarity(vecA, vecB) {
    if (vecA.length !== vecB.length) return 0;
    
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;
    
    for (let i = 0; i < vecA.length; i++) {
      dotProduct += vecA[i] * vecB[i];
      normA += vecA[i] * vecA[i];
      normB += vecB[i] * vecB[i];
    }
    
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
  }

  // Store embedding in IndexedDB
  async storeEmbedding(requestData, embedding, sessionId) {
    if (!this.db) await this.initDB();

    const store = this.db.transaction(['embeddings'], 'readwrite').objectStore('embeddings');
    
    const record = {
      id: `${sessionId}_${requestData.requestId || Date.now()}_${Math.random()}`,
      sessionId,
      url: requestData.host + requestData.pathname,
      host: requestData.host,
      requestData,
      embedding,
      timestamp: Date.now()
    };

    return new Promise((resolve, reject) => {
      const request = store.add(record);
      request.onsuccess = () => resolve(record.id);
      request.onerror = () => reject(request.error);
    });
  }

  // Search for similar requests using semantic search (optimized for large datasets)
  async searchSimilar(queryEmbedding, sessionId, limit = 50) {
    if (!this.db) await this.initDB();

    return new Promise((resolve, reject) => {
      try {
        const store = this.db.transaction(['embeddings'], 'readonly').objectStore('embeddings');
        const index = store.index('sessionId');
        
        // Use min-heap to keep only top-K results (avoids sorting all 30K records)
        const heap = new MinHeap(limit * 2); // Keep 2x limit for better accuracy
        let processed = 0;
        const BATCH_SIZE = 1000; // Process 1000 at a time
        let batch = [];
        
        const request = index.openCursor(IDBKeyRange.only(sessionId));
        
        request.onsuccess = (event) => {
          const cursor = event.target.result;
          
          if (!cursor) {
            // Finished - process any remaining items and return results
            for (const item of batch) {
              heap.push(item);
            }
            const results = heap.getSorted().slice(0, limit);
            console.log(`CAST: Processed ${processed} embeddings, returning top ${results.length}`);
            resolve(results);
            return;
          }
          
          const record = cursor.value;
          processed++;
          
          // Calculate similarity if embedding exists
          if (record.embedding && Array.isArray(record.embedding)) {
            try {
              const similarity = this.cosineSimilarity(queryEmbedding, record.embedding);
              batch.push({ ...record, similarity });
            } catch (error) {
              // Skip invalid records
            }
          }
          
          // Process batch when it reaches BATCH_SIZE to avoid memory issues
          if (batch.length >= BATCH_SIZE) {
            for (const item of batch) {
              heap.push(item);
            }
            batch = []; // Clear batch
            
            // Yield to event loop to prevent blocking UI
            setTimeout(() => {
              cursor.continue();
            }, 0);
            return;
          }
          
          // Continue to next record
          cursor.continue();
        };
        
        request.onerror = () => {
          console.error('IndexedDB error in searchSimilar:', request.error);
          reject(request.error);
        };
      } catch (error) {
        console.error('Error in searchSimilar:', error);
        reject(error);
      }
    });
  }

  // Clear old session data
  async clearSession(sessionId) {
    if (!this.db) await this.initDB();

    return new Promise((resolve, reject) => {
      const store = this.db.transaction(['embeddings'], 'readwrite').objectStore('embeddings');
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
  }

  // Create a unique signature for a network call to check if embedding exists
  getRequestSignature(requestData) {
    const queryStr = JSON.stringify(requestData.queryParams || {});
    const postPreview = requestData.postData 
      ? (typeof requestData.postData === 'string' ? requestData.postData.slice(0, 200) : JSON.stringify(requestData.postData).slice(0, 200))
      : '';
    return `${requestData.host}${requestData.pathname}${requestData.method}${queryStr}${postPreview}`;
  }

  // Get existing embeddings for a session to check what's already processed
  async getExistingEmbeddings(sessionId) {
    if (!this.db) await this.initDB();
    
    return new Promise((resolve, reject) => {
      const store = this.db.transaction(['embeddings'], 'readonly').objectStore('embeddings');
      const index = store.index('sessionId');
      const request = index.getAll(sessionId);
      
      request.onsuccess = () => {
        const records = request.result;
        // Create a set of signatures for quick lookup
        const signatures = new Set();
        records.forEach(record => {
          if (record.requestData) {
            const sig = this.getRequestSignature(record.requestData);
            signatures.add(sig);
          }
        });
        resolve(signatures);
      };
      
      request.onerror = () => reject(request.error);
    });
  }

  // Process network call list and create embeddings in parallel batches
  // Only creates embeddings for new calls that don't already have embeddings
  async processNetworkCalls(apiKey, networkCalls, sessionId, progressCallback = null) {
    if (!this.db) await this.initDB();

    // Get existing embeddings to avoid recreating
    let existingSignatures = new Set();
    try {
      existingSignatures = await this.getExistingEmbeddings(sessionId);
      console.log(`CAST: Found ${existingSignatures.size} existing embeddings for session ${sessionId}`);
    } catch (error) {
      console.warn('Error getting existing embeddings, will process all:', error);
    }

    // Enhanced analytics pattern to catch all GA4 variations
    const analyticsPattern = /(google-analytics|analytics\.google|googletagmanager|gtag|gtm|segment|mixpanel|amplitude|hotjar|clarity|hubspot|adroll|facebook|meta|tiktok|linkedin|twitter|pinterest|reddit|quora|bing|microsoft|sentry|datadog|newrelic|fullstory|heap|pendo|optimizely|vwo|ab-tasty|doubleclick|googleadservices|googlesyndication)/i;
    const techStackPattern = /(vercel|netlify|cloudflare|aws|azure|gcp|fastly|akamai|cloudfront|contentful|wordpress|shopify|sanity|strapi|prismic|drupal|squarespace|wix|webflow|nextjs|react|vue|angular|svelte|nuxt|gatsby)/i;

    // Filter and prepare requests for processing
    // Only include requests that don't already have embeddings
    const requestsToProcess = [];
    for (const call of networkCalls) {
      try {
        const hostname = call.host || new URL(call.url).hostname;
        const pathname = call.pathname || new URL(call.url).pathname;
        const isAnalytics = analyticsPattern.test(hostname) || analyticsPattern.test(pathname);
        const isTechStack = techStackPattern.test(hostname) || techStackPattern.test(pathname);

        if (isAnalytics || isTechStack || requestsToProcess.length < 5000) {
          const requestData = {
            requestId: call.requestId || `${hostname}_${Date.now()}_${Math.random()}`,
            host: hostname,
            pathname,
            method: call.method || "GET",
            queryParams: call.queryParams || {},
            headerValues: call.headerValues || {},
            postData: call.postData || null,
            pageUrl: call.pageUrl || null
          };
          
          // Check if embedding already exists for this request
          const signature = this.getRequestSignature(requestData);
          if (!existingSignatures.has(signature)) {
            requestsToProcess.push(requestData);
          }
        }
      } catch (e) {
        console.error('Error preparing request:', e);
      }
    }
    
    const totalExisting = existingSignatures.size;
    
    if (requestsToProcess.length === 0) {
      console.log('CAST: All network calls already have embeddings, skipping processing');
      return { processed: totalExisting, total: networkCalls.length, new: 0, skipped: true };
    }
    
    console.log(`CAST: Processing ${requestsToProcess.length} new network calls (${totalExisting} already have embeddings)`);

    const totalNew = requestsToProcess.length;
    const totalAll = totalExisting + totalNew;
    let processed = 0;
    const CONCURRENT_BATCH_SIZE = 15; // Process 15 embeddings in parallel

    // Process in parallel batches
    for (let i = 0; i < requestsToProcess.length; i += CONCURRENT_BATCH_SIZE) {
      const batch = requestsToProcess.slice(i, i + CONCURRENT_BATCH_SIZE);
      
      // Process batch in parallel
      const batchPromises = batch.map(async (requestData) => {
        try {
          const embedding = await this.createEmbedding(apiKey, requestData);
          await this.storeEmbedding(requestData, embedding, sessionId);
          processed++;
          
          // Report progress (include existing in total)
          if (progressCallback) {
            const totalProcessed = totalExisting + processed;
            progressCallback({
              processed: totalProcessed,
              total: totalAll,
              newProcessed: processed,
              newTotal: totalNew,
              percentage: Math.round((totalProcessed / totalAll) * 100),
              current: requestData.host + requestData.pathname
            });
          }
          
          return { success: true, requestData };
        } catch (error) {
          console.error('Error processing request in batch:', error);
          return { success: false, error, requestData };
        }
      });

      // Wait for batch to complete
      await Promise.allSettled(batchPromises);
    }

    return { processed: totalExisting + processed, total: totalAll, new: processed, skipped: false };
  }

  // Retrieve relevant requests for analysis queries (parallel processing)
  async retrieveForAnalysis(apiKey, queries, sessionId) {
    const results = {
      analytics: [],
      techStack: [],
      allRelevant: []
    };

    // Process all queries in parallel
    const queryPromises = queries.map(async (query) => {
      try {
        const queryEmbedding = await this.createEmbedding(apiKey, { 
          host: query, 
          pathname: '', 
          method: 'GET' 
        });

        // Increase results for analytics queries, use much lower threshold for analytics
        const limit = query.toLowerCase().includes('analytics') ? 500 : 50; // Increased from 200 to 500
        const similar = await this.searchSimilar(queryEmbedding, sessionId, limit);
        
        const queryResults = {
          analytics: [],
          techStack: [],
          allRelevant: []
        };
        
        for (const item of similar) {
          // Much lower threshold for analytics to capture ALL events
          const isAnalytics = /(google-analytics|analytics\.google|googletagmanager|gtag|gtm|segment|mixpanel|amplitude|hotjar|clarity|hubspot|adroll|facebook|meta|tiktok)/i.test(item.host);
          const threshold = isAnalytics ? 0.1 : 0.4; // Much lower threshold (0.1 instead of 0.25) for analytics
          
          if (item.similarity > threshold) {
            const isTechStack = /(vercel|netlify|cloudflare|aws|azure|gcp|contentful|wordpress|shopify|nextjs|react|vue)/i.test(item.host);

            if (isAnalytics) {
              queryResults.analytics.push(item.requestData);
            } else if (isTechStack) {
              queryResults.techStack.push(item.requestData);
            }
            
            queryResults.allRelevant.push(item.requestData);
          }
        }
        
        return queryResults;
      } catch (error) {
        console.error(`Error processing query "${query}":`, error);
        return { analytics: [], techStack: [], allRelevant: [] };
      }
    });

    // Wait for all queries to complete in parallel
    const queryResultsArray = await Promise.all(queryPromises);
    
    // Merge results from all queries
    for (const queryResult of queryResultsArray) {
      results.analytics.push(...queryResult.analytics);
      results.techStack.push(...queryResult.techStack);
      results.allRelevant.push(...queryResult.allRelevant);
    }

    // Deduplicate - but for analytics, include query params and POST data in key
    // because different events can have same host/path but different params/body
    const seen = new Set();
    results.analytics = results.analytics.filter(r => {
      // For analytics, use full request signature (host + path + query + postData preview)
      // to avoid deduplicating different events
      const queryStr = JSON.stringify(r.queryParams || {});
      const postPreview = r.postData ? (typeof r.postData === 'string' ? r.postData.slice(0, 100) : JSON.stringify(r.postData).slice(0, 100)) : '';
      const key = `${r.host}${r.pathname}${queryStr}${postPreview}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    seen.clear();
    results.techStack = results.techStack.filter(r => {
      const key = `${r.host}${r.pathname}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    return results;
  }
}

// Make available globally for service worker
self.CASTRAG = CASTRAG;

