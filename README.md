# Prospecta

Chrome extension that captures Google Maps businesses while you scroll the results and flags the ones without a website. Everything can be exported to CSV.

I built it to prospect clients for websites without opening listings one by one. It uses the result batches Maps already loads while you browse, no API key needed.

## How it works

Search on Maps (`google.com/maps` or `google.com.br/maps`, e.g. `barber shop são luís`) and scroll the list.

The list cards don't show the website, but Maps loads results 20 at a time and each batch already carries the website, phone, address and coordinates of every place. The extension reads each batch as it arrives, so nothing has to be clicked:

- **scrolling yourself**: every batch Maps loads is classified right away
- **Capture all**: the extension scrolls to the end of the list on its own, with a short pause between batches. A full search (around 120 results) takes about 25 seconds

Each batch Maps loads is read once more by the extension (one extra request every 20 results). If a place comes back incomplete, the panel has an option to open its card and fill in the gaps. It's off by default.

Every place ends up as:

- **no website**: nothing registered
- **social only**: the "website" is Instagram, Linktree, wa.me and so on
- **own website**: has a domain

Each lead gets a score from 0 to 100. The idea is to rank first the places with no website that already have traction (many reviews, good rating, a phone number). A business with no website and 3 reviews isn't worth the call. The formula lives in `scoreLead()` in `src/parser.js`.

The toolbar icon opens a side panel with the live feed, the top leads and the export. Clicking a lead opens its detail sheet with a map, address, phone, website, opening hours and a directions shortcut. The number on the icon is how many leads have no website of their own.

The interface follows the browser language (English and Brazilian Portuguese for now, strings in `_locales/`).

## Install

1. Clone or download the repo
2. Open `chrome://extensions` and turn on developer mode
3. **Load unpacked** and pick the folder

Requires Chrome 116+ for the side panel.

## CSV

UTF-8 with BOM so Excel opens it directly. The separator follows the system locale: `;` where the decimal mark is a comma, `,` otherwise. Columns: score, name, category, phone, address, rating, reviews, website type, checked, website, hours, latitude, longitude, search, Maps link and capture date.

Maps shows at most around 120 results per search, so searching by neighborhood works better. Leads accumulate across searches without duplicates.

## Project layout

```
prospecta/
├── manifest.json        # Manifest V3
├── _locales/            # UI strings (en, pt_BR)
├── src/
│   ├── parser.js        # Reads list cards, the detail pane and the search batches; scoring
│   ├── content.js       # Watches the page, merges data across tabs, on-page HUD
│   ├── content.css      # Card badges and HUD
│   └── background.js    # Side panel, icon counter, data migration
├── popup/               # Side panel (live feed, top leads, export, detail sheet)
├── icons/
└── fonts/               # Manrope and JetBrains Mono
```

## Known issues

- Google changes the Maps HTML without notice. The parser relies on ARIA attributes and visible text instead of CSS classes so it breaks less often, but it will break eventually. The fix goes in `src/parser.js`.
- The batch format isn't documented either. If Google changes it, the reading happens in `parseSearchBody()` in `src/parser.js`. Meanwhile the open-cards mode in the panel still works, just slower (about 3 seconds per place).
- If Google thinks usage looks automated, it cuts the list and shows "This is a limited view of Google Maps". The extension stops when it sees that. Being signed in and not running dozens of searches in a row helps.
- If you reload the extension with Maps open, it tries to reconnect on its own. If the on-page HUD turns red, reload the page.
- With several Maps tabs open, only the tab in front opens cards. Batches are read in all of them.

## Disclaimer

The Google Maps Terms of Service don't allow automated extraction, so this is meant for learning and small-scale manual prospecting. For anything at scale, use the [Places API](https://developers.google.com/maps/documentation/places/web-service). Contact details of sole proprietors are personal data under Brazil's LGPD (and the GDPR elsewhere): contact them with a legitimate purpose, offer an opt-out and don't resell the list.

## License

MIT. Manrope and JetBrains Mono are under the OFL, licenses in `fonts/`.
