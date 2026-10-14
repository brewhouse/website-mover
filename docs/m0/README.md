# M0 results (2026-10-13)

| # | Spike | Result | Evidence |
|---|---|---|---|
| 1 | Planeteria framework assessment | **Done, and checked against the seed DB.** Hybrid (classic PHP child of a block theme) → classic/hybrid template strategy. Events and meetings use The Events Calendar; board members use `people`; documents are attachments with the Media Library fields | [framework-assessment.md](framework-assessment.md) |
| 2 | Local seed site in Docker | **PASS** | [local-seed-and-bridge.md](local-seed-and-bridge.md) |
| 3 | Bridge plugin: ACF post type/taxonomy/field group, Gravity Forms form, ACF values over REST | **PASS**, re-run on the real seed definitions (new `community` type, seed's `people`, an Events Calendar board meeting, a form). Survives removing the bridge | [local-seed-and-bridge.md](local-seed-and-bridge.md) |
| 4 | HTML → Gutenberg blocks in Node | **PASS**. 15 tests; 47-block sample opens in the WP 7.0.4 editor with 0 invalid blocks. The seed disables some core blocks; the converter now honors that (`restrictBlocks`) and the sample passes the editor check with the seed's real settings | [blocks-spike.md](blocks-spike.md) |
| 5 | jaxha.org inventory | **Done.** Proprietary BJM CMS, inventoried by HTML crawl | [jha-inventory.md](jha-inventory.md) |
| 6 | Style guide extraction | **Not run.** Waiting on `inputs/jha/style-guide.pdf` | [style-guide-extraction.md](style-guide-extraction.md) |

Decisions are recorded in `docs/PLAN.md` §2, and the re-estimate is in §10.
