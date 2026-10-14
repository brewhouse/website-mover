# M0 spikes 2 and 3: local seed in Docker, bridge plugin

## Spike 2: Local seed site in Docker. **Result: PASS**

`e2e/seed/setup.sh` (add `--fresh` to wipe and start again):
1. Copies `SEED_CODE_PATH` into `.local/seed/` with `rsync`. It excludes `.git`, `.ddev` (which holds a token), `.tmb`, CI folders and uploads. The seed clone is only ever read.
2. Adds `wp-config-local.php`, which the seed's `wp-config.php` loads when `PANTHEON_ENVIRONMENT` is unset.
   - Credentials come from Docker env.
   - Salts are generated into `.local/seed/wp-salts-local.php`.
   - `WP_ENVIRONMENT_TYPE=local`, so Application Passwords work over HTTP.
3. Adds an Apache `.htaccess` that passes `Authorization` through.
4. Runs `e2e/seed/compose.yaml`:
   - `mariadb:10.4` and `wordpress:php8.2-apache`, matching `pantheon.upstream.yml`, on `http://localhost:8088`
   - this repo's `wp/bridge` bind-mounted as `wp-content/plugins/website-mover-bridge`
   - a `cli` service (`wordpress:cli-php8.2`) for WP-CLI
5. Fresh install. Admin password comes from `SEED_LOCAL_ADMIN_PASSWORD` in `.env`. Permalinks are `/%postname%/`. It activates `planeteriaweb` and the plugins.

Plugins:
- **41 of 49 plugins were activated.** Skipped locally because they call outside services or send mail: Planeteria SSO, AltText.ai, BugHerd, Broken Link Checker, Gravity SMTP, Facebook/Instagram feeds, WordPress Importer.
- An Application Password for `admin` is stored as `SEED_LOCAL_APP_PASSWORD` in `.env`.

Evidence, from `GET /wp-json/website-mover/v1/status` and WP-CLI:
- WordPress 7.0.4, PHP 8.2.34, ACF Pro 6.3.8, Gravity Forms 3.1.0.3.
- Theme `planeteriaweb` (template `twentytwentytwo`), `is_block: true`.
- Homepage, REST index, pages and posts return 200.
- Page, single post, search and 404 render the framework's PHP header (`class="main_header"`).
- Blog index, category archive and `/events/` render TT2 block parts. See framework-assessment §2.

Notes:
- The fresh database has **none of the framework's ACF post types, field groups, menus or options**. Those live only in the seed DB (framework-assessment §7.1). The local seed is "framework code + empty DB" until we get a DB export.
- PHP deprecation notices from older plugins (Add Admin CSS, WP Sheet Editor) are harmless. WP-CLI needs `memory_limit=512M`, which is set in `e2e/seed/php.ini`.

### Update: seed database imported

`e2e/seed/setup.sh --db inputs/framework/<backup>.sql.gz` replaces the local DB with the seed's Pantheon backup:
- It rewrites the seed's own URL to `http://localhost:8088`.
- It keeps the seed's plugin selection, switching off only the locally skipped plugins.
- It adds a separate local admin, `wm-local`, with an Application Password written to `.env`.

The real content model is in framework-assessment §0.

**Hosted seed (read-only checks).** With `SEED_URL`/`SEED_USER`/`SEED_APP_PASSWORD`, `GET /wp/v2/users/me` returns 200. The account is an administrator with `unfiltered_html` and `upload_files`, and the environment isn't password-locked. The bridge isn't installed there yet: it has to be added to the seed's Pantheon codebase (by the team) before M1 can write to it.

## Spike 3: Bridge plugin skeleton. **Result: PASS**

`wp/bridge` (plugin "Website Mover Bridge" 0.1.0). REST namespace `website-mover/v1`, admin only (`manage_options`):

| Endpoint | What it does | Storage |
|---|---|---|
| `GET /status` | WP/PHP/theme/ACF/forms versions, active plugins, upload limit (for preflight) | — |
| `GET /schema` | All public post types and taxonomies, plus ACF post types, taxonomies and field groups with fields (lets M1 target what the seed already has) | — |
| `POST /acf/post-types` | Upserts an ACF post type from ACF's export JSON (matched by `key`) | ACF's own `acf-post-type` item |
| `POST /acf/taxonomies` | Same, for taxonomies | `acf-taxonomy` |
| `POST /acf/field-groups` | Same, for field groups (`show_in_rest: 1`). Removes fields that are no longer in the definition | `acf-field-group` + `acf-field` |
| `POST /forms` | Creates or updates a form from a plugin-neutral spec (matched by `source_key`) and returns the block to insert | Gravity Forms tables |

All three ACF endpoints call ACF's own import (`acf_import_internal_post_type`), so the items look exactly like ones made in the ACF UI.

**Re-run against the real seed definitions** (seed DB imported; `packages/wp-client/scripts/bridge-spike.ts`, second run shown, all `created: false`):

```
taxonomy:    {"key":"taxonomy_wm_community_type","id":36607,"type":"acf-taxonomy","created":false}
post type:   {"key":"post_type_wm_community","id":36608,"type":"acf-post-type","created":false}
field group: {"key":"group_wm_community_details","id":36609,"type":"acf-field-group","created":false}
community ACF round trip: OK (9 fields)
show in rest: {"key":"group_5f35f63c1a6e1","title":"Person Details","changed":false}
people ACF round trip: OK (4 fields)
meeting (TEC): {"id":36624,"url":"http://localhost:8088/event/wm-spike-board-meeting/","created":false,"start":"2026-10-21 17:30:00","categories":["Board Meetings"],"venue":"JHA Central Office (spike)"}
TEC single renders: {"title":true,"agendaLink":true,"frameworkHeader":false}
form renders: {"page":"http://localhost:8088/wm-spike-help-center/","gformWrapper":true,"fields":6}
```

What this covers:
- **New type via ACF:** `community`, with a taxonomy and a 10-field group.
- **The seed's own `people` type:** "Show in REST" was switched on for its group, then a person was written with text and two repeaters.
- **A board meeting** created through The Events Calendar's REST API in the seed's "Board Meetings" category, with a venue.
- **A Gravity Forms form.**

`frameworkHeader: false` is theme change T3: Events Calendar pages use the TT2 header.

**First version of the test** (before the seed DB, on reconstructed definitions). It used the framework's template-implied model: meetings are `events` tagged with the `meeting_event_type` term "Meetings", with the field names `single-events.php` reads.

```
taxonomy:    {"key":"taxonomy_wm_meeting_event_type","id":6,"type":"acf-taxonomy","created":false}
post type:   {"key":"post_type_wm_events","id":7,"type":"acf-post-type","created":false}
field group: {"key":"group_wm_meeting_details","id":8,"type":"acf-field-group","created":false}
meeting:     {"id":26,"link":"http://localhost:8088/meetings-events/wm-spike-board-meeting/","created":false}
ACF round trip: OK
single-events.php renders: {"location":true,"agendaLink":true,"agendaPacket":true,"minutes":true}
form: {"plugin":"gravityforms","id":1,"created":false,"block":{"name":"gravityforms/form","attrs":{"formId":"1"}}}
form renders: {"page":"http://localhost:8088/wm-spike-contact/","gformWrapper":true,"fields":6}
```

What it proved:
- The post was written through core `POST /wp/v2/events` with an `acf` object containing these types: date_time, time, true_false, text, google_map, url, wysiwyg, link, file (attachment IDs from `POST /wp/v2/media`), and a repeater containing a file. Every value read back the same. The only difference: ACF's REST output returns numeric strings in google_map values as numbers.
- The framework's own `single-events.php` shows the meeting's location, agenda link, agenda packet and minutes.
- The Gravity Forms form (name, email, phone, select, checkbox, textarea) renders through the `gravityforms/form` block.
- Running the spike again updates everything in place (`created: false`).

**Survives removing the bridge.** With the plugin deactivated:
- `/website-mover/v1/status` returns 404.
- `/wp/v2/events/26` still returns all 12 ACF fields and the term.
- The meeting page still renders the minutes link, and the form page still renders the form.
- The ACF UI items and the GF form are still there.

```
bridge route: 404
events REST ok; acf fields 12 agenda_packet 24 terms [2]
meeting page: 1 minutes link(s)
form page: 2 gform wrapper line(s)
1 ACF post type(s), 1 field group(s), 1 GF form(s)
```

**Lesson for M1:** in the first run, `location_address` was guessed as a textarea. The framework template expects a google_map array and crashed (`Cannot access offset of type string on string`, single-events.php:134). M1 must read the hosted seed's real definitions with `GET /schema` instead of recreating them. For local tests, the definitions should come from an ACF export of the seed.

**Next for the bridge (M1–M3):** install it on the hosted seed (team, via the Pantheon repo), ACF options write (Theme Settings + footer fields, then `generate_options_css()`), Yoast meta, legacy-URL redirects for id/query-string URLs (PLAN §6.14), and Redirection import.
