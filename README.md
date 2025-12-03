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
- **Gemini 2.5 Flash Integration**: Uses Google's latest AI model for analysis
- **Comprehensive Reports**: Generates detailed markdown summaries
- **CSV Exports**: Exports tech stack and analytics events to CSV files
- **Raw JSON Export**: Download complete network logs for further analysis

### User Experience
- **Persistent State**: Popup state persists across page navigations
- **Real-Time Updates**: Live status updates during crawling
- **Auto-Save API Key**: API key is automatically saved with visual confirmation
- **Modern UI**: Clean, elegant interface with glassmorphism design

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
│   ├── IndexedDB Storage
│   ├── Embedding Generation (Gemini text-embedding-004)
│   ├── Semantic Search
│   └── Intelligent Retrieval
│
└── Popup UI (popup/)
    ├── Configuration Interface
    ├── Status Display
    └── Report Viewer
```

### Data Flow

1. **Crawl Initiation**: User sets depth and starts crawl from popup
2. **Page Navigation**: Background script navigates through discovered links
3. **Network Capture**: Chrome Debugger API intercepts all network requests
4. **Page Interaction**: Content script interacts with page (scroll, click, forms)
5. **RAG Processing**: Network logs are converted to embeddings and stored
6. **Semantic Retrieval**: Relevant requests are retrieved based on queries
7. **AI Analysis**: Gemini analyzes retrieved data and generates report
8. **Export**: Results exported as CSV and markdown

### Key Technologies

- **Chrome Extension Manifest V3**: Modern extension architecture
- **Chrome Debugger API**: Network traffic interception
- **IndexedDB**: Client-side database for RAG embeddings
- **Gemini AI**: 
  - `gemini-2.5-flash` for analysis
  - `text-embedding-004` for embeddings
- **RAG (Retrieval-Augmented Generation)**: Intelligent data filtering

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
   - Set crawl depth (default: 2)
   - Click "Start Full Crawl"
   - The browser will automatically navigate through the site

3. **Wait for Completion**
   - Monitor progress in the popup status
   - The extension will visit pages up to your specified depth
   - Status updates show: pages visited, queue length, current URL

4. **Run AI Analysis**
   - After crawl completes, click "Run AI Analysis"
   - Wait for Gemini to process the data (may take 30-60 seconds)
   - Results will be displayed in the popup
   - CSV files will automatically download:
     - `CAST_tech_stack.csv`
     - `CAST_analytics_events.csv`

5. **Download Raw Data** (Optional)
   - Click "Download Raw JSON" to get complete network logs
   - Useful for custom analysis or debugging

### Advanced Usage

#### Crawl Depth Guidelines

- **Depth 0**: Only the starting page
- **Depth 1**: Starting page + all linked pages
- **Depth 2**: Starting page + 2 levels deep (recommended)
- **Depth 3-5**: Deeper exploration (may take longer)

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

1. **Embedding Creation**: Converts network requests to vector embeddings
2. **Storage**: Stores embeddings in IndexedDB with session tracking
3. **Semantic Search**: Retrieves relevant requests based on similarity
4. **Intelligent Filtering**: Prioritizes analytics and tech stack requests
5. **Token Optimization**: Reduces payload size while maintaining comprehensiveness

### AI Analysis

Gemini 2.5 Flash analyzes:
- **Tech Stack**: Identifies frameworks, hosting, CDN, CMS from network patterns
- **Analytics Events**: Extracts all events including:
  - GA4 batched events (multiple events per request)
  - Scroll events with depth percentages
  - Form submissions and email signups
  - Button clicks and user interactions
  - Search queries
  - Custom events with parameters

### Performance Optimizations

- **Parallel Interactions**: Cookie consent, search, and forms handled simultaneously
- **Smart Timeouts**: 15-second timeout per page prevents hanging
- **Efficient Scrolling**: Optimized scroll intervals for faster crawling
- **Request Deduplication**: Prevents processing duplicate requests
- **Payload Size Management**: Automatic fallback if payload exceeds token limits

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

