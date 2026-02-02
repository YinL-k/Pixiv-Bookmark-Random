English | [中文](README.md)

# Pixiv Bookmark Random

![Chrome](https://img.shields.io/badge/Chrome-Extension-blue)
![Manifest](https://img.shields.io/badge/Manifest-V3-blueviolet)
![License](https://img.shields.io/badge/License-MIT-green)

A **Chrome Manifest V3** browser extension that injects a **Random** button into Pixiv pages and original image pages (`i.pximg.net`), allowing navigation to a random bookmarked illustration.

To reduce perceived latency, the extension maintains a lightweight background buffer and preloads images on the frontend using `Image()`.

---

## Features

- Random navigation to bookmarked Pixiv works
- Compatible with Pixiv SPA routing
- Background buffering + frontend preloading
- Stable tag context and recent deduplication logic

---

## Design Notes

### Tag Context Handling
- Reuses the last explicit tag context when tags cannot be parsed
- Updates context only on bookmark list pages or explicit tag URLs

### Recent Deduplication
- `recent` is updated only when a navigation actually occurs
- Prefetch and retry flows do not pollute deduplication state

### Stability Improvements
- Automatic coalescing of `ensure()` calls
- Unified rendering of button state and loading indicators

---

## Installation

1. Open Chrome → `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked** and select the project directory

---

## Disclaimer

This project is **NOT affiliated with, endorsed by, or sponsored by Pixiv Inc.**  
Pixiv and all related trademarks are the property of their respective owners.

This extension:
- Does not collect, upload, store, or transmit any user data
- Does not bundle, redistribute, mirror, or host Pixiv content
- Operates entirely locally in the user’s browser
- Requires the user to be logged in to Pixiv and uses existing browser session state only

Some features (e.g. displaying original images) may use **Declarative Net Request (DNR)**  
to modify request headers such as `Referer` / `Origin` so that images can load correctly in the browser.

These behaviors:
- Do not bypass authentication
- Do not provide downloading or redistribution capabilities
- Are enabled at the user’s discretion

By using this software, you acknowledge that:
- You are solely responsible for ensuring compliance with Pixiv’s Terms of Service and applicable laws
- The author provides this software **“as is”**, without warranty of any kind

---

## License

MIT License
