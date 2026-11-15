# PDF Studio

Private PDF viewer/editor that runs entirely in the browser (no upload, no account) and installs as an app (PWA) on Windows, macOS, Linux, Android and iOS/iPadOS.

It is an original implementation built on two open-source libraries: [pdf.js](https://github.com/mozilla/pdf.js) (rendering, Apache-2.0) and [pdf-lib](https://github.com/Hopding/pdf-lib) (editing, MIT). Licences are in `lib/`. It is **not** Adobe Acrobat and does not contain Adobe code.

## Features

| Area | What works |
|---|---|
| View | Continuous scroll, zoom (buttons, Ctrl+wheel, fit width), thumbnails, page jump, print |
| Annotate | Highlight, text box (double-click to edit), freehand draw, rectangle, whiteout, image stamp, signature (draw / image, remembered locally) |
| Edit annotations | Select, move, resize, recolor, change size, delete, undo/redo |
| Redact | Black-out boxes; on save the affected pages are rasterized so the covered text is removed |
| Pages | Rotate, delete, duplicate, insert blank, reorder (drag or arrows), extract range, split into parts |
| Combine | Insert/merge PDFs and images (images become pages) |
| Forms | Fill text fields, checkboxes, dropdowns, radio groups; flatten |
| Search | Text search across pages (PDFs with a text layer) |
| Export | Save PDF, current page as PNG, edit title/author/subject/keywords |
| Offline | Service worker caches the app after first load |

## Run / install

PWA install needs `https://` or `http://localhost`.

Local:
```bash
cd pdf-studio
python3 -m http.server 8000
# open http://localhost:8000 in Chrome or Edge, then use the install icon in the address bar
```
Hosted: publish the `pdf-studio/` folder on any static HTTPS host (e.g. GitHub Pages) and open that URL.
Install: Chrome/Edge desktop & Android: install icon in address bar / menu. iOS Safari: Share -> Add to Home Screen.

## Known limits (not in Adobe Acrobat Pro terms)

- No OCR; scanned PDFs are not searchable.
- No password *protection/encryption* on save; password-protected PDFs open **view-only**.
- No digital-certificate signatures (the Sign tool places a visual signature image, which is not a cryptographic signature).
- No true editing of existing page text/images (use Whiteout + Text as a workaround).
- No PDF/A, PDF/X, accessibility tagging, comparison, Bates numbering, JavaScript forms, cloud features.
- Text annotations use the built-in Helvetica font (Latin/WinAnsi characters only; others become `?`).
- Saving flattens annotations into page content, so they are no longer editable afterwards (Undo still works within the session).
- Redacted pages lose selectable text, links and form fields (they become images).
- Search highlight position is approximate.
- Verified in headless Chromium only. Safari/Firefox are untested.
