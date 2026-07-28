# Portfolio Performance: Deep Feature & Architecture Analysis

## 1. Overview
**Portfolio Performance (PP)** is a free, open-source, desktop-based investment tracking tool available for macOS, Windows, and Linux. Created by Andreas Buchen, it has established itself as the open-source benchmark for investment performance analytics, catering to self-directed investors, dividend trackers, stock/ETF collectors, and crypto holders.

While immensely powerful and mathematically rigorous, its desktop-first architecture (built on Java / Eclipse RCP) makes it heavy, complex, and unoptimized for mobile touchscreens or seamless cross-device local synchronization.

---

## 2. Core Features & Capabilities

### 2.1 Mathematical & Analytical Metrics
- **Time-Weighted Rate of Return (TTWROR / True Time-Weighted Rate of Return):** Eliminates the distortion caused by external cash inflows and outflows, reflecting pure investment performance.
- **Internal Rate of Return (IRR / Money-Weighted Return):** Accounts for both timing and magnitude of cash deposits and withdrawals (yields real annualized return).
- **Absolute & Relative Performance:**
  - Absolute Gain / Loss ($ / €)
  - Realized vs. Unrealized Capital Gains
  - Dividend Yields and Cumulative Payouts
  - Absolute delta against reference benchmarks (e.g., S&P 500, MSCI World, Bitcoin).
- **Risk Metrics:**
  - Standard Deviation (Volatility)
  - Sharpe Ratio
  - Maximum Drawdown (MDD)
  - Value at Risk (VaR)

### 2.2 Asset Classes & Multi-Currency Support
- **Supported Instruments:** Stocks, ETFs, Mutual Funds, Cryptocurrencies, Bonds, Commodities, Forex, Cash / Bank Accounts.
- **Multi-Currency Engine:** Converts all transactions into a single reporting currency (e.g., USD or EUR) based on historical ECB / Forex exchange rates on the exact transaction date.

### 2.3 Taxonomies & Rebalancing Engine
- **Custom Classification Trees:** Organize holdings by Asset Class (Equity, Crypto, Fixed Income), Geography/Region, Industry Sector, Investment Strategy, or Custom Taxonomies.
- **Target Allocation & Rebalancing:** Set target percentages for each category/asset and generate exact buying/selling rebalancing recommendations based on current market values.

### 2.4 Data Sources & Quote Providers
- **Automated Price Updating:**
  - Yahoo Finance (Historical & Real-time)
  - CoinGecko / Kraken / Coinbase (Crypto price feeds)
  - Alpha Vantage, Financial Modeling Prep
  - HTML Table Scraping & JSON API Parser for custom web data
  - ECB (European Central Bank) currency exchange rates

### 2.5 Importers & Integrations
- **PDF Bank Statement Parser:** Built-in RegEx engines for over 50 European and international broker PDF trade confirmations (e.g., Trade Republic, Scalable Capital, Interactive Brokers, Degiro, Comdirect, DKB).
- **CSV & JSON Import/Export:** Full support for bulk transaction CSV/XML imports and exports.

---

## 3. Privacy, Security & Encryption Features

### 3.1 Architecture Model: Local-First Desktop App
- **Zero Telemetry / Zero Cloud Backend:** Data resides 100% on the user’s local machine. No central user accounts, no tracking, and no external telemetry servers.
- **Direct Client-to-Source Fetching:** Market price updates are fetched directly from market endpoints (Yahoo, CoinGecko) from the client's IP without an intermediary server logging user portfolios.

### 3.2 Encryption & File Storage Formats
Portfolio Performance supports three storage formats:
1. **Unencrypted XML (`.xml`):** Plaintext XML format containing full transaction history, accounts, and securities. Highly readable, easily parseable, but lacks local protection.
2. **Binary Format (`.portfolio`):** Compressed binary format for faster file reading and reduced disk size.
3. **AES-256 Password-Protected Binary:**
   - **Encryption Standard:** Strong AES-256 bit symmetric key encryption.
   - **Key Derivation:** Password-based key derivation (PBKDF2) requiring a user-selected password (minimum 6 characters).
   - **Cloud Sync Compatibility:** Users can store their encrypted `.portfolio` file on user-controlled cloud drives (iCloud, Google Drive, Dropbox, Nextcloud). The cloud provider only sees ciphertext.

---

## 4. Key Limitations & Mobile Pain Points

| Area | Desktop Portfolio Performance | User Friction / Pain Point |
| :--- | :--- | :--- |
| **Runtime & Performance** | Java / Eclipse RCP framework | Heavy RAM footprint (400MB+), slow startup time, heavy desktop application. |
| **Mobile Experience** | Official iOS/Android app exists primarily as a read-only viewer | Requires syncing the `.portfolio` file manually via cloud drives; limited transaction editing; UI not native to modern mobile web apps. |
| **UI / UX Complexity** | Dense desktop grid tables & multi-tab windows | Overwhelming for quick mobile checks; high learning curve for novice investors. |
| **Sync Mechanism** | File-based sync | Requires cloud storage workarounds; prone to file sync conflicts if opened simultaneously on multiple devices. |
