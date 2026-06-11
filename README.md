# QuickDrop

QuickDrop is a secure, temporary file-sharing web app that lets you quickly transfer files between devices without signing into personal cloud accounts.

**Live Demo:** https://quickdrop-9a015.web.app/

---

## Features

- **End-to-end encryption** — Files are encrypted in the browser using AES-GCM 256-bit before upload. The key never leaves your device; it travels with the shareable link in the URL fragment so the server never sees it.
- **Session-based sharing** — No accounts needed. Create a session, get a 6-digit code and shareable link, then walk away clean when you're done.
- **Real-time sync** — Files appear instantly on all connected devices via Server-Sent Events.
- **QR code sharing** — Scan to join a session from any device.
- **End session / delete files** — End a session to permanently delete all files from storage immediately. Individual files can also be deleted on demand.
- **Automatic expiry** — Sessions and all associated files are deleted after 1 hour. A live countdown is shown in the session header.
- **Works cross-platform** — Any modern browser, any OS.
- **100MB per file** limit.

---

## How It Works

1. Click **Create New Session** — a 6-digit code and encrypted shareable link are generated.
2. Share the link or QR code with the other device.
3. Drop files into the session — they are encrypted in the browser, uploaded directly to Google Cloud Storage, and appear in real time on all connected devices.
4. Download files — they are fetched and decrypted in the browser using the key from the URL.
5. Click **End Session** when done — all files are permanently deleted from storage.

> If you share only the 6-digit code (not the full link), recipients can join the session but cannot decrypt files. Share the full link to enable end-to-end encrypted downloads.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | React, Vite, Tailwind CSS |
| Hosting | Firebase Hosting |
| API | Node.js / Express on Cloud Run |
| Storage | Google Cloud Storage |
| Database | Firestore |
| Real-time | Server-Sent Events + Pub/Sub |
| Automation | Cloud Functions (GCS trigger), Eventarc |
| Encryption | Web Crypto API (AES-GCM 256-bit, client-side) |

---

## Project Structure

```
quickdrop/              React frontend
quickdrop-api/          Express API (Cloud Run)
quickdrop-functions/    Cloud Function (GCS → Firestore + Pub/Sub)
```

---

## Team

- **Samarth Jagtap** — Frontend & Backend
- **Areeb Khan** — Backend & Documentation

---

## Links

- Live Site: https://quickdrop-9a015.web.app/
- GitHub: https://github.com/thatscrazzyy/quickdrop/
