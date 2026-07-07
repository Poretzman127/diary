# Diary

Private journal — password-gated, cloud-synced, mobile-friendly.

- **Live:** https://poretzman127.github.io/diary/
- **Sync:** JSONBin (single private bin)
- **Storage:** localStorage cache + JSONBin cloud (last-writer-wins by `_updated`)

## Files
- `index.html` — shell
- `styles.css` — all CSS
- `app.js` — all JS (gate, entries, ratings, sync)
- `sw.js` — offline shell (same-origin only; JSONBin passes through)

## Notes
- Password hash + entries live in JSONBin. Anyone with the master key (embedded in `app.js`) can read the bin — same tradeoff as workout/baseball apps. If a specific entry needs to be private-private, don't type it here.
- Forgetting the password: no recovery. Would need to reset the bin manually.
