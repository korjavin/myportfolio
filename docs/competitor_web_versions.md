# Web Versions Analysis: Portfolio Performance & Competitors

This document analyzes the availability, architecture, mobile responsiveness, and privacy implications of **web versions** for Portfolio Performance and its main market competitors.

---

## 1. Web Version Availability & Architecture Matrix

| Solution | Web Version Available? | Architecture Type | Mobile Web Responsiveness | Self-Hostable? | Offline Web Support (PWA) |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Portfolio Performance** | ❌ **No Official Web Version** | Desktop Java App (Workaround: Docker VNC/x11vnc stream) | ❌ Poor (VNC stream desktop GUI) | ❌ No native web backend | ❌ No |
| **Ghostfolio** | ✅ **Yes (Native Web App)** | Node.js + PostgreSQL + Angular PWA | ⭐⭐⭐⭐⭐ Excellent | ✅ Yes (Docker) | ✅ Yes (Service Worker PWA) |
| **Capitally** | ✅ **Yes (Native Web App)** | React + Web Crypto API | ⭐⭐⭐⭐⭐ Excellent | ❌ No (SaaS) | ✅ Yes (Client-side cache) |
| **Sharesight** | ✅ **Yes (Pure Cloud Web)** | SaaS Web Platform (Ruby/React) | ⭐⭐⭐⭐ Good | ❌ No (SaaS) | ❌ No (Requires server connection) |
| **Delta (eToro)** | ✅ **Yes (Web App & Desktop)**| Web Frontend connected to eToro Cloud | ⭐⭐⭐⭐ Good | ❌ No (Proprietary cloud) | ❌ No |
| **Rotki** | ⚠️ **Partial (Local Web Server)** | Python backend + local Web UI / Electron | ⭐⭐⭐ Fair | ✅ Yes (Local/Server) | ⚠️ Partial (Local node) |
| **Maybe** | ✅ **Yes (Open-Source Web)** | Ruby on Rails 7 + React | ⭐⭐⭐⭐ Good | ✅ Yes (Docker) | ❌ No |
| **Snowball Analytics** | ✅ **Yes (Pure Cloud Web)** | SaaS Web Platform | ⭐⭐⭐⭐ Good | ❌ No (SaaS) | ❌ No |
| **Exirio / Kubera** | ✅ **Yes (Pure Cloud Web)** | SaaS Web Platform | ⭐⭐⭐⭐ Good | ❌ No (SaaS) | ❌ No |

---

## 2. Detailed Breakdown of Web Versions

### 2.1 Portfolio Performance (PP): The Web Void
- **Official Status:** Portfolio Performance has **NO official native web version**.
- **Desktop Constraint:** It remains an Eclipse RCP / Java desktop program.
- **Community Workarounds:**
  - *Docker VNC Streaming:* Users run a headless Linux container containing PP and stream the desktop interface over WebSocket via `noVNC` or `x11vnc` to a browser.
  - *Drawbacks:* High memory consumption, latency, poor touchscreen usability, and non-responsive UI on mobile browsers.
- **Mobile Viewer App:** The official iOS/Android apps are standalone native viewers, not web apps, and require syncing the encrypted `.portfolio` file via cloud storage (iCloud, Google Drive).

---

### 2.2 Ghostfolio: The Benchmark for Open-Source Web
- **Native Web First:** Ghostfolio was built from the ground up as a responsive web application and Progressive Web App (PWA).
- **Mobile Web Experience:** Touch-optimized UI with modern charts, mobile navigation, dark mode, and quick transaction entry.
- **Deployment Flexibility:** Can be run locally via Docker Compose (`docker compose up`) or deployed on cloud hosts (Railway, Render, AWS).

---

### 2.3 Capitally: Zero-Knowledge Browser Security
- **Native Web First:** Runs entirely inside modern web browsers (Chrome, Safari, Firefox).
- **Client Encryption:** Uses the browser’s native **Web Crypto API** (`AES-256-GCM`) to encrypt portfolio entries locally before sending encrypted blobs to cloud storage.
- **Mobile Web:** Highly responsive UI tailored for smartphones and tablets.

---

### 2.4 Delta by eToro: Desktop & Web Expansion
- **Transition from Mobile-Only:** Delta started as a mobile-only app, but recently launched a web version at `web.delta.app`.
- **Account Requirement:** Accessing the web version requires registering and logging in with an **eToro account** to sync portfolio data from mobile to the browser.
- **Privacy Trade-off:** Web access routes all portfolio transactions and balances through eToro's centralized servers.

---

### 2.5 Sharesight, Snowball Analytics & Exirio (Cloud Web SaaS)
- **Architecture:** Standard multi-tenant web applications hosted on AWS/GCP.
- **Web Experience:** Full-featured dashboards for desktop and tablet screens; mobile web interfaces automatically adapt to smartphone screens.
- **Dependency:** Require constant internet access and a paid subscription for full feature access.

---

## 3. Why a New Local-First Web App (PWA) is Needed

```
+-------------------------------------------------------------------------------+
|                       THE MARKET GAP FOR OUR WEB APP                          |
+------------------------------------+------------------------------------------+
| Existing Solutions                 | What Is Missing?                         |
+------------------------------------+------------------------------------------+
| 1. Portfolio Performance           | No native web app; desktop-only; heavy   |
| 2. Ghostfolio                      | Requires running a Docker server         |
| 3. Sharesight / Delta              | Cloud SaaS; no privacy; monthly fees     |
| 4. Capitally                       | Closed-source proprietary SaaS           |
+------------------------------------+------------------------------------------+
| OUR SOLUTION:                      | - 100% Browser Local-First PWA           |
| Lightweight Local-First Web App    | - Zero server setup (runs in IndexedDB)  |
|                                    | - Mobile-first touch UI                  |
|                                    | - Import PP XML/CSV files directly       |
+------------------------------------+------------------------------------------+
```
