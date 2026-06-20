# Social_Media_Lead_Discovery_and_Auto_Posting_Bot

[![Node.js](https://img.shields.io/badge/Node.js-18%2B-green.svg)](https://nodejs.org/)
[![Puppeteer](https://img.shields.io/badge/Puppeteer-21.7-blue.svg)](https://pptr.dev/)
[![MySQL](https://img.shields.io/badge/MySQL-8.0%2B-orange.svg)](https://www.mysql.com/)

> An autonomous, browser-based marketing automation system that discovers potential client leads on Facebook (Groups & Pages) and Quora, extracts their contact information, and auto-posts AI-generated answers to unanswered Quora questions — all driven by a MySQL database of niche-specific keywords.

---

## Table of Contents

1. [Purpose & Overview](#purpose--overview)
2. [System Architecture](#system-architecture)
3. [Mode of Operation](#mode-of-operation)
4. [What It Accomplishes](#what-it-accomplishes)
5. [File Reference](#file-reference)
6. [Database Schema](#database-schema)
7. [Prerequisites](#prerequisites)
8. [Installation](#installation)
9. [Configuration](#configuration)
10. [Authentication & Cookie Management](#authentication--cookie-management)
11. [Running the System](#running-the-system)
12. [Scheduling with Cron](#scheduling-with-cron)
13. [Scaling](#scaling)
14. [Security Considerations](#security-considerations)
15. [Legal & Ethical Considerations](#legal--ethical-considerations)

---

## Purpose & Overview

This system automates lead generation and brand awareness for a business in the **aesthetics / medical aesthetics niche** (the reference implementation targets ETA — Elite Top Aesthetics). It operates continuously in the background as a self-directed marketing agent that:

- **Discovers** relevant Facebook Pages, Groups, and Quora discussions by searching Google and Quora for niche-specific keywords stored in a database.
- **Crawls** discovered pages and extracts profiles of people who comment on or react to posts about related topics.
- **Qualifies** potential leads by checking names and Facebook profile contact sections against an exclusion list of industry professionals (competitors, doctors, clinics, etc.).
- **Records** qualified leads — including name, profile URL, and any discoverable contact info — into MySQL for downstream CRM use.
- **Auto-answers** unanswered Quora questions related to the niche via an external AI chatbot API, with a 24-hour rate limit.

---

## System Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                          MySQL Database                                 │
│                                                                         │
│  ETA_Tags  ◄──────────────────────────────────────────────────────┐    │
│  (niche keywords / search phrases)                                │    │
│                                                                   │    │
│  ETA_Marketing_Relevant_Web_Searches  (Google search terms)       │    │
│                                                                   │    │
│  Discovered_ETA_Relevant_Pages         (FB pages/groups queue)    │    │
│  Discovered_ETA_Relevant_Quora_Pages   (Quora pages queue)        │    │
│  Discovered_ETA_Relevant_Unanswered_Quora_Pages (to answer)       │    │
│                                                                   │    │
│  Discovered_Client_Leads              (output: qualified leads)   │    │
│  params                               (global state: last post)   │    │
└───────────────────┬───────────────────────────────────────────────┘    │
                    │                                                     │
        ┌───────────▼────────────────────────────────┐                   │
        │         PHASE 1: Discovery                  │                   │
        │                                             │                   │
        │  discover-pages4.js  ──► Google → Facebook  │ ──────────────────┘
        │  discover-pages8.js  ──► Quora search       │
        └───────────┬────────────────────────────────┘
                    │  URLs written to DB
        ┌───────────▼────────────────────────────────┐
        │         PHASE 2: Crawl & Extract            │
        │                                             │
        │  crawl-pages42.js (canonical)               │
        │    ├── FB Pages/Groups ──► commenters        │
        │    │     └── visit profiles → contact info   │
        │    │           → save lead                   │
        │    │                                         │
        │    ├── FB Reaction Dialogs (Like/Love/Wow)   │
        │    │     └── reactors → same pipeline        │
        │    │                                         │
        │    ├── Quora answered pages                  │
        │    │     └── extract answerer profiles       │
        │    │                                         │
        │    └── Quora unanswered pages                │
        │          └── POST AI-generated answer        │
        └──────────────────────────────────────────────┘
                    │
        ┌───────────▼────────────────────────────────┐
        │    External AI Chatbot (AI_CHATBOT_URL)     │
        │    Receives question → returns answer text  │
        └─────────────────────────────────────────────┘
```

The system is **entirely driven by a MySQL database**. All configuration, keyword lists, queues, and output are stored there. Puppeteer (headless Chromium) provides the browser automation layer.

---

## Mode of Operation

### Phase 1 — Discovery

**`discover-pages4.js`** performs Google searches for each configured keyword phrase and harvests Facebook URLs from results, storing them in `Discovered_ETA_Relevant_Pages`.

**`discover-pages8.js`** performs Quora searches using each niche keyword, harvesting both standard Quora discussion URLs and `/unanswered/` question URLs, routing them to the appropriate database table.

Both scripts mark each search phrase with a timestamp so it is not re-searched for 7 days.

### Phase 2 — Crawl, Lead Extraction & Quora Posting

**`crawl-pages42.js`** (canonical) is the workhorse. Each invocation:

1. Loads ETA tags from the DB.
2. Randomly selects one of three work queues (FB pages, Quora pages, or unanswered Quora questions).
3. Pulls one uncrawled (or stale) URL from the chosen queue.
4. Launches a headless Chromium browser, loads all three cookie files, and navigates to the URL.

**If the URL is a Facebook page/group:**
- Scrolls the full page to load lazy content.
- Extracts commenter profile URLs and names from comment `div` elements.
- Filters out industry professionals and competitors.
- Navigates to each qualifying commenter's `/about_contact_and_basic_info` page and saves lead data.
- Repeats for users who clicked Like, Love, or Wow reactions (via modal dialogs).

**If the URL is a Quora discussion page (answered):**
- Parses the HTML to extract all Quora profile URLs.
- Filters by name, inserts qualifying profiles as leads.

**If the URL is an unanswered Quora question:**
- Checks `params.last_quora_answer_datetime` — skips if < 24 hours ago.
- Clicks "Answer," captures the question text.
- Fetches an AI-generated answer from the configured `AI_CHATBOT_URL`.
- Returns to the question, pastes the answer, clicks "Post."
- Marks the question answered and updates the timestamp.

### Anti-Detection

- Random delays of 10–20 seconds between navigation actions.
- Cookie-based authentication (no programmatic login per run).
- `autoScroll()` incrementally scrolls pages in 100 px steps (up to 150,000 px cap).

---

## What It Accomplishes

| Capability | Detail |
|---|---|
| Niche-targeted page discovery | Finds FB and Quora pages matching your keyword list via Google and Quora search |
| Automated lead mining | Extracts names and profile URLs of commenters and reactors on relevant content |
| Contact info harvesting | Navigates to each lead's Facebook "Contact and Basic Info" page |
| Competitor/professional filtering | Multi-layer keyword blocklist prevents saving doctors, clinics, spas, etc. |
| ETA Affinity Scoring | Scores each URL by keyword hit count |
| Quora authority building | Auto-posts AI-generated answers to unanswered niche questions (24-hr rate limit) |
| Reaction-based discovery | Captures users who clicked Like, Love, or Wow on relevant posts |
| Deduplication | MySQL `UNIQUE` constraints prevent duplicate leads |
| Re-crawling | Pages older than 15 days are automatically re-queued |

---

## File Reference

```
.
├── .env.example                      ← Copy to .env and fill in credentials
├── .gitignore
├── package.json
│
├── config/
│   ├── db.js                         ← mysql2 promise pool (shared by all scripts)
│   └── logger.js                     ← Winston structured logger with log rotation
│
├── utils/
│   ├── filters.js                    ← isExcluded(), sanitiseName() helpers
│   └── puppeteer.js                  ← sleep(), navigateTo() w/ retry, autoScroll(),
│                                        loadAllCookies(), setViewport()
│
├── discover-pages4.js                ← Discovery: Google → Facebook URL harvesting
├── discover-pages8.js                ← Discovery: Quora search → Quora URL harvesting
│
├── crawl-pages40.js                  ← Crawl v1: basic FB + Quora lead extraction
├── crawl-pages41.js                  ← Crawl v2: adds 24-hr Quora answer gate
├── crawl-pages42.js                  ← Crawl v3 (canonical): full pipeline ✓ USE THIS
│
├── checkCookies2.js                  ← Utility: validate & refresh cookies
├── googleLogin.js                    ← Utility: Google login + save cookies
├── openHeadedInstance.js             ← Utility: open headed browser for inspection
├── openHeadedInstanceWithCookies.js  ← Utility: headed browser + pre-loaded cookies
│
├── keepCrawling.sh                   ← Shell loop: runs crawl-pages42.js continuously
└── cronjobs.txt                      ← Cron schedule definitions
```

**Cookie files** (created at runtime, never commit to git):
- `google_cookies.json`
- `quora_cookies.json`
- `facebook_cookies.json`

---

## Database Schema

```sql
-- Niche keyword/tag list
CREATE TABLE ETA_Tags (
  id INT AUTO_INCREMENT PRIMARY KEY,
  tag VARCHAR(255) UNIQUE NOT NULL,
  searched TINYINT DEFAULT 0,
  Last_Datetime_Searched DATETIME
);

-- Google search phrases for Facebook discovery
CREATE TABLE ETA_Marketing_Relevant_Web_Searches (
  id INT AUTO_INCREMENT PRIMARY KEY,
  search_phrase VARCHAR(500) UNIQUE NOT NULL,
  searched TINYINT DEFAULT 0,
  Last_Datetime_Searched DATETIME
);

-- Discovered Facebook pages/groups queue
CREATE TABLE Discovered_ETA_Relevant_Pages (
  id INT AUTO_INCREMENT PRIMARY KEY,
  page_url VARCHAR(1000) UNIQUE NOT NULL,
  ETA_Affinity INT DEFAULT 0,
  depth INT DEFAULT 0,
  crawled TINYINT DEFAULT 0,
  last_crawl_date DATETIME,
  unreachable TINYINT DEFAULT 0,
  number_of_forms INT DEFAULT 0,
  number_of_emails INT DEFAULT 0
);

-- Discovered Quora discussion pages queue
CREATE TABLE Discovered_ETA_Relevant_Quora_Pages (
  id INT AUTO_INCREMENT PRIMARY KEY,
  page_url VARCHAR(1000) UNIQUE NOT NULL,
  ETA_Affinity INT DEFAULT 0,
  depth INT DEFAULT 0,
  crawled TINYINT DEFAULT 0,
  last_crawl_date DATETIME,
  unreachable TINYINT DEFAULT 0
);

-- Discovered unanswered Quora questions queue
CREATE TABLE Discovered_ETA_Relevant_Unanswered_Quora_Pages (
  id INT AUTO_INCREMENT PRIMARY KEY,
  page_url VARCHAR(1000) UNIQUE NOT NULL,
  ETA_Affinity INT DEFAULT 0,
  depth INT DEFAULT 0,
  crawled TINYINT DEFAULT 0,
  last_crawl_date DATETIME,
  answered TINYINT DEFAULT 0,
  unreachable TINYINT DEFAULT 0
);

-- Output: qualified leads
CREATE TABLE Discovered_Client_Leads (
  id INT AUTO_INCREMENT PRIMARY KEY,
  Full_Name VARCHAR(500),
  Profile_Page VARCHAR(1000) UNIQUE NOT NULL,
  Page_Discovered_In VARCHAR(1000),
  Contact_Info TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Global state (last Quora answer timestamp)
CREATE TABLE params (
  id INT AUTO_INCREMENT PRIMARY KEY,
  last_quora_answer_datetime DATETIME DEFAULT '2000-01-01 00:00:00'
);

INSERT INTO params (last_quora_answer_datetime) VALUES ('2000-01-01 00:00:00');
```

---

## Prerequisites

- **Node.js** v18 or higher
- **npm** v9 or higher
- **MySQL** v8.0 or higher
- A **Google account** (for Google + Quora SSO cookies)
- A **Facebook account** (for Facebook session cookies)
- The **AI chatbot** endpoint configured in `.env` (`AI_CHATBOT_URL`)
- Linux or macOS recommended for cron; WSL works on Windows

---

## Installation

```bash
# 1. Extract the project
unzip ETA_Lead_Bot_Fixed.zip -d Social_Media_Lead_Discovery_and_Auto_Posting
cd Social_Media_Lead_Discovery_and_Auto_Posting

# 2. Copy and fill in credentials
cp .env.example .env
nano .env   # Set DB_HOST, DB_USER, DB_PASS, DB_NAME, AI_CHATBOT_URL

# 3. Install dependencies
npm install

# 4. Create MySQL database and tables
mysql -u root -p -e "CREATE DATABASE ETA_Marketing;"
mysql -u root -p ETA_Marketing < schema.sql   # use SQL above

# 5. Create MySQL user for the bot
mysql -u root -p -e "
  CREATE USER 'eta'@'localhost' IDENTIFIED BY 'your_secure_password';
  GRANT SELECT, INSERT, UPDATE ON ETA_Marketing.* TO 'eta'@'localhost';
  FLUSH PRIVILEGES;
"

# 6. Seed keywords
mysql -u eta -p ETA_Marketing -e "
  INSERT INTO ETA_Tags (tag) VALUES
    ('semaglutide'), ('ozempic'), ('weight loss'),
    ('aesthetics'), ('botox'), ('filler'), ('medspa');
"

# 7. Seed Google search phrases
mysql -u eta -p ETA_Marketing -e "
  INSERT INTO ETA_Marketing_Relevant_Web_Searches (search_phrase) VALUES
    ('semaglutide results'), ('weight loss before after'),
    ('aesthetic treatments near me');
"
```

---

## Configuration

All credentials and settings are read from a `.env` file in the project root. **Never hardcode passwords in source files.**

### `.env` variables

```dotenv
# Database
DB_HOST=localhost
DB_USER=eta
DB_PASS=your_secure_password
DB_NAME=ETA_Marketing

# AI chatbot endpoint — page body must contain the answer text after load
AI_CHATBOT_URL=https://eta.yaitec.dev/?q=

# Optional tuning
LOG_LEVEL=info          # debug | info | warn | error
DELAY_MIN_SEC=10        # minimum delay between navigation actions
DELAY_MAX_SEC=20        # maximum delay between navigation actions
NAV_RETRY_ATTEMPTS=3    # navigation retry attempts before marking URL unreachable
MAX_SCROLL_PX=150000    # autoScroll cap
```

### Exclusion Keywords

Competitor/professional filter keywords are centralised in `utils/filters.js`. Edit `EXCLUDED_SUBSTRINGS` to customize for your niche.

---

## Authentication & Cookie Management

The system uses pre-captured session cookies rather than automating login on every run.

### Initial Cookie Capture

```bash
node checkCookies2.js
```

A Chrome window opens. If no cookies exist, it navigates to each platform's login page and waits for you to log in manually (20-second window). Cookies are then saved to:
- `google_cookies.json`
- `quora_cookies.json`
- `facebook_cookies.json`

### Inspecting a Session

```bash
node openHeadedInstanceWithCookies.js
```

Opens a headed browser pre-loaded with all cookies for manual inspection.

### Cookie Refresh

Re-run `checkCookies2.js` every 2–4 weeks or whenever the bot starts failing authentication. Cookie files contain live session tokens — **never commit them to git** (they are in `.gitignore` by default).

---

## Running the System

### Step 1 — Capture cookies
```bash
node checkCookies2.js
```

### Step 2 — Populate URL queues (Discovery)
```bash
node discover-pages4.js   # Google → Facebook URLs
node discover-pages8.js   # Quora search → Quora URLs
```

### Step 3 — Crawl
```bash
# Single run (one URL processed):
node crawl-pages42.js

# Continuous loop with 10-second pause between runs:
chmod +x keepCrawling.sh
./keepCrawling.sh

# Or via npm scripts:
npm run crawl
```

### Useful npm scripts (defined in package.json)
```bash
npm run crawl            # node crawl-pages42.js
npm run discover:google  # node discover-pages4.js
npm run discover:quora   # node discover-pages8.js
npm run cookies          # node checkCookies2.js
npm run login            # node googleLogin.js
```

---

## Scheduling with Cron

```cron
# Crawl once daily at 7:00 AM
0 7 * * * cd /home/ubuntu/Social_Media_Lead_Discovery_and_Auto_Posting && node crawl-pages42.js >> logs/cron.log 2>&1

# Re-discover Quora pages every Tuesday and Friday at 2:00 AM
0 2 * * 2,5 cd /home/ubuntu/Social_Media_Lead_Discovery_and_Auto_Posting && node discover-pages8.js >> logs/cron.log 2>&1
```

Install with `crontab -e` and paste the above (or use `cronjobs.txt`).

**For continuous crawling via PM2:**
```bash
npm install -g pm2
pm2 start keepCrawling.sh --name Social_Media_Lead_Discovery_and_Auto_Posting
pm2 startup && pm2 save
```

---

## Scaling

### Multiple Parallel Instances

Each run processes exactly **one URL** (LIMIT 1) and sets `crawled = 1` before the browser session begins, so multiple instances can run concurrently without colliding.

```bash
# 3 parallel crawlers:
for i in 1 2 3; do node crawl-pages42.js & done

# Or via PM2:
pm2 start crawl-pages42.js -i 3 --name Social_Media_Lead_Discovery_and_Auto_Posting
```

### More Sources

- Add rows to `ETA_Marketing_Relevant_Web_Searches` for more Google search terms.
- Add rows to `ETA_Tags` for more Quora topics and affinity scoring keywords.

### Multi-Niche

Replicate the DB schema under a different database name and point separate `.env` instances at each.

---

## Security Considerations

- **Never commit** `google_cookies.json`, `quora_cookies.json`, `facebook_cookies.json`, or `.env` — all are in `.gitignore`.
- **Rotate cookies** every 2–4 weeks or after any authentication failure.
- **Run on a dedicated VM** — do not share a browser profile with personal accounts.
- **Use a VPN or residential proxy** to reduce IP-based rate limiting by Facebook and Quora.
- **MySQL user** should have minimal privileges: `SELECT`, `INSERT`, `UPDATE` on `ETA_Marketing.*` only; never use root.
- **`logs/`** may contain scraped names and URLs — apply appropriate access controls on the server.

---

## Legal & Ethical Considerations

> **Important:** This tool automates interactions with third-party platforms (Facebook, Google, Quora). Users are solely responsible for ensuring their use complies with each platform's Terms of Service, as well as applicable data protection laws (GDPR, CCPA, etc.) in their jurisdiction.

- Automated scraping of Facebook and Quora may violate those platforms' ToS.
- Collecting personal data (names, contact info) from social profiles without consent may be subject to privacy regulations.
- Auto-posting AI-generated content must be disclosed where required by platform rules and applicable law.
- This software is provided as-is for educational and research purposes. The author (Fotios Basagiannis) assumes no liability for misuse.

---

## License

MIT — Coded by Fotios Basagiannis
