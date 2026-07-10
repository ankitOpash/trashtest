# TeamLens Screenshot Warning Tool

**Built:** July 9, 2026  
**Version:** v6 + Consent Patch

---

## What This Does

TeamLens Agent takes random screenshots every 5–10 minutes and silently uploads them. This tool adds two layers of protection:

1. **Warning alerts** — popup ~1 minute before a screenshot is expected
2. **Consent popup** — shows you the actual screenshot image before it uploads, with a **Yes / Skip** choice

---

## Files

```
C:\Users\ayopa\AppData\Roaming\teamlens-agent\
│
├── teamlens-agent.json          # TeamLens config (min 5 min, max 10 min policy)
├── next-shot-at.json            # EXACT next screenshot time (written by patch)
├── logs\main.log                # TeamLens activity log
│
└── tools\
    │
    ├── ss-warning.js            # Main watcher (v6) — watches log + queue
    ├── teamlens-activity.js     # Port of TeamLens activity.js (idle detection)
    ├── teamlens-scheduler.js    # Port of TeamLens scheduler.js (timing/policy)
    │
    ├── ss-warning.ps1           # PowerShell launcher (start/stop/test)
    ├── watchdog.ps1             # Auto-restarts watcher if it dies
    │
    ├── show-popup.vbs           # Windows warning dialog (yellow box)
    ├── ss-warning.log           # Tool activity log
    ├── ss-warning-state.json    # Saved schedule (survives restarts)
    ├── ss-warning.pid           # Running watcher PID
    │
    ├── start-ss-warning.bat     # Start watcher
    ├── stop-ss-warning.bat      # Stop watcher
    ├── test-alert.bat           # Show test popup
    ├── install-startup.bat      # Auto-start on login
    │
    └── teamlens-patch\
        ├── scheduler.js         # Patched TeamLens scheduler
        ├── consent.js           # Consent dialog logic
        ├── consent.html         # Consent UI (dark, shows screenshot)
        ├── consent-preload.js   # Electron bridge for consent window
        ├── apply-patch.ps1      # Install patch (needs Admin / UAC)
        ├── restore-patch.ps1    # Undo patch (needs Admin / UAC)
        └── install-patch.bat    # Easy installer
```

---

## How It Works

### TeamLens Scheduler (reverse engineered)

```
scheduler.js nextDelayMs():
  delay = minIntervalSec + random × (maxIntervalSec - minIntervalSec)
       = 300 + random × 300   →  anywhere 5–10 min
```

The timer lives **only in RAM** — no file ever stores the exact next time.  
The patch fixes this by writing `next-shot-at.json` when the timer is set.

### Screenshot Flow (with patch)

```
Timer fires
  → screen captured to memory
  → consent popup opens (dark window, full screenshot shown)
     → "Yes, post it" → image queued → uploaded to server
     → "Skip"         → image deleted → nothing sent
  → next random timer set → next-shot-at.json updated
```

### Warning Alert Flow (ss-warning.js)

```
Watches: main.log + queue-index.json + next-shot-at.json

After each [shot] captured:
  → Early alert:  lastShot + 4 min  (covers short 5-min gaps)
  → Final alert:  lastShot + 9 min  (covers long 10-min gaps)

If patch active + next-shot-at.json present:
  → Exact alert:  exactTime - 60s
```

---

## Key Findings from JS Analysis

| File | What we learned |
|------|----------------|
| `scheduler.js` | `min + Math.random() * (max - min)` — pure random, no prediction possible from outside |
| `capture.js` | Uses Electron `desktopCapturer` — only works inside Electron process |
| `queue.js` | Screenshots saved to `queue-shots/shot_N.jpg` before upload |
| `uploader.js` | Flushes every 20s to `POST /api/ingest/screenshots` |
| `activity.js` | 15s idle sampling, flushes on state change or 60s max |
| `config.js` | `electron-store` — `teamlens-agent.json` in AppData |
| `api.js` | Server: `https://monitor.opashsoftware.com` |

---

## Scheduled Tasks

| Task | What it does |
|------|-------------|
| `TeamLens-SS-Warning` | Starts watcher at login |
| `TeamLens-SS-Warning-Watchdog` | Restarts watcher every 5 min if dead |

---

## Quick Commands

| Action | How |
|--------|-----|
| Test alert popup | Double-click `test-alert.bat` |
| Start watcher | Double-click `start-ss-warning.bat` |
| Stop watcher | Double-click `stop-ss-warning.bat` |
| Install patch (Admin) | Double-click `teamlens-patch\install-patch.bat` → click Yes on UAC |
| Remove patch (Admin) | Run `teamlens-patch\restore-patch.ps1` as Admin |
| View tool log | Open `tools\ss-warning.log` |
| See exact next SS | Open `next-shot-at.json` |

---

## Versions History

| Version | What changed |
|---------|-------------|
| v1 | Toast notifications — invisible when PowerShell hidden |
| v2 | Two-phase alerts (early + repeat) — too many popups |
| v3 | Repeat every 60s — still too many |
| v4 | Single smart alert using median of recent gaps |
| v5 | Early + final alerts, VBS popup (visible yellow box) |
| v6 | Node.js rewrite — uses actual `activity.js` + `scheduler.js` policy |
| v6 + patch | Exact next-shot time + consent popup with image preview |
