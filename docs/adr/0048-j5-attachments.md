# ADR-048: J5 replies can carry files, document snapshots, highlighted pages, charts and web screenshots

- Status: Accepted (Julian, principal, 2026-10-02: screenshots, images, charts, graphs, highlights, "not restricted to that")
- Date: 2026-10-02

## Decision
The drafting model may return up to 4 attachment specs: an original file, a Quick Look snapshot of a
document's first page, a PDF page rendered with a phrase highlighted (PDFKit), a bar/line/pie chart from
real numbers (SVG rendered by Quick Look), or a screenshot of an https web page (headless Chrome with a
throwaway profile, so no cookies or logins are used). Core only validates specs; the helper builds them on
the Mac in ~/Pictures/Finagai/<draft>/ and sends them with Messages.

## Protections
- Local paths must be under Julian's home, outside the excluded locations (ADR-046/047), and under 25 MB;
  anything else is refused by the helper.
- Julian sees the attachments in his own thread together with the draft, before `ok`.
- The prompt forbids attaching financial, ID, tax or health documents unless the person clearly asked for
  that exact document and it is theirs to see.
