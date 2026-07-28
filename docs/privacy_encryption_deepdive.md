# Privacy & Encryption Architecture: Deep Dive

## 1. Overview & Threat Model

Financial portfolio data (net worth, asset allocations, trade history, bank account details) is among the most sensitive personal data. Users switching away from heavy desktop software like Portfolio Performance to a web/mobile solution require strict privacy guarantees.

### Threat Model Matrix

| Potential Threat | Risk Level | Mitigation Strategy in Local-First Web App |
| :--- | :--- | :--- |
| **Server Data Breach / Database Leak** | High | **Zero-Knowledge Architecture:** Data is encrypted client-side; server (if used) only receives encrypted ciphertext. |
| **Unencrypted Cloud Storage Sync** | Medium | **Client-Side AES-256-GCM Encryption:** Files/payloads are encrypted before being uploaded to user cloud drives (Google Drive / Nextcloud / WebDAV). |
| **Malicious Browser Extensions / XSS** | High | **Strict CSP (Content Security Policy),** isolated Web Worker cryptography, and minimal third-party dependencies. |
| **Network Eavesdropping / ISP Interception** | Medium | **Direct Client API Fetching over HTTPS / TLS 1.3** for market price quotes. |
| **Unauthorized Physical Access to Mobile Device** | Medium | **Biometric Lock (WebAuthn / FaceID / TouchID)** and auto-locking session timers. |

---

## 2. Privacy & Data Storage Models Compared

```
+-------------------------------------------------------------------------------+
|                             DATA PRIVACY SPECTRUM                             |
+-------------------+--------------------+-------------------+------------------+
| 1. Pure Cloud     | 2. Self-Hosted     | 3. Zero-Knowledge | 4. Local-First   |
|    SaaS           |    Web Server      |    Cloud Sync     |    PWA Web App   |
| (Sharesight/Delta)| (Ghostfolio/Docker)| (Capitally)       | (Our Architecture|
+-------------------+--------------------+-------------------+------------------+
| Server sees data  | User owns server;  | Server sees       | Data lives ONLY  |
| Third-party risk  | requires admin skills| ciphertext only | on user device   |
+-------------------+--------------------+-------------------+------------------+
```

---

## 3. Technical Encryption Specification for Our Web App

### 3.1 Client-Side Web Crypto API
Modern web browsers (iOS Safari, Android Chrome, Desktop) provide the native **W3C Web Crypto API** (`window.crypto.subtle`), which executes cryptographic primitives directly in C++ native code for high performance and hardware acceleration.

```
                   +------------------------+
                   |  User Master Passphrase|
                   +-----------+------------+
                               |
                               v
               +---------------+----------------+
               | PBKDF2 / Argon2id KDF         |
               | (100,000+ iterations + salt)  |
               +---------------+----------------+
                               |
                               v
                   +-----------+------------+
                   |  256-bit AES-GCM Key   |
                   +-----------+------------+
                               |
            +------------------+------------------+
            |                                     |
            v                                     v
+-----------+------------+            +-----------+------------+
|  Encrypt Portfolio Data|            |  Decrypt Portfolio Data|
|  (IndexedDB / File)    |            |  (In-Memory State)     |
+------------------------+            +------------------------+
```

### 3.2 Key Cryptographic Standards
1. **Symmetric Encryption:** `AES-256-GCM` (Galois/Counter Mode) providing both confidentiality and authenticated integrity protection against tampering.
2. **Key Derivation Function (KDF):** `PBKDF2` with `SHA-256` (or `Argon2id` via WebAssembly) using a random 128-bit salt and minimum 100,000 iterations to resist brute-force dictionary attacks.
3. **Initialization Vector (IV):** Cryptographically secure random 96-bit IV generated via `crypto.getRandomValues()` for every encryption operation.

---

## 4. Local Storage & Persistence Mechanism

To replace a desktop file-based system with a fast mobile web experience, we utilize browser native storage mechanisms:

### 4.1 Storage Layers

| Storage Mechanism | Purpose | Max Capacity | Persistence Level |
| :--- | :--- | :--- | :--- |
| **IndexedDB (via idb / Dexie.js)** | Primary portfolio database (securities, transactions, accounts, prices) | 500MB - several GBs | Persistent (Protected by `navigator.storage.persist()`) |
| **Origin Private File System (OPFS)** | High-performance raw file storage for Portfolio Performance `.portfolio` / XML backup imports | Uncapped | High speed synchronous binary I/O |
| **Web Crypto Memory State** | Unencrypted operational state while app is unlocked | RAM | Cleared on window unload / lock timeout |

### 4.2 Offline Capability & PWA (Progressive Web App)
- **Service Worker Caching:** Caches static web application bundle (HTML, JS, CSS, fonts, icons) so the app opens instantly offline without network dependency.
- **Background Sync:** Queues market price quote requests and sync tasks when offline, executing automatically upon network re-connection.
