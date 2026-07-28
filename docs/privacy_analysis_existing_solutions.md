# Existing Solutions Privacy & Telemetry Analysis

This document provides a dedicated analysis of how **Portfolio Performance** and its main competitors handle **user privacy, telemetry, data collection, price API leaks, identity registration, and data custody**.

---

## 1. Executive Privacy Comparison Matrix

| Solution | Code Auditability | Account Requirement | Data Storage Location | Telemetry & Analytics | Price Update Network Privacy | Bank Connection Privacy |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **Portfolio Performance** | Open Source (Eclipse Public License) | **None** (100% Anonymous) | Local File (`.portfolio` / `.xml`) | **Zero Telemetry** in desktop core; minor crash reporting in mobile app | Direct client-to-provider HTTP requests (Yahoo, CoinGecko) | Local PDF/CSV parsing only (No cloud aggregators) |
| **Rotki** | Open Source (AGPLv3) | **None** (Local passphrase) | Local Encrypted DB (SQLCipher) | **Zero Telemetry** | Direct RPC/API calls from local client | Direct blockchain RPC / CEX read-only API keys stored locally |
| **Ghostfolio** | Open Source (AGPLv3) | Optional Anonymous token | Self-Hosted PostgreSQL / Redis | **Zero Telemetry** when self-hosted | Server-side background price fetching (masks individual client IPs) | Manual CSV or manual trade entry |
| **Capitally** | Closed Source | Email Account | Zero-Knowledge Encrypted Cloud Blob | Standard web product analytics | Cloud server handles quote lookups | Manual CSV / broker file import |
| **Delta (eToro)** | Closed Source | Optional mobile / Required for sync | eToro Cloud Servers / Device ID | **Heavy Telemetry** (eToro marketing, Google Analytics, device IDs) | Centralized eToro servers fetch quotes | Exchange API keys stored on device / synced to eToro cloud |
| **Sharesight** | Closed Source | Required Email Account | Sharesight AWS Cloud (Australia/US) | **Heavy Telemetry** (Mixpanel, Google Analytics, marketing cookies) | Sharesight cloud servers fetch all market data | Cloud Open Banking aggregators (Yodlee/Plaid) |
| **Kubera** | Closed Source | Required Email Account | Kubera Cloud Servers | Product analytics & user tracking | Cloud servers fetch portfolio quotes | Third-party cloud aggregators (Plaid, Yodlee, MX) |
| **Snowball Analytics** | Closed Source | Required Email Account | Snowball Cloud Servers | Product & web analytics | Cloud servers aggregate quotes | Cloud aggregators (Plaid/Yodlee) & broker sync |

---

## 2. In-Depth Privacy Breakdown by Solution

### 2.1 Portfolio Performance (PP)
- **Account & Identity:** Requires no account creation, email address, or phone number. Complete anonymity.
- **Data Custody:** All portfolio holdings, cash balances, historical trades, and dividends remain strictly inside local files on your disk.
- **Telemetry & Tracking:**
  - **Desktop App:** Contains **zero tracking, zero analytics code, and zero telemetry**. It does not phone home to any central server.
  - **Mobile Companion App:** Uses basic platform crash logs (Apple App Store / Google Play Console / Sentry) to monitor crash reports, but does not transmit financial data.
- **Price Query Network Privacy:** 
  - Price updates are requested directly from your computer to market APIs (Yahoo Finance, CoinGecko, AlphaVantage, ECB).
  - *Privacy Consideration:* An ISP or network eavesdropper monitoring your unencrypted DNS/HTTP requests could observe which tickers or crypto symbols your IP address is fetching.
- **Bank Credentials:** Does not use cloud bank aggregators. Uses local PDF/CSV statement parsing executed entirely on your machine.

---

### 2.2 Rotki
- **Account & Identity:** No registration or external account required. Access is controlled via a local master password.
- **Data Custody:** All financial data is encrypted locally using SQLCipher (AES-256) on your computer.
- **Telemetry & Tracking:** Built specifically for Web3 privacy advocates. **Zero telemetry, zero user tracking.**
- **Price Query Network Privacy:** Direct requests from local client to CoinGecko or self-hosted Ethereum/Bitcoin RPC nodes.
- **Exchange API Keys:** Read-only API keys for crypto exchanges (Kraken, Binance, Coinbase) are stored strictly inside the local encrypted database.

---

### 2.3 Ghostfolio
- **Account & Identity:** Allows anonymous login using a generated random security key. No email required.
- **Data Custody:** In self-hosted mode (via Docker), data stays 100% on your own server inside PostgreSQL.
- **Telemetry & Tracking:** Self-hosted deployments do not send tracking data to Ghostfolio maintainers.
- **Price Query Network Privacy:** The backend server fetches market price updates for all securities. This acts as a privacy proxy—individual client devices do not directly query Yahoo or CoinGecko, preventing price providers from linking your personal IP address to specific tickers.

---

### 2.4 Delta Investment Tracker (by eToro)
- **Account & Identity:** Can be used without an account on mobile, but full cross-device sync requires registering with eToro.
- **Data Custody:** Cloud-synced data is managed within eToro's cloud infrastructure.
- **Telemetry & Data Collection:**
  - Integrates third-party ad networks, device fingerprinting, and behavioral telemetry for user profiling and eToro cross-marketing.
  - User activity, asset preferences, and interaction logs are governed by eToro's commercial privacy policy.
- **Price Query & Exchange API:** Ticker data and exchange integrations pass through eToro backend services.

---

### 2.5 Sharesight, Kubera & Snowball Analytics (Traditional Cloud SaaS)
- **Account & Identity:** Mandatory registration (Email, Name, Payment billing details).
- **Data Custody:** Financial portfolio records, cost basis, dividend data, and trade histories are stored unencrypted (or encrypted with vendor-managed keys) in vendor cloud databases (AWS/GCP).
- **Telemetry & Ad Tracking:** Full web analytics suites (Mixpanel, Segment, Google Analytics, Facebook Pixel) are active on marketing and app dashboards.
- **Financial Aggregators (Plaid/Yodlee/MX):**
  - Use cloud aggregators to sync bank and brokerage accounts automatically.
  - *Privacy Risk:* Users must share financial institution credentials or OAuth tokens with third-party aggregators. Aggregators store account balances, transaction histories, and personal identifiers on their servers.

---

## 3. Privacy & Leak Risks of Market Price Providers

Even for local-first apps like Portfolio Performance, price updating can present subtle privacy risks:

```
[Local Device IP: 192.168.1.50]
        |
        |---> Direct GET request to api.coingecko.com/v3/simple/price?ids=bitcoin,ethereum
        |---> Direct GET request to query1.finance.yahoo.com/v7/finance/quote?symbols=AAPL,TSLA,MSFT
        |
        v
[Third-Party Provider (Yahoo / CoinGecko)]
- Sees User IP address
- Sees list of requested stock/crypto symbols
- Can potentially map IP address -> Specific portfolio holding interests over time
```

### How Our Local-First Web App Solution Resolves This:
1. **Randomized / Batched Quote Fetching:** Batch ticker requests alongside popular index proxies (e.g., S&P 500, BTC) to obscure specific holdings.
2. **Optional Proxy / CORS Gateway:** Allow users to route price requests through an encrypted proxy or custom CORS proxy to hide client IP addresses.
3. **Local Caching:** Cache historical price records in IndexedDB to minimize external network requests.
