# PDF Studio

Private PDF viewer/editor that runs entirely in the browser (no upload, no account) and installs as an app (PWA) on Windows, macOS, Linux, Android and iOS/iPadOS.

It is an original implementation built on two open-source libraries: [pdf.js](https://github.com/mozilla/pdf.js) (rendering, Apache-2.0) and [pdf-lib](https://github.com/Hopding/pdf-lib) (editing, MIT). Also used: mammoth (Word), ExcelJS (Excel), fflate (zip), Tesseract.js + English model (OCR). Licences are in `lib/`. It is **not** Adobe Acrobat and does not contain Adobe code.

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
| **Create** | New blank PDF (size/orientation/pages), write a document in Markdown or plain text |
| **Edit existing text** | Click a line of text, retype it (original is covered with white, replacement written on top) |
| **Files -> PDF** | Word `.docx`, Excel `.xlsx`, CSV/TSV, text, Markdown, HTML, images (PNG/JPG/GIF/WebP/BMP). Convert one-by-one, combine into one PDF, or append to the open PDF. Drop files on the window |
| **PDF -> files** | Word `.docx` (text only), Excel `.xlsx` (detected tables), plain text, PNG/JPG images (zip for several pages) |
| **OCR** | English OCR of scanned pages adds an invisible text layer so they become searchable |
| **Privacy tools** | Find & redact emails/phones/IDs/IBANs/links/custom text; remove metadata |
| **Page tools** | Page numbers, text watermark |
| Offline | Service worker caches the app after first load; OCR/converters are cached the first time they are used |

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

- OCR is English only and accuracy depends on scan quality (verify the result).
- Not supported as input: `.doc`, `.xls`, `.ods`, `.odt`, `.rtf`, `.ppt/.pptx` (the browser cannot render them faithfully; save as `.docx`/`.xlsx`/PDF first).
- Word/Excel -> PDF is a re-layout, not Word/Excel's own renderer: fonts become Helvetica/Courier, only Latin (WinAnsi) characters are supported (others print as `?`; Arabic/Hebrew/CJK not supported), no headers/footers, text boxes, charts, or merged-cell styling. Wide sheets are scaled or split across column groups; long cell text is truncated.
- PDF -> Word keeps text and basic heading/paragraph breaks only (no images, tables or exact layout). PDF -> Excel uses a heuristic and can misplace columns; check the result.
- Edit text: works on unrotated pages with a text layer; the replacement uses Helvetica (the original font/colour are not matched), and the original text stays in the file under the white cover. Use Redact for anything confidential.
- Auto-redact is pattern based: review every box before saving.
- No password *protection/encryption* on save; password-protected PDFs open **view-only**.
- No digital-certificate signatures (the Sign tool places a visual signature image, which is not a cryptographic signature).
- No true editing of existing page text/images (use Whiteout + Text as a workaround).
- No PDF/A, PDF/X, accessibility tagging, comparison, Bates numbering, JavaScript forms, cloud features.
- Text annotations use the built-in Helvetica font (Latin/WinAnsi characters only; others become `?`).
- Saving flattens annotations into page content, so they are no longer editable afterwards (Undo still works within the session).
- Redacted pages lose selectable text, links and form fields (they become images).
- Search highlight position is approximate.
- Verified in headless Chromium only. Safari/Firefox are untested.
- Excel is read with ExcelJS (MIT), not SheetJS, because SheetJS's patched releases are not on npm and the npm copy has known vulnerabilities.
