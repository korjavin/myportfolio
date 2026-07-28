# Project Vision & Blueprint: Lightweight Local-First Mobile Web App

## 1. Executive Summary
This document outlines the architectural plan for building a lightweight, mobile-first, local-first alternative to Portfolio Performance. The goal is to deliver the mathematical rigor and privacy of Portfolio Performance in a fast, mobile-friendly Web Application (PWA) with zero mandatory cloud dependencies or heavy desktop runtimes.

---

## 2. Core Architectural Principles

1. **Mobile-First & Touch Optimized:** Instant startup (<1s), fluid 60fps charts, responsive touch interactions, bottom navigation bar, card-based layouts, and quick-add transaction buttons.
2. **100% Local-First Data Ownership:** All portfolio data (securities, transactions, accounts, dividends) is stored locally in the browser's IndexedDB. No external account or server required.
3. **Zero-Knowledge Web Encryption:** Optional master passcode protection using Web Crypto API (`AES-256-GCM` + `PBKDF2`), encrypting data at rest on device and in transit during optional backup syncs.
4. **Portfolio Performance Interoperability:** Native import support for Portfolio Performance XML/CSV export files so users can transition seamlessly without re-entering history.
5. **Real-Time & Offline Quote Engine:** Fetches price quotes for crypto (CoinGecko / Binance) and stocks (Yahoo Finance / Financial APIs) directly from client browser, caching quotes for offline access.

---

## 3. High-Level System Architecture

```
+-------------------------------------------------------------------------------+
|                             MOBILE WEB APP / PWA UI                           |
|  [Dashboard]   [Holdings]   [Analytics]   [Transactions]   [Rebalancing]      |
+---------------------------------------+---------------------------------------+
                                        |
                                        v
+-------------------------------------------------------------------------------+
|                       PORTFOLIO CORE ENGINE (In-Memory)                       |
|  - TTWROR & IRR Math Calculator Engine                                        |
|  - Currency Conversion Engine (ECB / FX Rates)                                |
|  - Asset Allocation & Taxonomy Rebalancer                                     |
+---------------------------------------+---------------------------------------+
                                        |
                   +--------------------+--------------------+
                   |                                         |
                   v                                         v
+----------------------------------+       +-----------------------------------+
|     WEB CRYPTO SECURITY LAYER    |       |      MARKET DATA QUOTE ENGINE     |
| - AES-256-GCM Local Encryption   |       | - CoinGecko API (Crypto)          |
| - WebAuthn / Biometric Lock      |       | - Yahoo Finance / FMP (Stocks)    |
+------------------+---------------+       +-----------------+-----------------+
                   |                                         |
                   v                                         v
+----------------------------------+       +-----------------------------------+
|      BROWSER LOCAL STORAGE       |       |     IMPORT & INTEROPERABILITY     |
| - IndexedDB (Portfolio DB)       |       | - Portfolio Performance XML/CSV   |
| - Service Worker (Offline Cache) |       | - Generic Transaction CSV Importer|
+----------------------------------+       +-----------------------------------+
```

---

## 4. Key Feature Roadmap

### Phase 1: Core Foundation & Data Engine
- **Local Database Setup:** IndexedDB schema for Accounts, Securities, Transactions, Prices, and Taxonomies.
- **PP XML/CSV Importer:** Parse Portfolio Performance export files to populate securities, historical trades, and dividends.
- **Crypto & Stock Price Quotes:** Client-side fetchers for CoinGecko & Yahoo Finance APIs.

### Phase 2: Analytics & Math Calculation Engine
- **Performance Calculation:** True Time-Weighted Rate of Return (TTWROR) & Money-Weighted Rate of Return (IRR).
- **Holdings & Allocation:** Live valuation, total profit/loss, daily gain/loss, asset class breakdown pie/donut charts.
- **Multi-Currency Support:** Convert portfolio values to user's preferred reporting currency (USD, EUR, CHF, GBP).

### Phase 3: Mobile UX & Security Polish
- **Mobile PWA:** Manifest, Service Worker offline caching, installation banner for iOS & Android.
- **Client Encryption & Passcode:** Master password protection with AES-256-GCM encryption.
- **Rebalancing Tool:** Target asset allocation manager with trade recommendations.
- **Dark Mode & Aesthetics:** Modern glassmorphism UI with fluid animations.

---

## 5. Technology Stack Recommendation

- **UI Framework:** Vite + React + TypeScript
- **Styling:** Vanilla CSS design tokens & modular CSS (clean, fast, responsive)
- **Database:** Dexie.js (IndexedDB wrapper)
- **Charts:** Recharts / Lightweight Charts (Fast, mobile responsive canvas/SVG charting)
- **Encryption:** Native Browser Web Crypto API (`window.crypto.subtle`)
- **PWA:** Vite PWA Plugin / Service Worker
