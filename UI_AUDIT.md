# Super Admin dashboard — CSS / UI audit

## How it was tested
The real `server.js` + the real dashboard were run in headless Chromium (seeded with deliberately long names, IDs, emails and addresses). Every one of the 42 menu pages was opened at 1440, 1024, 768, 390 and 320 px wide (210 page×width checks) and measured for: content wider than its card/screen, content spilling or being cut off inside its own box, form fields squeezed to a sliver, siblings overlapping inside flex/grid rows, and tables outside a scroller. All 27 modal dialogs were opened at 4 screen sizes. Screenshots of every listed page were reviewed by eye. Fonts (Google) and Firebase were loaded offline/locally, so text metrics may differ slightly on a real device.

## What was actually wrong (and fixed)
| Problem | Where | Fix |
|---|---|---|
| Icon buttons (block/print/edit) narrower than their own icon → icons cut/spilling (80+ hits) | Students, Agents, Staff, tables everywhere | `.btn-icon` auto width, 32px minimum |
| Long names/IDs stayed on one line and ran off the card; ID chips broke mid-token ("AG-/00001") | Every table | cells wrap (`word-wrap:break-word`, 360px max), ID chips stay intact |
| Empty-state text ("No invoices found…") cut off to the right inside table scrollers | Staff Verification, Pending Registrations, Bills, Material list, Aadhaar, Direct Payments… | empty tables shrink to the card; headers hidden on phones |
| Website Notices "Header / nav custom buttons" form crushed its fields to 9–26 px (unusable on phones) | Website Notices | inline multi-column grids re-flow to what fits |
| Closed mobile sidebar leaked a shadow strip onto the screen edge | All pages ≤1100 px | shadow only when open |
| Live user names clipped to one 8 px line | Dashboard | 2-line wrap, 11 px |
| Dropdown text running under the arrow | Agent Performance sort, filters | arrow padding + ellipsis |
| Top bar / page header strips drifting up, overlapping content | Dashboard, Material Master | app shell pinned to the viewport; page headers sticky (desktop only, so phones keep their screen space) |
| Tables rendered later (e.g. wallet modal) had no scroller | Modals, dynamic content | tiny script wraps any unwrapped `<table>` automatically |
| Material Master unit dropdown clipped ("Bag (50k") | Material Master | min width |

Also applied globally, as requested: `box-sizing:border-box` on everything, `word-wrap/overflow-wrap:break-word`, `min-width:0` on grid/flex children, wrapping action/header rows, stat grids that auto-fit (2 per row on phones instead of 1 tall column), modals capped to the screen with internal scroll, tables in `width:100%; overflow-x:auto` containers.

## Result
Strict checks, all pages × all widths: horizontal page overflow 0, elements bleeding out of their card 0, text clipped by hidden overflow 0, sibling overlaps 0, tables outside a scroller 0, JavaScript errors 0. Content spilling out of its own box went from 190 hits to 9 (single emoji glyphs a few px wider than their label). The 21 "narrow field" hits that remain are intentional: colour pickers and the 1-emoji icon boxes in Login & App Access. Modals: no off-screen or overflowing dialogs at any size.

## One regression caught and fixed during testing
My first version made vertical settings rows 220 px too tall (large blank gaps on Login & App Access and Website Notices). A with/without-CSS comparison found it; fixed before delivery.

## Notes / limits
- Wide data tables still scroll sideways inside their card (by design, per your rule 1); long text now wraps first so far less scrolling is needed.
- Tested with Chromium only (no Safari/Firefox). The empty-table rule uses `:has()`, supported by current Chrome, Edge, Safari 15.4+ and Firefox 121+; older browsers simply keep the previous behaviour.
- Only the Super Admin dashboard was changed. The other portals were not audited here.
- Pages whose content needs data I could not seed (e.g. real bills, withdrawal requests, HR reports) were checked in their empty state and with long-text sample data on the others; a table full of unusual real data could still reveal an edge case.
