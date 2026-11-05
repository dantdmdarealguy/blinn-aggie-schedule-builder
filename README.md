# Blinn Classes on Aggie Schedule Builder

A userscript for Texas A&M students who also take classes at **Blinn College**. It shows your registered Blinn classes on
the weekly calendar in **Aggie Schedule Builder** (`tamu.collegescheduler.com`), drawn to look like the TAMU sections, so you can
build your TAMU schedule around them.

It also adds a **section preview**: type something like `CSCE 120 519` to see that section on your calendar in place of the
one in your cart, without changing your cart.

> Unofficial. Not affiliated with Texas A&M University, Blinn College, Ellucian, or College Scheduler.

## Install

1. Install the **[Tampermonkey](https://www.tampermonkey.net/)** browser extension (works in Chrome, Edge, Opera, Firefox, Safari).
2. **Chrome / Edge / Opera / other Chromium browsers:** open the browser's extensions page, open Tampermonkey's *Details*, and
   turn on **Allow user scripts** (on older versions, turn on *Developer mode* instead). If you skip this, the script won't run.
3. Click **[Install the script](https://raw.githubusercontent.com/dantdmdarealguy/blinn-aggie-schedule-builder/main/blinn-aggie-schedule-builder.user.js)**
   and confirm in Tampermonkey.

Tampermonkey checks this repo for updates on its own.

## Use

1. **Sync your Blinn classes:** log in to Blinn's registration site, go to **Register for Classes**, and pick the term.
   A maroon "Synced N Blinn classes" notice pops up in the corner. Do this again whenever you add or drop Blinn classes. If
   you submit changes while that page is open, it re-syncs automatically.
2. **Open Aggie Schedule Builder** for the same term (for example *Spring 2027 - College Station*) and go to your Shopping Cart.
   Your Blinn classes appear on the calendar, and a bar above the calendar shows what was synced and when.
3. **Preview a section:** in the bar, type `SUBJ COURSE SECTION` (e.g. `CSCE 120 519`) and press **Preview**. The section in
   your cart is hidden and the one you typed is drawn in its place. Click **×** on the "Previewing" pill to go back.

Click the ⓘ on any added block for its CRN, meeting type, room, campus, instructor, and dates.

Terms are matched by season and year: Blinn "Spring 2027" ↔ TAMU "Spring 2027 - College Station".

## Privacy

- The script makes no requests to any third-party server. It only calls Blinn's registration pages and Aggie Schedule Builder,
  using the login you already have in your browser.
- Your synced classes and previews are kept in Tampermonkey's own storage on your computer. Nothing is uploaded anywhere.

## Limitations

- Online Blinn classes and others with no scheduled meeting times aren't drawn, because there's nothing to place on the calendar.
- Only classes with status **Registered** at Blinn are synced (not waitlisted ones).
- If Blinn's Banner system or College Scheduler changes its page structure, the script may need an update. Please
  [open an issue](https://github.com/dantdmdarealguy/blinn-aggie-schedule-builder/issues).

## License

[MIT](LICENSE)
