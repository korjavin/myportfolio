# Competitor Analysis: Investment & Crypto Portfolio Trackers

## 1. Executive Summary
The portfolio tracking software ecosystem spans four main paradigms:
1. **Local-First Open-Source Desktop Apps** (Portfolio Performance, Rotki)
2. **Self-Hosted Open-Source Web Apps** (Ghostfolio, Maybe, Firefly III)
3. **Zero-Knowledge Encrypted SaaS Apps** (Capitally)
4. **Cloud SaaS Platforms** (Sharesight, Delta, Exirio, Snowball Analytics, CoinStats)

---

## 2. Comprehensive Competitor Matrix

| Competitor | Platform / Architecture | Local-First / Privacy | Encryption | Target Focus | Mobile UX | Key Weakness / Pain Point |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **Portfolio Performance** | Desktop (Java/Eclipse) | 100% Local-First | Optional AES-256 `.portfolio` file encryption | Stocks, ETFs, Crypto, Dividends | Weak (Desktop-first; viewer app only) | Heavy desktop app, complex UI, difficult mobile editing |
| **Ghostfolio** | Web (Node.js/Angular/Docker) | Self-Hosted / Privacy-first | Database level (PostgreSQL) / SSL | Multi-asset personal finance | Excellent (Responsive Web App / PWA) | Requires server/Docker host setup for full privacy |
| **Rotki** | Desktop (Python/Electron) | 100% Local-First | Encrypted local DB (SQLCipher / AES) | Crypto, DeFi, Staking, TradFi | Moderate (Desktop app) | Heavy desktop framework, UI focused heavily on crypto |
| **Capitally** | Web Application | Zero-Knowledge Cloud | Client-side AES-GCM 256-bit E2EE | Multi-asset wealth management | High (Mobile-optimized web) | Closed-source commercial SaaS model |
| **Sharesight** | Cloud SaaS | Managed Cloud | SOC 2 Type 2, TLS 1.3, AES-256 at rest | Stock performance, Dividend tax reports | Good (Web & Mobile app) | Proprietary cloud storage; subscriptions can be expensive |
| **Delta** | Mobile App (iOS/Android) | Cloud-synced | Standard cloud TLS / storage encryption | Crypto & Stock portfolio tracking | Native Mobile (Polished UI) | Closed source, cloud-dependent, monetization popups |
| **Snowball Analytics** | Cloud SaaS | Cloud-synced | Cloud standard encryption | Dividend growth investing & rebalancing | Responsive Web & Mobile | Data stored on third-party cloud servers |
| **Firefly III** | Web (PHP/Laravel/Docker) | Self-Hosted | Database encryption | Personal budgeting & transactions | Responsive Web | Budget/expense focused, weak investment analytics |

---

## 3. Deep Dive into Top Competitors

### 3.1 Ghostfolio (Open-Source Web Alternative)
- **Architecture:** TypeScript/Node.js backend with PostgreSQL database and Angular frontend. Fully containerized with Docker.
- **Strengths:** 
  - Privacy-first mindset: optional anonymous account creation (no email required).
  - Modern web interface with clean performance charts, asset allocation breakdown, and benchmark comparison.
  - Supports stocks, ETFs, and cryptocurrencies via Yahoo Finance & CoinGecko APIs.
- **Privacy & Security:** Data is as private as your host environment. Supports self-hosting, keeping data off commercial cloud platforms.
- **Limitation for Mobile/Local-First:** Requires maintaining a self-hosted Docker server; not a zero-setup local-browser app.

### 3.2 Rotki (Crypto & Web3 Privacy Specialist)
- **Architecture:** Python backend with Electron desktop UI. Uses SQLCipher for local database encryption.
- **Strengths:**
  - True zero-knowledge client architecture: data never leaves the device.
  - Deep integrations with Ethereum, EVM chains, Bitcoin, CEX APIs (Kraken, Binance, Coinbase), and DeFi protocols.
- **Privacy & Security:** All API keys, balances, and history are encrypted locally with a master passphrase.
- **Limitation:** Heavily crypto-centric; high memory overhead due to Electron.

### 3.3 Capitally (Zero-Knowledge Web Model)
- **Architecture:** Web application utilizing client-side Web Crypto API for zero-knowledge end-to-end encryption.
- **Strengths:**
  - Data is encrypted in the browser before being stored locally or synced.
  - Clean, modern touch interface designed for mobile and desktop.
  - Supports offline editing with local storage fallback.
- **Privacy & Security:** Zero-knowledge model ensures that even server operators cannot view portfolio holdings or monetary values.

### 3.4 Sharesight & Snowball Analytics (Cloud Leaders)
- **Strengths:** Excellent dividend tracking, tax loss harvesting reports, and automated broker data feeds.
- **Weakness:** Third-party cloud custody of financial data, subscriptions cost up to $30–$50/month.

---

## 4. Key Takeaways for Our Web App Alternative

1. **Market Gap:** There is a clear market opportunity for a **zero-setup, lightweight, local-first web app (PWA)** that combines Portfolio Performance's analytical depth (TTWROR, IRR, rebalancing) with Ghostfolio's clean UI and Capitally's client-side zero-knowledge security.
2. **Mobile Optimization:** Mobile users want rapid load times, quick transaction logging, touch-friendly charts, offline capabilities, and instant balance updates.
3. **Data Portability:** Seamless import/export compatibility with Portfolio Performance CSV/XML formats lowers switching friction for power users.
