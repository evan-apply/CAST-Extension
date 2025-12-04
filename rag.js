// RAG (Retrieval-Augmented Generation) module for CAST
// Uses Gemini embeddings to create a searchable vector store of network requests
// This allows analyzing unlimited data without hitting token limits

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
      };
    });
  }

  // Create embedding for a network request using Gemini
  async createEmbedding(apiKey, requestData) {
    // Create a text representation of the request for embedding
    const text = this.requestToText(requestData);
    
    // Check cache first
    const cacheKey = this.hashText(text);
    if (this.embeddingCache.has(cacheKey)) {
      return this.embeddingCache.get(cacheKey);
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

      // Cache the embedding
      this.embeddingCache.set(cacheKey, embedding);
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

  // Search for similar requests using semantic search
  async searchSimilar(queryEmbedding, sessionId, limit = 50) {
    if (!this.db) await this.initDB();

    return new Promise((resolve, reject) => {
      const store = this.db.transaction(['embeddings'], 'readonly').objectStore('embeddings');
      const index = store.index('sessionId');
      const request = index.getAll(sessionId);

      request.onsuccess = () => {
        const allRecords = request.result;
        const similarities = allRecords.map(record => ({
          ...record,
          similarity: this.cosineSimilarity(queryEmbedding, record.embedding)
        }));

        // Sort by similarity and return top results
        similarities.sort((a, b) => b.similarity - a.similarity);
        resolve(similarities.slice(0, limit));
      };

      request.onerror = () => reject(request.error);
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

  // Process network call list and create embeddings
  async processNetworkCalls(apiKey, networkCalls, sessionId) {
    if (!this.db) await this.initDB();

    // Clear old session data
    await this.clearSession(sessionId);

    // Enhanced analytics pattern to catch all GA4 variations
    const analyticsPattern = /(google-analytics|analytics\.google|googletagmanager|gtag|gtm|segment|mixpanel|amplitude|hotjar|clarity|hubspot|adroll|facebook|meta|tiktok|linkedin|twitter|pinterest|reddit|quora|bing|microsoft|sentry|datadog|newrelic|fullstory|heap|pendo|optimizely|vwo|ab-tasty|doubleclick|googleadservices|googlesyndication)/i;
    const techStackPattern = /(vercel|netlify|cloudflare|aws|azure|gcp|fastly|akamai|cloudfront|contentful|wordpress|shopify|sanity|strapi|prismic|drupal|squarespace|wix|webflow|nextjs|react|vue|angular|svelte|nuxt|gatsby)/i;

    let processed = 0;
    const total = networkCalls.length;

    for (const call of networkCalls) {
      try {
        const hostname = call.host || new URL(call.url).hostname;
        const pathname = call.pathname || new URL(call.url).pathname;
        const isAnalytics = analyticsPattern.test(hostname) || analyticsPattern.test(pathname);
        const isTechStack = techStackPattern.test(hostname) || techStackPattern.test(pathname);

        if (isAnalytics || isTechStack || processed < 5000) {
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

          const embedding = await this.createEmbedding(apiKey, requestData);
          await this.storeEmbedding(requestData, embedding, sessionId);
          processed++;

          if (processed % 10 === 0) {
            await new Promise(resolve => setTimeout(resolve, 100));
          }
        }
      } catch (e) {
        console.error('Error processing request:', e);
      }
    }

    return { processed, total };
  }

  // Retrieve relevant requests for analysis queries
  async retrieveForAnalysis(apiKey, queries, sessionId) {
    const results = {
      analytics: [],
      techStack: [],
      allRelevant: []
    };

    // Create embeddings for each query
    for (const query of queries) {
      const queryEmbedding = await this.createEmbedding(apiKey, { 
        host: query, 
        pathname: '', 
        method: 'GET' 
      });

      // Increase results for analytics queries, use much lower threshold for analytics
      const limit = query.toLowerCase().includes('analytics') ? 500 : 50; // Increased from 200 to 500
      const similar = await this.searchSimilar(queryEmbedding, sessionId, limit);
      
      for (const item of similar) {
        // Much lower threshold for analytics to capture ALL events
        const isAnalytics = /(google-analytics|analytics\.google|googletagmanager|gtag|gtm|segment|mixpanel|amplitude|hotjar|clarity|hubspot|adroll|facebook|meta|tiktok)/i.test(item.host);
        const threshold = isAnalytics ? 0.1 : 0.4; // Much lower threshold (0.1 instead of 0.25) for analytics
        
        if (item.similarity > threshold) {
          const isTechStack = /(vercel|netlify|cloudflare|aws|azure|gcp|contentful|wordpress|shopify|nextjs|react|vue)/i.test(item.host);

          if (isAnalytics) {
            results.analytics.push(item.requestData);
          } else if (isTechStack) {
            results.techStack.push(item.requestData);
          }
          
          results.allRelevant.push(item.requestData);
        }
      }
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

