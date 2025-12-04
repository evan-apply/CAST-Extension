# CAST 3.2 – Auto Crawler + AI Network Recon

**CAST** (Crawl, Analyze, Summarize, Transform) is a powerful Chrome extension that automatically crawls websites, captures network traffic, and uses AI to analyze and summarize the technology stack and analytics events.

## 🎯 Introduction

CAST is designed for web analysts, developers, and digital agencies who need to quickly understand:
- **Technology Stack**: What frameworks, hosting, CDN, and CMS platforms a website uses
- **Analytics Events**: Comprehensive tracking of all analytics events including GA4, GTM, Segment, HubSpot, and more
- **User Interactions**: Captures scroll events, form submissions, button clicks, and search queries

The extension uses **Retrieval-Augmented Generation (RAG)** with Google's Gemini AI to intelligently analyze network traffic and provide detailed insights.

## ✨ Features

### Automated Web Crawling
- **Breadth-First Search (BFS)**: Systematically explores websites by depth
- **Configurable Depth**: Set crawl depth from 0-5 levels
- **Smart Deduplication**: Prevents visiting the same page multiple times
- **URL Normalization**: Handles query parameters and fragments intelligently

### Intelligent Network Analysis
- **RAG-Powered**: Uses semantic search to retrieve only relevant network requests
- **Comprehensive Capture**: Captures all analytics events, tech stack indicators, and user interactions
- **Token Optimization**: Handles large datasets efficiently using embeddings and intelligent filtering

### Interactive Page Engagement
- **Auto-Scroll**: Automatically scrolls through pages to trigger lazy-loaded content
- **Clickable Element Detection**: Highlights and clicks all clickable elements
- **Form Interactions**: 
  - Automatically accepts cookie consent banners
  - Fills search boxes with "Test"
  - Submits email subscription forms with `analytics@applydigital.com`
- **Event Triggering**: Generates analytics events through realistic user interactions

### AI-Powered Analysis
- **Gemini 3 Pro Preview Integration**: Uses Google's latest AI model for analysis
- **Comprehensive Reports**: Generates detailed markdown summaries
- **CSV Exports**: Exports tech stack and analytics events to CSV files
- **Raw JSON Export**: Download complete network logs for further analysis

### User Experience
- **Persistent State**: Popup state persists across page navigations
- **Real-Time Updates**: Live status updates during crawling
- **Progress Tracking**: Real-time progress bar during AI analysis with embedding creation status
- **Auto-Save API Key**: API key is automatically saved with visual confirmation
- **Modern UI**: Clean, elegant interface with glassmorphism design
- **Page Limit Control**: Set crawl limits (10, 50, or All pages) to control crawl duration

### Data Persistence
- **IndexedDB Storage**: All network calls and RAG embeddings stored persistently
- **Survives Reloads**: Data persists across extension reloads and browser restarts
- **Download Anytime**: Download raw network calls during or after crawl completion
- **Session Management**: Track multiple crawl sessions with unique session IDs

## 🏗️ Architecture

### Components

```
CAST Extension
├── Background Service Worker (background.js)
│   ├── Crawl Orchestration
│   ├── Network Traffic Capture (Chrome Debugger API)
│   ├── RAG System Integration
│   └── Gemini AI Analysis
│
├── Content Script (content/crawler.js)
│   ├── Page Interaction Engine
│   ├── Clickable Element Detection
│   ├── Form & Search Automation
│   └── DOM Analysis
│
├── RAG System (rag.js)
│   ├── IndexedDB Storage (CAST_RAG_DB)
│   ├── Embedding Generation (Gemini text-embedding-004)
│   ├── Parallel Batch Processing (15 concurrent embeddings)
│   ├── Persistent Embedding Cache
│   ├── Semantic Search
│   └── Intelligent Retrieval
│
├── Network Calls Storage
│   ├── IndexedDB (CAST_NetworkCalls_DB)
│   ├── Incremental Saving
│   └── Session-Based Organization
│
└── Popup UI (popup/)
    ├── Configuration Interface
    ├── Status Display
    └── Report Viewer
```

### Data Flow

1. **Crawl Initiation**: User sets depth and page limit, starts crawl from popup
2. **Page Navigation**: Background script navigates through discovered links
3. **Network Capture**: Chrome Debugger API intercepts all network requests
4. **Incremental Storage**: Network calls saved to IndexedDB as they arrive
5. **Page Interaction**: Content script interacts with page (scroll, click, forms)
6. **RAG Processing**: Network logs filtered and converted to embeddings in parallel batches
7. **Semantic Retrieval**: Relevant requests retrieved using parallel query processing
8. **AI Analysis**: Gemini analyzes retrieved data and generates report
9. **Export**: Results exported as CSV and markdown
10. **Data Persistence**: All data remains accessible after crawl completion

### Key Technologies

- **Chrome Extension Manifest V3**: Modern extension architecture
- **Chrome Debugger API**: Network traffic interception
- **IndexedDB**: 
  - `CAST_RAG_DB`: RAG embeddings and cache storage
  - `CAST_NetworkCalls_DB`: Persistent network calls storage
- **Gemini AI**: 
  - `gemini-3-pro-preview` for high-context analysis batches
- **RAG (Retrieval-Augmented Generation)**: Intelligent data filtering with parallel processing
- **Parallel Processing**: Concurrent embedding creation and query processing for 20x speedup

## 📦 Installation

### Prerequisites

- Google Chrome or Chromium-based browser
- Google Gemini API key ([Get one here](https://makersuite.google.com/app/apikey))

### Steps

1. **Clone or Download** this repository
   ```bash
   git clone <repository-url>
   cd CAST
   ```

2. **Open Chrome Extensions Page**
   - Navigate to `chrome://extensions/`
   - Enable "Developer mode" (toggle in top-right)

3. **Load Extension**
   - Click "Load unpacked"
   - Select the CAST directory

4. **Get API Key**
   - Visit [Google AI Studio](https://makersuite.google.com/app/apikey)
   - Create a new API key
   - Copy the key

5. **Configure Extension**
   - Click the CAST extension icon
   - Paste your Gemini API key (auto-saves)
   - Set your desired crawl depth (0-5)

## 🚀 How to Use

### Basic Workflow

1. **Navigate to Target Website**
   - Open the website you want to analyze in Chrome
   - Ensure you're on the page you want to start crawling from

2. **Start Crawl**
   - Click the CAST extension icon
   - Verify your API key is saved (checkmark visible)
   - Set crawl depth (default: 2, range: 0-5)
   - Set page limit (10, 50, or All pages)
   - Click "Start Full Crawl"
   - The browser will automatically navigate through the site

3. **Wait for Completion**
   - Monitor progress in the popup status
   - The extension will visit pages up to your specified depth
   - Status updates show: pages visited, queue length, current URL

4. **Run AI Analysis**
   - After crawl completes (or during crawl), click "Run AI Analysis"
   - Watch progress bar showing embedding creation status
   - Progress updates in real-time: "Processing X of Y network calls..."
   - Wait for Gemini to process the data (optimized: 50 seconds - 3 minutes for 5K-20K calls)
   - Results will be displayed in the popup
   - CSV files will automatically download:
     - `CAST_tech_stack.csv`
     - `CAST_analytics_events.csv`

5. **Download Raw Data** (Anytime)
   - Click "Download Raw Network Calls" to get complete network logs
   - Works during crawl, after crawl stops, or after extension reload
   - Data is persistently stored in IndexedDB
   - Useful for custom analysis or debugging

### Advanced Usage

#### Crawl Configuration

**Crawl Depth Guidelines:**
- **Depth 0**: Only the starting page
- **Depth 1**: Starting page + all linked pages
- **Depth 2**: Starting page + 2 levels deep (recommended)
- **Depth 3-5**: Deeper exploration (may take longer)

**Page Limit Options:**
- **10 Pages**: Quick analysis of key pages
- **50 Pages**: Comprehensive analysis for medium sites
- **All Pages**: Complete crawl (no limit, respects depth setting)

#### Understanding Results

**Tech Stack CSV** includes:
- Technology name
- Category (framework, CDN, CMS, etc.)
- Confidence score (0.0 - 1.0)
- Evidence (URLs, headers, query params)

**Analytics Events CSV** includes:
- Provider (GA4, GTM, Segment, etc.)
- Event name
- Page URL where event was captured
- Request URL
- Additional notes/parameters

## 🔧 Technical Details

### Network Capture

The extension uses Chrome's Debugger API to intercept:
- All HTTP/HTTPS requests
- Request headers and query parameters
- POST body data (up to 10MB)
- Response status and headers
- Request/response matching by requestId

### RAG System

The RAG (Retrieval-Augmented Generation) system:

1. **Pre-Filtering**: Filters out static assets and non-essential requests before processing
2. **Parallel Embedding Creation**: Processes 15 embeddings concurrently (20x faster)
3. **Persistent Cache**: Stores embeddings in IndexedDB for reuse across sessions
4. **Storage**: Stores embeddings in IndexedDB (`CAST_RAG_DB`) with session tracking
5. **Parallel Query Processing**: All 14 semantic queries processed simultaneously
6. **Semantic Search**: Retrieves relevant requests based on cosine similarity
7. **Intelligent Filtering**: Prioritizes analytics and tech stack requests
8. **Token Optimization**: Reduces payload size while maintaining comprehensiveness

**Performance:**
- **Before**: 5,000 calls × 200ms = ~17 minutes
- **After**: 5,000 calls ÷ 15 parallel × 200ms = ~50 seconds
- **Speedup**: ~20x faster for embedding creation

### AI Analysis

Gemini 3 Pro Preview analyzes:
- **Tech Stack**: Identifies frameworks, hosting, CDN, CMS from network patterns
- **Analytics Events**: Extracts all events including:
  - GA4 batched events (multiple events per request)
  - Scroll events with depth percentages
  - Form submissions and email signups
  - Button clicks and user interactions
  - Search queries
  - Custom events with parameters

### Performance Optimizations

**Crawl Optimizations:**
- **Parallel Interactions**: Cookie consent, search, and forms handled simultaneously
- **Smart Timeouts**: 15-second timeout per page prevents hanging
- **Efficient Scrolling**: Optimized scroll intervals for faster crawling
- **Request Deduplication**: Prevents processing duplicate requests

**RAG Optimizations:**
- **Parallel Batch Processing**: 15 concurrent embedding API calls
- **Persistent Embedding Cache**: Reuses embeddings across sessions (IndexedDB)
- **Pre-Filtering**: Removes static assets before embedding creation
- **Parallel Query Processing**: All semantic queries run simultaneously
- **Incremental Storage**: Network calls saved to IndexedDB as they arrive

**AI Analysis Optimizations:**
- **Payload Size Management**: Automatic fallback if payload exceeds token limits
- **Smart Deduplication**: Aggressive deduplication for large datasets
- **Progress Tracking**: Real-time progress updates during processing

## 📁 Project Structure

```
CAST/
├── manifest.json              # Extension manifest (Manifest V3)
├── background.js              # Service worker (crawl orchestration, network capture, AI)
├── rag.js                     # RAG system (embeddings, semantic search)
├── content/
│   ├── crawler.js            # Content script (page interactions, DOM analysis)
│   └── highlight.css         # Styles for clickable element highlighting
└── popup/
    ├── popup.html            # Popup UI structure
    └── popup.js              # Popup logic (user interactions, state management)
```

## 🔒 Permissions

The extension requires the following permissions:

- **`debugger`**: Intercept network traffic
- **`tabs`**: Navigate and manage tabs
- **`activeTab`**: Access current tab
- **`scripting`**: Inject content scripts
- **`storage`**: Save API key and crawl state
- **`<all_urls>`**: Access network requests from any website

## ⚠️ Limitations & Considerations

1. **API Costs**: Gemini API usage incurs costs based on token usage
2. **Crawl Speed**: Depends on page load times and network conditions
3. **Single Domain**: Crawls are limited to the same origin as the starting page
4. **JavaScript-Heavy Sites**: Some SPAs may require additional time for content to load
5. **Rate Limiting**: Some websites may rate-limit automated requests

## 🐛 Troubleshooting

### Extension Not Working

1. **Check API Key**: Ensure Gemini API key is valid and saved
2. **Reload Extension**: Go to `chrome://extensions/` and click reload
3. **Check Console**: Open DevTools (F12) and check for errors
4. **Permissions**: Ensure extension has necessary permissions

### Crawl Not Starting

1. **Verify Tab**: Ensure you're on a valid HTTP/HTTPS page
2. **Check Debugger**: Extension needs debugger permission (granted automatically)
3. **Content Script**: Check if content script is loading (console logs)

### AI Analysis Failing

1. **API Key**: Verify API key is correct and has quota
2. **Token Limits**: Very large sites may exceed token limits (extension handles this automatically)
3. **Network**: Check internet connection

### Missing Analytics Events

1. **Cookie Consent**: Extension auto-accepts, but some sites may require manual consent
2. **JavaScript**: Ensure JavaScript is enabled
3. **Page Load**: Wait for page to fully load before starting crawl

## 🔍 Accessing IndexedDB Data

CAST stores all data in IndexedDB for persistence and inspection. Here's how to access it:

### Step-by-Step Guide

1. **Open Chrome Extensions Page**
   - Navigate to `chrome://extensions/`
   - Enable "Developer mode" (toggle in top-right)

2. **Open Background Page DevTools**
   - Find "CAST 3.2" extension
   - Click the "service worker" link (or "background page")
   - DevTools will open for the background script

3. **Access IndexedDB**
   - Click the **Application** tab in DevTools
   - In the left sidebar, expand **Storage** → **IndexedDB**
   - You'll see two databases:
     - **`CAST_RAG_DB`**: RAG embeddings and cache
     - **`CAST_NetworkCalls_DB`**: Network calls storage

4. **View Data**
   - Expand a database → object store (e.g., `embeddings`, `networkCalls`)
   - Click the object store name to view all records
   - Use the search box to filter records

### Database Structure

**CAST_RAG_DB:**
- `embeddings`: Network request embeddings with vector data
- `embeddingCache`: Cached embeddings (persistent across sessions)
- `sessions`: Crawl session metadata

**CAST_NetworkCalls_DB:**
- `networkCalls`: All captured network requests
  - Fields: `sessionId`, `pageUrl`, `url`, `method`, `host`, `pathname`, `queryParams`, `postData`, `timestamp`

### Console Commands

In the background page console, you can run:

**Get Current Session ID:**
```javascript
chrome.storage.local.get(['CAST_currentSessionId'], (res) => {
  console.log('Session ID:', res.CAST_currentSessionId);
});
```

**Count Total Embeddings:**
```javascript
(async () => {
  const db = await new Promise((r, e) => {
    const req = indexedDB.open('CAST_RAG_DB', 1);
    req.onsuccess = () => r(req.result);
    req.onerror = () => e(req.error);
  });
  const tx = db.transaction(['embeddings'], 'readonly');
  const count = await new Promise(r => {
    tx.objectStore('embeddings').count().onsuccess = e => r(e.target.result);
  });
  console.log('Total embeddings:', count);
})();
```

**Count Total Network Calls:**
```javascript
(async () => {
  const db = await new Promise((r, e) => {
    const req = indexedDB.open('CAST_NetworkCalls_DB', 1);
    req.onsuccess = () => r(req.result);
    req.onerror = () => e(req.error);
  });
  const tx = db.transaction(['networkCalls'], 'readonly');
  const count = await new Promise(r => {
    tx.objectStore('networkCalls').count().onsuccess = e => r(e.target.result);
  });
  console.log('Total network calls:', count);
})();
```

**Get All Session IDs:**
```javascript
(async () => {
  const db = await new Promise((r, e) => {
    const req = indexedDB.open('CAST_RAG_DB', 1);
    req.onsuccess = () => r(req.result);
    req.onerror = () => e(req.error);
  });
  const tx = db.transaction(['embeddings'], 'readonly');
  const all = await new Promise(r => {
    tx.objectStore('embeddings').getAll().onsuccess = e => r(e.target.result);
  });
  const sessions = [...new Set(all.map(r => r.sessionId))];
  console.log('All session IDs:', sessions);
})();
```

### Exporting Data

1. In DevTools Application tab
2. Right-click on an object store (e.g., `networkCalls`)
3. Select "Export" or "Save as..." (if available)
4. Save as JSON file

## 📝 License

This project is built by **Apply Digital**.

Built with ❤️ by Apply Digital

## 🤝 Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## 📧 Support

For issues, questions, or feature requests, please open an issue on the repository.

---

**Version**: 3.2.0  
**Last Updated**: 2024

## 🚀 Recent Updates

### Version 3.2.0 Features

- ✅ **Persistent IndexedDB Storage**: Network calls and embeddings persist across reloads
- ✅ **Parallel Processing**: 20x faster embedding creation with concurrent API calls
- ✅ **Progress Tracking**: Real-time progress bar during AI analysis
- ✅ **Page Limit Control**: Set crawl limits (10, 50, All pages)
- ✅ **Persistent Embedding Cache**: Reuses embeddings across sessions
- ✅ **Pre-Filtering**: Smart filtering before RAG processing
- ✅ **Download Anytime**: Download network calls during or after crawl
- ✅ **Session Management**: Track multiple crawl sessions

