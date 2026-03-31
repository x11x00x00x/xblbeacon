# API spec for website backend (e.g. xb.live)

The XBL Beacon app calls your **website backend** for updates and status using the same base URL as the rest of the app (e.g. `https://xb.live`). So the URLs are:

- `https://xb.live/api/update/check?...`
- `https://xb.live/api/status` (POST from app; GET optional, for your dashboard)

Implement these on your xb.live (or Insignia) backend so the app works without a separate update server.

---

## 1. GET `/api/update/check`

**Query:** `version` (string, required), `platform` (string, optional, e.g. `darwin`, `win32`).

**Response (JSON):**

- When no update: `{ "updateAvailable": false }`
- When update available:  
  `{ "updateAvailable": true, "version": "1.0.1", "url": "https://xb.live/...", "sha256": "...", "notes": "..." }`

`url` must be a full URL the client can GET to download the installer. `sha256` is optional; if present the app verifies the download.

**Example:**  
`GET https://xb.live/api/update/check?version=1.0.0&platform=darwin`

---

## 2. POST `/api/status`

**Body (JSON):** The app sends device/analytics data, e.g.:

```json
{
  "version": "1.0.0",
  "platform": "darwin",
  "arch": "arm64",
  "lastCheck": "2025-02-26T12:00:00.000Z",
  "hostname": "MyMac",
  "username": "jane",
  "osRelease": "22.5.0",
  "sys": {
    "cpus": 8,
    "totalMem": 16384,
    "freeMem": 8192,
    "uptime": 3600
  }
}
```

**Response:** Any 2xx JSON, e.g. `{ "ok": true }`. Store the payload (and request IP) for analytics; the app does not use the response body.

---

## 3. GET `/api/status` (optional)

For your own dashboard: return the list of devices you stored from POST `/api/status` (e.g. `{ "devices": [ ... ] }`). The app does not call this.

---

## Summary

| URL (on xb.live)           | Method | Used by app | Purpose                    |
|----------------------------|--------|-------------|----------------------------|
| `/api/update/check`        | GET    | Yes         | Check for app update       |
| `/api/status`              | POST   | Yes         | Send device/analytics      |
| `/api/status`              | GET    | No          | Your dashboard / device list |

The app uses `XBL_SITE_URL` (e.g. `https://xb.live`) as the base, so these paths are `xb.live/api/update/check` and `xb.live/api/status`. Override with `UPDATE_SERVER_URL` only if you host updates elsewhere.
