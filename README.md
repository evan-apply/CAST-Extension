# CAST 3.4 – Auto Crawler + AI Network Recon

**CAST** (Crawl, Analyze, Summarize, Transform) is a powerful Chrome extension that captures website network traffic (via automated crawling or manual browsing) and uses AI to analyze and summarize the technology stack and analytics events.

## 🎯 Introduction

CAST is designed for web analysts, developers, and digital agencies who need to quickly understand:
- **Technology Stack**: What frameworks, hosting, CDN, and CMS platforms a website uses
- **Analytics Events**: Comprehensive tracking of all analytics events including GA4, GTM, Segment, HubSpot, and more
- **User Interactions**: Captures scroll events, form submissions, button clicks, and search queries

The extension integrates with **Google's Gemini AI** (Gemini 3 Pro Preview) to intelligently analyze network traffic and provide detailed insights.

## ✨ Features

### 🤖 Automated Web Crawling
- **Breadth-First Search (BFS)**: Systematically explores websites by depth
- **Configurable Depth**: Set crawl depth from 0-5 levels
- **Smart Deduplication**: Prevents visiting the same page multiple times
- **URL Normalization**: Handles query parameters and fragments intelligently

### 🖱️ Manual Mode
- **User-Driven Capture**: Manually browse and interact with complex flows (login, checkout, etc.)
- **Seamless Recording**: Captures all network traffic and interactions in the background while you browse
- **Perfect for Authenticated Areas**: Bypass login screens manually and let CAST record the session

### 📈 Analytics Strategy Recommendation (New!)
- **Smart Strategy Generation**: Analyzes the current page's structure (DOM) using AI to recommend a tailored analytics tracking plan.
- **Actionable Recommendations**: Suggests specific events to track (e.g., "Track 'Sign Up' button", "Track 'Contact' form") with priority levels.
- **Visual Highlighting**: Click on a recommendation to instantly highlight the corresponding element on the webpage with an overlay.
- **Interactive Guide**: Browse recommendations in the side panel and explore the page interactively.

### 🧠 Intelligent Network Analysis
- **Gemini-Powered**: Uses advanced AI to identify technologies and analytics patterns
- **Comprehensive Capture**: Captures all analytics events, tech stack indicators, and user interactions
- **Smart Batching**: Optimizes data sent to AI to handle large sites without hitting API limits

### 🖥️ Modern UI/UX
- **Side Panel Interface**: Opens in the Chrome Side Panel for a persistent, non-intrusive experience
- **Clean White Theme**: Modern, readable interface with a professional SaaS look
- **Sticky Footer**: "Built with ❤️ by Apply Digital" always visible
- **Responsive Design**: Adjusts to the side panel width

### ⚙️ Interactive Page Engagement (Auto-Crawl)
- **Auto-Scroll**: Automatically scrolls through pages to trigger lazy-loaded content
- **Clickable Element Detection**: Highlights and clicks all clickable elements
- **Form Interactions**: 
  - Automatically accepts cookie consent banners
  - Fills search boxes
  - Submits simple forms
- **Event Triggering**: Generates analytics events through realistic user interactions

### 📊 Reports & Exports
- **Comprehensive AI Reports**: Generates detailed markdown summaries
- **CSV Exports**: 
  - `CAST_tech_stack.csv`: Identified technologies with confidence scores and evidence
  - `CAST_analytics_events.csv`: Detailed analytics events with parameters
  - `CAST_network_calls.csv`: Raw network logs for custom analysis

### 💾 Data Persistence & Privacy
- **IndexedDB Storage**: All network calls stored locally in your browser
- **Session-Only Storage**: Data persists during the session but is **automatically cleared** when you restart the browser for privacy
- **Download Anytime**: Download raw data during or after crawl completion

## 🚀 How to Use

### 1. Configuration
1.  Click the CAST extension icon to open the Side Panel.
2.  Open the **Configuration** section.
3.  Paste your **Gemini API Key** (it auto-saves locally).
4.  Set **Crawl Depth** (default: 2) and **Page Limit**.

### 2. Choose Your Mode

#### Option A: Automated Crawl
1.  Navigate to the target website's home page.
2.  Click **Start Full Crawl**.
3.  The browser will automatically navigate, scroll, and click through the site.
4.  Wait for the "Crawl complete" status.

#### Option B: Manual Mode
1.  Navigate to the target website.
2.  Click **Start Manual Mode**.
3.  Browse the site naturally: log in, click buttons, fill forms, etc.
4.  Click **Stop Manual Mode** when finished.

#### Option C: Strategy Recommendation
1.  Navigate to any page you want to analyze.
2.  Click **Recommend Strategy**.
3.  CAST will analyze the page structure and list recommended tracking events.
4.  **Click on any recommendation** in the list to highlight the element on the page.

### 3. Analyze & Export
1.  Click **Run AI Analysis**.
2.  Watch the progress bar as the extension processes network data in batches.
3.  Once complete, a summary report will appear.
4.  **CSVs will automatically download** (Tech Stack & Analytics Events).
5.  You can also manually click the "Download" buttons to get specific reports.

## 🏗️ Architecture

```
CAST Extension
├── Background Service Worker (background.js)
│   ├── Crawl Orchestration & Manual Mode Logic
│   ├── Network Traffic Capture (Chrome Debugger API)
│   ├── Batch Processing & AI Integration
│   ├── Strategy Generation (Gemini)
│   └── Keep-Alive Mechanism
│
├── Content Script (content/crawler.js)
│   ├── Page Interaction Engine
│   ├── Clickable Element Detection
│   ├── Form & Search Automation
│   ├── Simplified DOM Extraction
│   └── Visual Highlighting System
│
├── Storage
│   ├── IndexedDB (CAST_NetworkCalls_DB): Stores raw network calls & results
│   └── Chrome Storage Local: Stores configuration & state
│
└── UI (popup/)
    ├── Side Panel Layout (popup.html)
    └── Logic (popup.js)
```

## 📦 Installation

1.  **Clone or Download** this repository.
    ```bash
    git clone <repository-url>
    cd CAST
    ```
2.  **Open Chrome Extensions Page**: `chrome://extensions/`
3.  **Enable Developer Mode** (top-right toggle).
4.  **Click "Load unpacked"**.
5.  Select the `CAST` directory.

## 🔒 Permissions

-   **`debugger`**: Intercept network traffic
-   **`sidePanel`**: Display the UI in the browser side panel
-   **`tabs` & `activeTab`**: Navigate and access current pages
-   **`scripting`**: Inject content scripts for interaction
-   **`storage`**: Save API key and state locally
-   **`downloads`**: Save reports to disk
-   **`<all_urls>`**: Analyze any website

## ⚠️ Limitations

1.  **API Costs**: Gemini API usage relies on your personal quota.
2.  **Browser Focus**: While a keep-alive mechanism is in place, keeping the browser open ensures best performance.
3.  **Token Limits**: Extremely large sites may hit AI context limits (handled by intelligent batching).

## 🐛 Troubleshooting

-   **"Failed to fetch" during AI Analysis**: Check your internet connection. The extension automatically retries with backoff.
-   **Extension stops in background**: Open the side panel to ensure the process stays active.
-   **Data missing after restart**: This is intentional. Data is cleared on browser startup to ensure a fresh state.

## 📝 License

Built with ❤️ by **Apply Digital**.

---

**Version**: 3.3.0  
**Last Updated**: Dec 2025
