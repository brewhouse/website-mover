# M0 spike 6: Style guide extraction

**Result: NOT RUN. Waiting on input.** `inputs/jha/style-guide.pdf` doesn't exist yet. Per the M0 brief, this spike only runs on the real JHA style guide, not a substitute.

What is already in place:
- **Model check.** `OPENAI_MODEL=gpt-6-astra` was tested through the Responses API with a PDF sent as `input_file` (base64) and a strict `json_schema` output. It returned valid JSON with the colours from the PDF (2026-10-13). `gpt-6-sol`, `gpt-6-luna`, `gpt-6.1-sol`, `gpt-5.6-*` and `gpt-5.5` passed the same test.
- **PDF tools on the dev machine:** `pdftotext`, `pdfimages`, `qpdf` and Ghostscript (for page renders).
- **Where the tokens go** (`framework-assessment.md` §6):
  - colour roles → the Theme Settings ACF options (`primary_color`, `secondary_color`, `tertiary_color`, `link_color`, `hover_color`, `background_color`, `secondary_background_color`, `tertiary_background_color`)
  - heading sizes → `h1_font_size`…`h6_font_size`
  - fonts → a Global Styles CSS override, because the theme hard-codes Open Sans and Ubuntu

When the PDF arrives (PLAN §6.8):
1. Deterministic pass: hex/RGB/CMYK in `pdftotext` output, vector swatch fills, embedded images (`pdfimages`) as logo candidates, and font names from the PDF's font list.
2. `gpt-6-astra` pass: the PDF plus page renders → colour roles, heading/body fonts, and the logo's page and location.
3. Cross-check: every colour the model returns must appear in step 1's set.

Write the result here. Don't commit brand assets; they stay in `inputs/`.
