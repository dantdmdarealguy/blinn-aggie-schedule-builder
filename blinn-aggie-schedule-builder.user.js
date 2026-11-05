// ==UserScript==
// @name         Blinn Classes on Aggie Schedule Builder
// @namespace    https://github.com/dantdmdarealguy/blinn-aggie-schedule-builder
// @version      2.5.0
// @description  Shows your registered Blinn College classes on TAMU's Aggie Schedule Builder calendar, styled like native sections, and lets you preview swapping a TAMU section.
// @author       dantdmdarealguy
// @license      MIT
// @homepageURL  https://github.com/dantdmdarealguy/blinn-aggie-schedule-builder
// @supportURL   https://github.com/dantdmdarealguy/blinn-aggie-schedule-builder/issues
// @updateURL    https://raw.githubusercontent.com/dantdmdarealguy/blinn-aggie-schedule-builder/main/blinn-aggie-schedule-builder.user.js
// @downloadURL  https://raw.githubusercontent.com/dantdmdarealguy/blinn-aggie-schedule-builder/main/blinn-aggie-schedule-builder.user.js
// @match        https://tamu.collegescheduler.com/*
// @match        https://ban9reg.blinn.edu/StudentRegistrationSsb/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addValueChangeListener
// @grant        GM_xmlhttpRequest
// @connect      www.ratemyprofessors.com
// @connect      anex.us
// @run-at       document-idle
// ==/UserScript==

(() => {
  'use strict';

  // Saved data lives only in Tampermonkey storage on your computer:
  //   blinnTerms: { [blinnTermCode]: { code, description, syncedAt, classes: [ClassMeeting] } }
  //   previews:   { [tamuTermName]: [{ key, label, meetings: [ClassMeeting] }] }
  const STORE = 'blinnTerms';
  const PREVIEWS = 'previews';

  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  // "Spring 2027" / "Spring 2027 - College Station" → "spring 2027". Blinn's "Summer I/II 2027" and
  // "May Minimester 2027" all map to TAMU's single summer term; week filtering keeps their dates apart.
  const seasonKey = s => {
    const m = String(s ?? '').match(/\b(Spring|Summer|Fall|Winter|May)\b\D*?(\d{4})/i);
    if (!m) return null;
    return `${/^may$/i.test(m[1]) ? 'summer' : m[1].toLowerCase()} ${m[2]}`;
  };
  const prettyTerm = key => String(key || '').replace(/^\w/, c => c.toUpperCase());
  const getVal = (k, d) => { try { return GM_getValue(k, d); } catch { return d; } };
  const setVal = (k, v) => { try { GM_setValue(k, v); } catch (e) { console.warn('[Blinn→AggieSB] could not save', e); } };
  const onValChange = (k, fn) => { try { GM_addValueChangeListener(k, fn); } catch { /* optional */ } };

  if (location.hostname === 'ban9reg.blinn.edu') blinnSide();
  else tamuSide();

  // ===========================================================================
  // Blinn (Ellucian Banner 9): read your registered classes and save them.
  // Runs on "Register for Classes", where Banner exposes your registrations.
  // ===========================================================================
  function blinnSide() {
    const BASE = '/StudentRegistrationSsb/ssb/';
    const DAYS = [['sunday', 'Sunday'], ['monday', 'Monday'], ['tuesday', 'Tuesday'], ['wednesday', 'Wednesday'],
      ['thursday', 'Thursday'], ['friday', 'Friday'], ['saturday', 'Saturday']];
    const hhmm = s => (s && /^\d{4}$/.test(s) ? `${s.slice(0, 2)}:${s.slice(2)}` : null);
    const onRegPage = () => /classRegistration\/classRegistration/.test(location.pathname);

    async function api(path) {
      const r = await fetch(BASE + path, { credentials: 'same-origin', redirect: 'manual',
        headers: { 'X-Requested-With': 'XMLHttpRequest', Accept: 'application/json' } });
      if (!r.ok) throw new Error(`${path} → ${r.status || r.type}`);
      return r.json();
    }
    // The tabs of Banner's "Class Details" dialog. Each returns an HTML fragment; we keep plain text only.
    const DETAIL_TABS = [
      ['classDetails', 'getClassDetails', 'Class Details'],
      ['enrollment', 'getEnrollmentInfo', 'Enrollment/Waitlist'],
      ['attributes', 'getSectionAttributes', 'Attributes'],
      ['description', 'getCourseDescription', 'Course Description'],
      ['prerequisites', 'getSectionPrerequisites', 'Prerequisites'],
      ['corequisites', 'getCorequisites', 'Corequisites'],
      ['restrictions', 'getRestrictions', 'Restrictions'],
      ['fees', 'getFees', 'Fees'],
      ['bookstore', 'getSectionBookstoreDetails', 'Bookstore Links'],
      ['linked', 'getLinkedSections', 'Linked Sections'],
      ['crossList', 'getXlstSections', 'Cross Listed Courses'],
    ];
    function fragmentToText(html, title) {
      const doc = new DOMParser().parseFromString(html, 'text/html');
      doc.querySelectorAll('.notvisible, script, style, h3, [style*="display:none"], [style*="display: none"]').forEach(e => e.remove());
      // Source-code line breaks aren't meaningful (except in <pre>); only <br>/blocks/rows below create lines.
      const tw = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
      for (let n; (n = tw.nextNode());) if (!n.parentElement.closest('pre')) n.nodeValue = n.nodeValue.replace(/\s+/g, ' ');
      const links = [...doc.querySelectorAll('a[href]')]
        .map(a => ({ text: a.textContent.trim(), href: a.href }))
        .filter(l => l.text && /^https?:\/\//i.test(l.href));
      doc.querySelectorAll('br').forEach(b => b.replaceWith('\n'));
      doc.querySelectorAll('pre, div, p, li').forEach(e => e.append('\n'));
      doc.querySelectorAll('tr').forEach(tr => {
        const cells = [...tr.children].map(c => c.textContent.split('\n').map(s => s.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n')).filter(Boolean);
        tr.replaceWith('\n' + cells.join(' | ') + '\n');
      });
      const lines = doc.body.textContent.split('\n').map(s => s.replace(/[\s ]+/g, ' ').trim())
        .filter(s => s && s !== title && !/^No .*(information|data)? ?available\.?$/i.test(s));
      return { lines, links };
    }
    async function classDetails(term, crn) {
      const out = {};
      await Promise.all(DETAIL_TABS.map(async ([key, ep, title]) => {
        try {
          const r = await fetch(BASE + 'searchResults/' + ep, { method: 'POST', credentials: 'same-origin',
            body: new URLSearchParams({ term, courseReferenceNumber: crn, first: 'first' }),
            headers: { 'X-Requested-With': 'XMLHttpRequest' } });
          if (!r.ok) return;
          const { lines, links } = fragmentToText(await r.text(), title);
          if (lines.length) out[key] = { title, lines, links };
        } catch { /* a missing tab shouldn't block the sync */ }
      }));
      return out;
    }

    async function findTerm(search) {
      const list = await api(`classSearch/getTerms?searchTerm=${encodeURIComponent(search)}&offset=1&max=50`);
      return list.map(t => ({ code: t.code, description: t.description.replace(/\s*\(View Only\)\s*$/i, '') }));
    }
    async function currentTerm(events) {
      const pageTerm = (document.body.innerText.match(/Term:\s*([^\n]+)/) || [])[1]?.trim();
      if (pageTerm) {
        const hit = (await findTerm(pageTerm)).find(t => t.description === pageTerm);
        if (hit) return hit;
      }
      const code = events[0]?.term;
      if (!code) return null;
      return (await findTerm(code)).find(t => t.code === code) || { code, description: code };
    }

    let running = false;
    async function sync() {
      if (running || !onRegPage()) return;
      running = true;
      try {
        const events = await api('classRegistration/getRegistrationEvents?termFilter=');
        const term = await currentTerm(events);
        if (!term) return;
        const registered = new Map();
        for (const e of events) {
          if (e.term === term.code && /registered/i.test(e.className || '')) registered.set(e.crn, e);
        }
        const classes = [], details = {};
        for (const e of registered.values()) {
          details[e.crn] = await classDetails(term.code, e.crn);
          const d = await api(`searchResults/getFacultyMeetingTimes?term=${term.code}&courseReferenceNumber=${e.crn}`);
          for (const f of d.fmt || []) {
            const m = f.meetingTime || {};
            const days = DAYS.filter(([k]) => m[k]).map(([, n]) => n);
            const start = hhmm(m.beginTime), end = hhmm(m.endTime);
            if (!days.length || !start || !end) continue; // online/TBA meetings can't go on a calendar
            const prof = (f.faculty || []).find(x => x.primaryIndicator) || (f.faculty || [])[0];
            classes.push({
              subj: e.subject, num: e.courseNumber, title: String(e.title || '').replace(/\s+-\s+Full Term$/i, ''), crn: e.crn,
              type: m.meetingTypeDescription === 'Class' ? 'Lecture' : (m.meetingTypeDescription || ''), days, start, end,
              room: [m.building, m.room].filter(Boolean).join(' ') || 'TBA',
              instructor: prof?.displayName || 'TBA',
              campus: m.campusDescription ? `Blinn College – ${m.campusDescription}` : 'Blinn College',
              dates: m.startDate && m.endDate ? `${m.startDate} - ${m.endDate}` : '',
            });
          }
        }
        const all = getVal(STORE, {});
        const before = JSON.stringify(all[term.code]?.classes || null);
        all[term.code] = { code: term.code, description: term.description, syncedAt: Date.now(), classes, details };
        setVal(STORE, all);
        if (JSON.stringify(classes) !== before) {
          const n = new Set(classes.map(c => c.crn)).size;
          toast(`Synced ${n} Blinn class${n === 1 ? '' : 'es'} for ${term.description} to Aggie Schedule Builder.`);
        }
      } catch (e) {
        console.warn('[Blinn→AggieSB] sync failed:', e);
      } finally {
        running = false;
      }
    }

    function toast(msg) {
      const t = document.createElement('div');
      t.setAttribute('role', 'status');
      t.textContent = '✓ ' + msg;
      Object.assign(t.style, { position: 'fixed', right: '16px', bottom: '16px', zIndex: 99999, maxWidth: '360px',
        background: '#500000', color: '#fff', padding: '10px 14px', borderRadius: '6px', font: '14px/1.4 sans-serif',
        boxShadow: '0 4px 14px rgba(0,0,0,.3)' });
      document.body.appendChild(t);
      setTimeout(() => t.remove(), 6000);
    }

    setTimeout(sync, 1500);
    // Re-sync after you submit adds/drops, and occasionally while the page is open.
    document.addEventListener('click', e => {
      if (e.target.closest('#saveButton, button[id*="save" i]')) setTimeout(sync, 4000);
    }, true);
    setInterval(() => { if (!document.hidden) sync(); }, 120000);
  }

  // ===========================================================================
  // TAMU College Scheduler: draw saved Blinn classes + section previews.
  // ===========================================================================
  function tamuSide() {
    const CHIP = 'bsx-chip', HIDDEN = 'data-bsx-hidden', BAR = 'bsx-bar';
    const PALETTE = ['240, 147, 43', '142, 99, 206', '0, 150, 136', '216, 27, 96', '121, 85, 72', '96, 125, 139'];
    const PREVIEW_PALETTE = ['0, 172, 193', '124, 179, 66', '244, 81, 30', '94, 53, 177', '255, 179, 0', '0, 121, 107'];
    const DAY_CODES = { M: 'Monday', T: 'Tuesday', W: 'Wednesday', Th: 'Thursday', R: 'Thursday', F: 'Friday',
      S: 'Saturday', Sa: 'Saturday', Su: 'Sunday', U: 'Sunday' };

    const mins = t => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
    const fmt = t => { let [h, m] = t.split(':').map(Number); const ap = h >= 12 ? 'pm' : 'am'; h = h % 12 || 12; return `${h}:${String(m).padStart(2, '0')}${ap}`; };
    const labelMins = s => { const m = s.trim().match(/^(\d{1,2})(?::(\d\d))?\s*(am|pm)?$/i); if (!m) return null; let h = +m[1] % 12; if (/pm/i.test(m[3] || '')) h += 12; return h * 60 + (+m[2] || 0); };
    const usDate = iso => { const m = String(iso || '').match(/^(\d{4})-(\d\d)-(\d\d)/); return m ? `${m[2]}/${m[3]}/${m[1]}` : ''; };
    const tamuTerm = () => { const p = location.pathname.split('/'); return p[1] === 'terms' && p[2] ? decodeURIComponent(p[2]) : null; };
    const STALE_DAYS = 7;

    // ---- week awareness: only draw a meeting on days inside its start/end dates --------
    const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const parseUS = s => { const m = String(s || '').match(/(\d\d)\/(\d\d)\/(\d{4})/); return m ? new Date(+m[3], +m[1] - 1, +m[2]) : null; };
    function selectedWeek(cal) {
      // The scheduler shows e.g. <h2>Week 2 (01/25/2027 - 02/01/2027)</h2> above the calendar.
      const h = [...cal.parentElement.querySelectorAll('h1, h2, h3, h4')].find(e => /Week\s*\d+\s*\(/.test(e.textContent));
      const m = h?.textContent.match(/\((\d\d\/\d\d\/\d{4})\s*-\s*\d\d\/\d\d\/\d{4}\)/);
      return m ? { label: h.textContent.trim(), start: parseUS(m[1]) } : null;
    }
    function meetsOn(c, week, day) {
      if (!week) return true; // no week selector found → show everything
      const [from, to] = String(c.dates || '').split(/\s+-\s+/).map(parseUS);
      if (!from || !to) return true;
      const d = new Date(week.start);
      d.setDate(d.getDate() + ((WEEKDAYS.indexOf(day) - d.getDay() + 7) % 7));
      return d >= from && d <= to;
    }

    const css = `
      .${CHIP}{position:absolute;left:0;width:100%;color:#000;font-size:14px;padding:0;border:none;z-index:1}
      .${CHIP} .b-bg{border-left:4px solid var(--c);position:relative;overflow:hidden;background:#fff;height:100%;box-sizing:border-box}
      .${CHIP} .b-wrap{background-color:var(--c);opacity:.2;height:100%;
        background-image:linear-gradient(135deg,rgba(255,255,255,.15) 25%,transparent 25%,transparent 50%,rgba(255,255,255,.15) 50%,rgba(255,255,255,.15) 75%,transparent 75%,transparent);
        background-size:20px 20px}
      .${CHIP}:hover .b-wrap,.${CHIP}:focus-within .b-wrap{opacity:.3}
      .${CHIP} .b-detail{overflow:hidden;width:100%;top:0;position:absolute;text-align:center;font-weight:500}
      .${CHIP} .b-info{cursor:pointer;float:left;background:transparent;border:1px solid transparent;color:#333;min-width:24px;min-height:24px;
        padding:2px 5px 1px;line-height:1.5;border-radius:3px;font-size:18px;margin:0}
      .${CHIP} .b-info:hover,.${CHIP} .b-info:focus{border-color:#ddd;outline:0}
      .${CHIP} .b-info:focus-visible{box-shadow:rgba(22,121,166,.5) 0 0 0 3px}
      .${CHIP} .b-info .fa{vertical-align:middle;font-size:22px;color:rgb(20,136,188);padding-top:2px}
      .${CHIP} .b-compact{display:none}
      .${CHIP}.b-narrow .b-full{display:none}
      .${CHIP}.b-narrow .b-compact{display:block;font-size:12px;line-height:1.25}
      .${CHIP}.b-narrow .b-info{float:none;display:block;margin:1px auto 0;padding:0 2px;min-height:0;font-size:14px}
      .${CHIP}.b-narrow .b-info .fa{font-size:16px;padding-top:0}
      [${HIDDEN}]{display:none!important}
      .${BAR}{display:flex;flex-wrap:wrap;gap:6px 14px;align-items:center;margin:0 0 8px;padding:8px 12px;border-left:4px solid #500000;
        background:#f7f2f2;font-size:13px;color:#1a1a1a}
      .${BAR} .bsx-status{flex:1 1 260px}
      .${BAR} form{display:flex;gap:6px;align-items:center;margin:0}
      .${BAR} input{width:170px;padding:3px 6px;border:1px solid #bbb;border-radius:3px;font:inherit;background:#fff;color:#222}
      .${BAR} input::placeholder{color:#888}
      .${BAR} button{padding:3px 10px;border:1px solid #500000;border-radius:3px;background:#500000;color:#fff;font:inherit;cursor:pointer}
      .${BAR} .bsx-pv{display:inline-flex;align-items:center;gap:4px;padding:1px 4px 1px 8px;border-radius:10px;background:rgba(73,134,231,.15)}
      .${BAR} .bsx-pv button{background:none;border:none;color:#333;padding:0 4px;font-size:15px;line-height:1}
      .${BAR} .bsx-dot{display:inline-block;width:9px;height:9px;border-radius:50%}
      .${BAR} .bsx-clear{background:none;border:1px solid #999;color:#333;padding:1px 8px}
      .${BAR} .bsx-err,.${BAR} .bsx-warn{color:#b00020}
      /* Section-details modal: Bootstrap 3 classes from the page + copies of the scheduler's own modal styles.
         The dialog is capped to the window with a pinned header (× always reachable) and a scrolling body,
         so long Blinn details (e.g. Prerequisites) can't push the top out of reach. */
      .bsx-modal .modal-dialog{margin:30px auto;height:auto;min-height:0}
      .bsx-modal .modal-content{display:flex;flex-direction:column;max-height:calc(100vh - 60px)}
      .bsx-modal .modal-header{flex:0 0 auto}
      .bsx-modal .modal-body{flex:1 1 auto;min-height:0;overflow-y:auto;overscroll-behavior:contain}
      .bsx-modal .bsx-m-title{display:inline-block;font-size:1.5em;font-weight:bold;line-height:1.2;padding-left:10px}
      .bsx-modal .bsx-m-tag{display:inline-block;vertical-align:middle;margin-left:10px;font-size:11px;font-weight:600;padding:2px 7px;
        border-radius:3px;background:var(--c,#500000);color:#fff}
      .bsx-modal .bsx-m-close{float:right;border-radius:4px;cursor:pointer;background:transparent;border:1px solid transparent;color:#333;
        padding:2px 8px;line-height:1.42857}
      .bsx-modal .bsx-m-close:hover,.bsx-modal .bsx-m-close:focus{border-color:#ddd;outline:0}
      .bsx-modal .bsx-m-close:focus-visible{box-shadow:rgba(22,121,166,.5) 0 0 0 3px}
      .bsx-modal .bsx-m-close .fa{font-size:16px;color:#737373;vertical-align:middle}
      .bsx-modal .bsx-m-details{margin-top:20px;margin-bottom:20px;overflow-wrap:break-word}
      .bsx-modal .bsx-m-fields{list-style-type:none;margin-bottom:0;text-align:left;padding-left:40px}
      .bsx-modal .bsx-m-fields a{color:rgb(47,111,167)}
      .bsx-modal .bsx-m-fields a:hover,.bsx-modal .bsx-m-fields a:focus{color:rgb(33,77,117)}
      .bsx-modal .bsx-m-meetings{padding-left:15px}
      .bsx-modal .bsx-m-meetings > div{margin-bottom:6px}
      .bsx-modal .bsx-m-dates{padding-bottom:4px}
      :is(.bsx-modal,.bsx-native) .bsx-m-more{border-top:1px solid #e5e5e5;padding:10px 15px 0}
      :is(.bsx-modal,.bsx-native) details{border-bottom:1px solid #eee;padding:7px 0}
      :is(.bsx-modal,.bsx-native) summary{cursor:pointer;font-weight:bold;color:#333;font-size:14px}
      .bsx-sec{padding:6px 0 2px 18px;font-size:13px;line-height:1.5;color:#333}
      .bsx-sec p{margin:0 0 6px}
      .bsx-sec ul{margin:2px 0 6px;padding-left:18px}
      .bsx-sec li{margin:3px 0}
      .bsx-sec h5{margin:8px 0 2px;font-size:12px;font-weight:bold;color:#555}
      .bsx-sec h5:first-child{margin-top:0}
      .bsx-sec .muted{color:#6b6b6b}
      .bsx-sec .meta{color:#6b6b6b;font-size:12px;margin-bottom:4px}
      .bsx-sec .note{color:#6b6b6b;font-size:12px;font-style:italic;margin-top:6px}
      .bsx-sec .bsx-lead{margin-bottom:2px}
      .bsx-sec .plus{color:#888;font-size:12px;font-style:italic;margin:0 6px}
      .bsx-sec .grade{display:inline-block;margin-left:8px;padding:0 7px;border-radius:9px;background:#eef2f7;color:#2f4a6b;
        font-size:11px;font-weight:600;line-height:18px;vertical-align:1px;cursor:help}
      .bsx-sec .fee{display:flex;justify-content:space-between;max-width:360px}
      .bsx-sec .txt{white-space:pre-line}
      .${BAR} .bsx-rmp-toggle{display:inline-flex;align-items:center;gap:4px;margin:0;font-weight:normal;cursor:pointer}
      .${BAR} .bsx-rmp-toggle input{width:auto;margin:0}
      :is(.bsx-modal,.bsx-native) .bsx-rmp-link{font-size:11px;font-weight:600;margin-left:4px;white-space:nowrap}
      :is(.bsx-modal,.bsx-native) .bsx-rmp-slot{display:block;margin:1px 0 3px}
      :is(.bsx-modal,.bsx-native) .bsx-rmp-score{font-weight:bold}
      :is(.bsx-modal,.bsx-native) .bsx-rmp-meta{color:#6b6b6b;font-size:12px}
      .bsx-grades .gd-diff{font-size:12px;font-weight:600;margin-left:6px}
      .bsx-grades .gd-bar{display:flex;height:14px;border-radius:3px;overflow:hidden;margin:6px 0 4px;max-width:520px;background:#eee}
      .bsx-grades .gd-bar span{display:block;height:100%}
      .bsx-grades .gd-legend{display:flex;flex-wrap:wrap;gap:4px 12px;font-size:12px;margin-bottom:6px}
      .bsx-grades .gd-legend i{display:inline-block;width:9px;height:9px;border-radius:2px;margin-right:4px;vertical-align:0}
      .bsx-grades .gd-terms{margin-top:8px;font-size:12px;border-collapse:collapse}
      .bsx-grades .gd-terms th{color:#6b6b6b;font-weight:600;text-align:left;padding:2px 14px 2px 0;border-bottom:1px solid #e5e5e5}
      .bsx-grades .gd-terms td{padding:2px 14px 2px 0}`;

    function ensureStyle() {
      if (document.getElementById('bsx-style')) return;
      const s = document.createElement('style');
      s.id = 'bsx-style'; s.textContent = css;
      document.head.appendChild(s);
    }

    // ---- data ---------------------------------------------------------------
    function blinnFor(term) {
      const key = seasonKey(term);
      const terms = Object.values(getVal(STORE, {})).filter(t => key && seasonKey(t.description) === key);
      const crns = [...new Set(terms.flatMap(t => t.classes.map(c => c.crn)))];
      const classes = terms.flatMap(t => t.classes.map(c => ({ ...c, color: PALETTE[crns.indexOf(c.crn) % PALETTE.length],
        tag: 'Blinn College · Registered', kind: 'blinn', termCode: t.code })));
      const syncedAt = Math.max(0, ...terms.map(t => t.syncedAt || 0));
      const otherTerms = Object.values(getVal(STORE, {}))
        .filter(t => !terms.includes(t) && t.classes?.length).map(t => t.description);
      return { classes, syncedAt, matched: terms.length > 0, otherTerms };
    }
    const previewsFor = term => getVal(PREVIEWS, {})[term] || [];
    function savePreviews(term, list) {
      const all = getVal(PREVIEWS, {});
      if (list.length) all[term] = list; else delete all[term];
      setVal(PREVIEWS, all);
      schedule();
    }

    // Parses "CSCE 120 519", "CSCE 120 515 519", "CSCE 120 515, 519", "CSCE 120 515; MATH 151 501".
    // A bare section number reuses the course before it.
    function parsePreviewInput(text) {
      const out = [];
      let course = null;
      for (const part of text.toUpperCase().split(/[,;]+/).map(s => s.trim()).filter(Boolean)) {
        const m = part.match(/^([A-Z]{2,5})\s*-?\s*(\d{3,4}[A-Z]?)\s*[-\s]\s*((?:\d{3}[A-Z]?[\s-]*)+)$/);
        if (m) course = { subj: m[1], num: m[2] };
        const secs = m ? m[3] : (/^(\d{3}[A-Z]?[\s-]*)+$/.test(part) ? part : null);
        if (!secs || !course) throw new Error(`Couldn't read "${part}". Use the format: CSCE 120 515, 519`);
        for (const sec of secs.match(/\d{3}[A-Z]?/g)) out.push({ ...course, sec });
      }
      if (!out.length) throw new Error('Type a section, e.g. CSCE 120 519');
      return out;
    }

    async function addPreview(term, text) {
      const wanted = parsePreviewInput(text);
      const courseData = {};
      const errors = [];
      const list = previewsFor(term);
      for (const { subj, num, sec } of wanted) {
        const key = `${subj} ${num}`;
        try {
          if (!(key in courseData)) {
            const url = `/api/terms/${encodeURIComponent(term)}/subjects/${subj}/courses/${num}/regblocks`;
            const r = await fetch(url, { credentials: 'same-origin', headers: { Accept: 'application/json' } });
            courseData[key] = r.ok ? await r.json() : null;
          }
          const data = courseData[key];
          if (!data) throw new Error(`Couldn't find ${key} this term.`);
          const s = (data.sections || []).find(x => String(x.sectionNumber) === sec);
          if (!s) throw new Error(`${key} has no section ${sec}.`);
          const instructor = (s.instructor || []).map(i => i.name).join('; ') || 'TBA';
          const meetings = [];
          for (const mt of s.meetings || []) {
            const days = (String(mt.days || '').match(/Th|Su|Sa|[MTWRFSU]/g) || []).map(d => DAY_CODES[d]).filter(Boolean);
            if (!days.length || !mt.startTime || !mt.endTime) continue;
            const t = n => `${String(Math.floor(n / 100)).padStart(2, '0')}:${String(n % 100).padStart(2, '0')}`;
            meetings.push({ subj, num, section: sec, title: data.sections[0]?.title || s.title || key, crn: String(s.registrationNumber),
              type: mt.meetingTypeDescription || '', days: [...new Set(days)], start: t(mt.startTime), end: t(mt.endTime),
              room: mt.location || 'TBA', instructor, campus: s.campus || 'Texas A&M',
              dates: `${usDate(mt.startDate)} - ${usDate(mt.endDate)}` });
          }
          if (!meetings.length) throw new Error(`${key}-${sec} has no scheduled meeting times.`);
          const label = `${key}-${sec}`;
          const i = list.findIndex(p => p.label === label);
          const entry = { course: key, label, open: s.openSeats, meetings,
            info: { credits: s.credits ?? s.creditsMin, component: s.component, campus: s.campus,
              mode: s.instructionMode, capacity: s.seatsCapacity, waitlist: s.waitlist,
              attributes: (s.sectionAttributes || []).map(a => a.valueTitle).filter(Boolean) } };
          if (i >= 0) list[i] = entry; else list.push(entry);
        } catch (e) { errors.push(e.message); }
      }
      savePreviews(term, list);
      if (errors.length) throw new Error(errors.join(' '));
    }

    // ---- section-details modal (same look as the scheduler's own ⓘ dialog) -------------
    const DAY_LETTERS = { Monday: 'M', Tuesday: 'T', Wednesday: 'W', Thursday: 'Th', Friday: 'F', Saturday: 'S', Sunday: 'Su' };
    const field = (k, v) => (v == null || v === '' ? '' : `<li><strong><span>${esc(k)}</span>: </strong><span>${v}</span></li>`);
    const meetingHtml = (m, linkRooms) => {
      const room = linkRooms && /^[A-Z]{2,5}\s/.test(m.room)
        ? `<a href="https://aggiemap.tamu.edu/?ref=howdy&BldgAbbrv=${encodeURIComponent(m.room.split(' ')[0])}" target="_blank" rel="noreferrer noopener">${esc(m.room)}</a>`
        : esc(m.room);
      return `<div><span class="sr-only">${esc(m.days.join(', '))} ${fmt(m.start)} to ${fmt(m.end)} at ${esc(m.room)}</span>
        <span aria-hidden="true">${m.days.map(d => `<span aria-label="${d}">${DAY_LETTERS[d] || d}</span>`).join('')} ${fmt(m.start)} - ${fmt(m.end)} ${room}${m.type ? ` <span style="opacity:.7">(${esc(m.type)})</span>` : ''}</span>
        ${m.dates ? `<div class="bsx-m-dates">Dates: <span>${esc(m.dates)}</span></div>` : ''}</div>`;
    };

    // ---- readable rendering of Blinn's "Class Details" tabs ------------------------------
    const linkHtml = l => `<a href="${esc(l.href)}" target="_blank" rel="noopener noreferrer">${esc(l.text)}</a>`;
    const plain = s => `<div class="bsx-sec"><div class="txt">${esc(s.lines.filter(l => !(s.links || []).some(k => k.text === l)).join('\n'))}</div>${
      (s.links || []).map(linkHtml).join('<br>')}</div>`;

    // "MATH - Mathematics 2412 to 2415" → "MATH 2412–2415"
    const cleanCourse = s => { const m = s.match(/^([A-Z]{2,5}) - .*? (\d{3,4}[A-Z]?(?: to \d{3,4}[A-Z]?)?)$/); return m ? `${m[1]} ${m[2].replace(' to ', '–')}` : s; };

    // Banner lists every accepted grade variant (C, TC, CR, TCR, P, TP…) as a separate "( … ) or" group.
    // Parse into options (AND-lists of courses), merge options that differ only by grade, and pull out test scores.
    function parsePrereqs(lines) {
      const options = [], tests = [];
      let cur = null, req = null, depth = 0, noConcurrent = false;
      const newOption = () => { cur = { reqs: [] }; options.push(cur); };
      for (const l of lines) {
        let m;
        if (/^Area Prerequisites$/i.test(l) || /^Prerequisites?:/i.test(l)) continue;
        if (l === '(') { depth++; newOption(); req = null; continue; }
        if (l === ')') { depth = Math.max(0, depth - 1); req = null; if (!depth) cur = null; continue; }
        if (/^or$/i.test(l)) { if (depth) return null; cur = null; req = null; continue; }
        if (/^and$/i.test(l)) { req = null; continue; }
        if ((m = l.match(/^Course or Test:\s*(.+)$/i))) { if (!cur) newOption(); req = { what: cleanCourse(m[1]), grade: '' }; cur.reqs.push(req); continue; }
        if ((m = l.match(/^Minimum Grade of\s+(\S+)/i))) { if (req) req.grade = m[1]; continue; }
        if (/^May not be taken concurrently\.?$/i.test(l)) { noConcurrent = true; continue; }
        if ((m = l.match(/^(.+?)\s+(\d+)\s+to\s+(\d+)$/))) { tests.push(`${m[1]} ${m[2]}–${m[3]}`); continue; }
        return null; // unfamiliar layout → caller falls back to plain text
      }
      const merged = new Map();
      for (const o of options) {
        if (!o.reqs.length) continue;
        const key = o.reqs.map(r => r.what).join(' + ');
        const e = merged.get(key) || { reqs: o.reqs.map(r => r.what), grades: [] };
        for (const r of o.reqs) if (r.grade && !e.grades.includes(r.grade)) e.grades.push(r.grade);
        merged.set(key, e);
      }
      return { options: [...merged.values()], tests, noConcurrent };
    }

    function renderPrereqs(s) {
      const p = parsePrereqs(s.lines);
      if (!p || (!p.options.length && !p.tests.length)) return plain(s);
      const items = p.options.map(o => {
        const main = o.grades.find(g => /^[A-D]$/.test(g)) || o.grades[0];
        const grade = main ? `<span class="grade" title="Accepted grades: ${esc(o.grades.join(', '))}">${esc(main)}${/^[A-D]$/.test(main) ? ' or better' : ''}</span>` : '';
        return `<li>${o.reqs.map(r => `<b>${esc(r)}</b>`).join('<span class="plus">and</span>')}${grade}</li>`;
      });
      if (p.tests.length) items.push(`<li>Placement score <span class="muted">— ${p.tests.map(esc).join(' · ')}</span></li>`);
      const notes = [
        p.options.some(o => o.grades.length > 1) && 'Transfer (T…), credit (CR) and pass (P) equivalents also count. Hover a grade to see all of them.',
        p.noConcurrent && "Prerequisites have to be finished first — they can't be taken at the same time as this course.",
      ].filter(Boolean);
      return `<div class="bsx-sec"><div class="bsx-lead">${items.length > 1 ? 'Any <b>one</b> of:' : 'Requires:'}</div><ul>${items.join('')}</ul>${
        notes.map(n => `<div class="note">${esc(n)}</div>`).join('')}</div>`;
    }

    function renderRestrictions(s) {
      let html = '', open = false;
      const notes = [];
      for (const l of s.lines) {
        if (/^Not all restrictions are applicable/i.test(l)) { notes.push(l); continue; }
        if (/:$/.test(l)) { html += (open ? '</ul>' : '') + `<h5>${esc(l.slice(0, -1))}</h5><ul>`; open = true; continue; }
        if (!open) { html += '<ul>'; open = true; }
        html += `<li>${esc(l)}</li>`;
      }
      return `<div class="bsx-sec">${html}${open ? '</ul>' : ''}${notes.map(n => `<div class="note">${esc(n)}</div>`).join('')}</div>`;
    }

    function renderFees(s) {
      const rows = s.lines.map(l => l.split(' | ')).filter(r => r.length > 1 && !/^(Level|Description)$/i.test(r[0]));
      if (!rows.length) return plain(s);
      return `<div class="bsx-sec">${rows.map(r => `<div class="fee"><span>${esc(r.slice(0, -1).join(' · '))}</span><b>${esc(r[r.length - 1])}</b></div>`).join('')}</div>`;
    }

    function renderDescription(s) {
      const text = s.lines.join(' ');
      const m = text.match(/^(.*?Credit:\s*\d+\s*semester hours?\.)\s*(.*)$/i);
      return `<div class="bsx-sec">${m ? `<div class="meta">${esc(m[1])}</div><p>${esc(m[2])}</p>` : `<p>${esc(text)}</p>`}</div>`;
    }

    function renderBookstore(s) {
      const text = s.lines.filter(l => !(s.links || []).some(k => k.text === l));
      return `<div class="bsx-sec">${text.map(t => `<div class="meta">${esc(t)}</div>`).join('')}${(s.links || []).map(linkHtml).join(' · ')}</div>`;
    }

    function renderSection(s) {
      try {
        switch (s.key) {
          case 'prerequisites': return renderPrereqs(s);
          case 'restrictions': return renderRestrictions(s);
          case 'fees': return renderFees(s);
          case 'description': return renderDescription(s);
          case 'bookstore': return renderBookstore(s);
          case 'grades': return `<div class="bsx-sec bsx-grades" data-subj="${esc(s.subj)}" data-num="${esc(s.num)}" data-instr="${esc(s.instructor)}"><span class="muted">Loading grades from anex.us…</span></div>`;
          default: return `<div class="bsx-sec"><ul>${s.lines.map(l => `<li>${esc(l)}</li>`).join('')}</ul>${(s.links || []).map(linkHtml).join(' · ')}</div>`;
        }
      } catch { return plain(s); }
    }

    function blinnModel(c) {
      const t = getVal(STORE, {})[c.termCode] || {};
      const d = t.details?.[c.crn] || {};
      const meetings = (t.classes || []).filter(x => x.crn === c.crn);
      const kv = sec => (sec?.lines || []).map(l => { const i = l.indexOf(':'); return i > 0 && i < 40 ? [l.slice(0, i).trim(), l.slice(i + 1).trim()] : [null, l]; });
      const left = [];
      if (d.classDetails) {
        for (const [k, v] of kv(d.classDetails)) if (k && k !== 'Grade Mode') left.push(field(k, esc(v)));
      } else {
        left.push(field('Title', esc(c.title)), field('CRN', esc(c.crn)), field('Subject', esc(c.subj)), field('Course Number', esc(c.num)));
      }
      left.push(field('Instructor', instructorHtml([...new Set(meetings.map(m => m.instructor))].join('; '), 'blinn')));
      for (const [k, v] of kv(d.enrollment)) if (k) left.push(field(k, esc(v)));
      if (d.attributes) left.push(field('Section Attributes', esc(d.attributes.lines.join(', '))));
      const more = ['description', 'prerequisites', 'corequisites', 'restrictions', 'fees', 'bookstore', 'linked', 'crossList']
        .filter(k => d[k]).map(k => ({ ...d[k], key: k }));
      return { title: `${c.subj} ${c.num}`, subtitle: c.title, tag: 'Blinn College · Registered', color: c.color,
        left, meetings, linkRooms: false, more,
        note: d.classDetails ? '' : 'Re-open Blinn → Register for Classes to load the full class details.' };
    }

    function previewModel(c) {
      const p = previewsFor(tamuTerm()).find(x => x.label === c.pkey);
      if (!p) return null;
      const i = p.info || {}, m0 = p.meetings[0];
      const seats = p.open != null ? `${p.open}${i.capacity ? ` of ${esc(i.capacity)}` : ''}` : null;
      const left = [field('Title', esc(m0.title)), field('CRN #', esc(m0.crn)), field('Section', esc(c.section)), field('Subject', esc(m0.subj)),
        field('Course', esc(m0.num)), field('Seats Open', seats), field('Waitlist', i.waitlist && i.waitlist !== '0' ? esc(i.waitlist) : null),
        field('Component', esc(i.component)), field('Instruction Mode', esc(i.mode)), field('Instructor', instructorHtml(m0.instructor, 'tamu')),
        field('Campus', esc(i.campus || m0.campus)), field('Credits', esc(i.credits)),
        field('Section Attributes', i.attributes?.length ? esc(i.attributes.join(', ')) : null)];
      return { title: `${m0.subj} ${m0.num}`, subtitle: m0.title, tag: 'Preview · not in your cart', color: c.color,
        left, meetings: p.meetings, linkRooms: true, note: '',
        more: [{ key: 'grades', title: 'Grade distribution', open: true, subj: m0.subj, num: m0.num, instructor: m0.instructor }] };
    }

    let lastFocus = null;
    function closeModal() {
      document.querySelectorAll('.bsx-modal, .bsx-backdrop').forEach(e => e.remove());
      if (!document.querySelector('.modal.in:not(.bsx-modal)')) document.body.classList.remove('modal-open');
      lastFocus?.focus?.();
    }
    function openModal(model, trigger) {
      if (!model) return;
      closeModal();
      lastFocus = trigger;
      const backdrop = document.createElement('div');
      backdrop.className = 'fade modal-backdrop in bsx-backdrop';
      const m = document.createElement('div');
      m.className = 'fade in modal bsx-modal';
      Object.assign(m, { tabIndex: -1 });
      m.setAttribute('role', 'dialog'); m.setAttribute('aria-modal', 'true'); m.setAttribute('aria-labelledby', 'bsx-m-title');
      m.style.display = 'block';
      m.style.setProperty('--c', rgb(model.color));
      m.innerHTML = `<div class="modal-lg modal-dialog"><div class="modal-content" role="document">
        <div class="modal-header">
          <span class="bsx-m-title" id="bsx-m-title">${esc(model.title)} <span style="font-weight:normal">- ${esc(model.subtitle)}</span></span>
          <span class="bsx-m-tag">${esc(model.tag)}</span>
          <button type="button" class="bsx-m-close" aria-label="Close Modal"><span aria-hidden="true" class="fa fa-times"></span></button>
        </div>
        <div class="modal-body">
          <div class="bsx-m-details row">
            <div class="col-md-6"><ul class="bsx-m-fields">${model.left.join('')}</ul></div>
            <div class="col-md-6"><ul class="bsx-m-fields"><li><strong><span>Day(s) &amp; Location(s)</span>: </strong>
              <div class="bsx-m-meetings">${model.meetings.map(x => meetingHtml(x, model.linkRooms)).join('')}</div></li></ul></div>
          </div>
          ${model.note ? `<p style="padding-left:15px;opacity:.75">${esc(model.note)}</p>` : ''}
          ${model.more.length ? `<div class="bsx-m-more">${model.more.map(s =>
            `<details${s.open ? ' open' : ''}><summary>${esc(s.title)}</summary>${renderSection(s)}</details>`).join('')}</div>` : ''}
        </div></div></div>`;
      document.body.append(backdrop, m);
      document.body.classList.add('modal-open');
      m.querySelector('.bsx-m-close').addEventListener('click', closeModal);
      m.addEventListener('click', e => { if (e.target === m) closeModal(); });   // click outside the dialog
      m.addEventListener('keydown', e => {
        if (e.key === 'Escape') { e.stopPropagation(); closeModal(); }
        if (e.key === 'Tab') {                                                     // keep focus inside the dialog
          const f = [...m.querySelectorAll('button, a[href], summary')];
          if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f[f.length - 1].focus(); }
          else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { e.preventDefault(); f[0].focus(); }
        }
      });
      m.querySelector('.bsx-m-close').focus();
      fillRmpSlots(m);
      fillGrades(m);
    }

    const rgb = color => (/^rgb/.test(color) ? color : `rgb(${color})`);

    // ---- Rate My Professors ------------------------------------------------------------
    // Links always work (plain search/profile URLs). Inline scores are opt-in (toolbar checkbox): RMP has no
    // public API, so they come from the GraphQL endpoint its own website uses and may break if RMP changes it.
    const RMP = {
      endpoint: 'https://www.ratemyprofessors.com/graphql',
      schools: { // RMP school ids. Blinn is split across several campus entries.
        tamu: ['U2Nob29sLTEwMDM='],                                                          // Texas A&M (1003)
        blinn: ['U2Nob29sLTQyNzU=', 'U2Nob29sLTE3Mzk=', 'U2Nob29sLTEzNTk3', 'U2Nob29sLTQ3MTk='], // 4275, 1739, 13597, 4719
      },
      searchSchool: { tamu: 1003, blinn: 4275 },
      TTL: 7 * 864e5,
      QUERY: 'query($t:String!,$s:ID){newSearch{teachers(query:{text:$t,schoolID:$s},first:10){edges{node{legacyId firstName lastName department avgRating avgDifficulty numRatings wouldTakeAgainPercent}}}}}',
    };
    const rmpOn = () => !!getVal('rmpScores', false);
    const splitName = full => { const [last = '', rest = ''] = String(full).split(',').map(s => s.trim()); return { first: rest.split(/\s+/)[0] || '', last }; };
    const instructorsOf = s => String(s || '').split(/\s*;\s*/).filter(n => n && n !== 'TBA');
    const rmpKey = (name, kind) => `${kind}:${name.toLowerCase()}`;
    const rmpCached = (name, kind) => { const e = getVal('rmpCache', {})[rmpKey(name, kind)]; return e && Date.now() - e.t < RMP.TTL ? e : null; };
    const rmpUrl = (name, kind, data) => data?.id ? `https://www.ratemyprofessors.com/professor/${encodeURIComponent(data.id)}`
      : `https://www.ratemyprofessors.com/search/professors/${RMP.searchSchool[kind]}?q=${encodeURIComponent(Object.values(splitName(name)).join(' ').trim())}`;
    const ratingColor = r => (r >= 4 ? '#1b7f3b' : r >= 3 ? '#a66a00' : '#b00020');

    function gmRequest({ url, data, headers, timeout = 15000 }) {
      return new Promise((resolve, reject) => {
        if (typeof GM_xmlhttpRequest !== 'function') return reject(new Error('GM_xmlhttpRequest unavailable'));
        GM_xmlhttpRequest({ method: 'POST', url, data, headers, timeout,
          onload: r => (r.status && r.status >= 400 ? reject(new Error(`HTTP ${r.status}`)) : resolve(r.responseText)),
          onerror: reject, ontimeout: () => reject(new Error('timeout')) });
      });
    }
    const gmPost = async body => JSON.parse(await gmRequest({ url: RMP.endpoint, data: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json', Authorization: 'Basic dGVzdDp0ZXN0' } })); // the public token RMP's own site uses
    const rmpInflight = {}, rmpFailed = {};
    function rmpLookup(name, kind) {
      const hit = rmpCached(name, kind);
      if (hit) return Promise.resolve(hit.data);
      const key = rmpKey(name, kind);
      return (rmpInflight[key] ??= (async () => {
        const { first, last } = splitName(name);
        const norm = s => String(s || '').toLowerCase().replace(/[^a-z]/g, '');
        // Search every campus entry: the same instructor can be listed under several (e.g. "Cicily" at Blinn Brenham
        // with most ratings and "Cindy" at Blinn College). Prefer an exact first-name match, then the most ratings.
        const matches = [];
        for (const sid of RMP.schools[kind] || []) {
          const j = await gmPost({ query: RMP.QUERY, variables: { t: `${first} ${last}`.trim(), s: sid } });
          for (const n of (j?.data?.newSearch?.teachers?.edges || []).map(e => e.node)) {
            if (norm(n.lastName) !== norm(last) || (first && norm(n.firstName)[0] !== norm(first)[0])) continue;
            if (!matches.some(x => x.legacyId === n.legacyId)) matches.push({ ...n, score: (norm(n.firstName) === norm(first) ? 1e6 : 0) + (n.numRatings || 0) });
          }
        }
        matches.sort((a, b) => b.score - a.score);
        const [best, ...rest] = matches;
        const data = best ? { id: best.legacyId, rating: best.avgRating, difficulty: best.avgDifficulty, count: best.numRatings,
          wta: best.wouldTakeAgainPercent, dept: best.department,
          others: rest.filter(n => n.numRatings > 0).map(n => ({ id: n.legacyId, name: `${n.firstName} ${n.lastName}`, rating: n.avgRating, count: n.numRatings })) } : null;
        const cache = getVal('rmpCache', {});
        cache[key] = { t: Date.now(), data };
        setVal('rmpCache', cache);
        return data;
      })().finally(() => { delete rmpInflight[key]; }));
    }

    function rmpScoreHtml(name, kind, d) {
      if (!d) return `<span class="bsx-rmp-meta">No Rate My Professors profile found</span>`;
      if (!d.count) return `<span class="bsx-rmp-meta">On Rate My Professors, no ratings yet</span>`;
      return `<a class="bsx-rmp-score" href="${esc(rmpUrl(name, kind, d))}" target="_blank" rel="noopener noreferrer" style="color:${ratingColor(d.rating)}">★ ${d.rating.toFixed(1)}</a>`
        + `<span class="bsx-rmp-meta"> · difficulty ${d.difficulty.toFixed(1)}${d.wta >= 0 ? ` · ${Math.round(d.wta)}% would take again` : ''} · ${d.count} rating${d.count === 1 ? '' : 's'}</span>`
        + (d.others?.length ? `<div class="bsx-rmp-meta">Also listed as ${d.others.map(o =>
          `<a href="https://www.ratemyprofessors.com/professor/${encodeURIComponent(o.id)}" target="_blank" rel="noopener noreferrer">${esc(o.name)}</a> (★ ${Number(o.rating).toFixed(1)}, ${o.count})`).join(', ')}</div>` : '');
    }
    // Instructor field for the details dialog: name + RMP link, plus a score slot filled in after opening.
    function instructorHtml(names, kind) {
      const list = instructorsOf(names);
      if (!list.length) return esc(names || 'TBA');
      return list.map(n => {
        const d = rmpCached(n, kind)?.data;
        return `<span class="bsx-instr">${esc(n)} <a class="bsx-rmp-link" href="${esc(rmpUrl(n, kind, d))}" target="_blank" rel="noopener noreferrer" title="Open on Rate My Professors">RMP ↗</a>`
          + (rmpOn() ? `<span class="bsx-rmp-slot" data-name="${esc(n)}" data-kind="${kind}"> <span class="bsx-rmp-meta">Loading rating…</span></span>` : '') + '</span>';
      }).join('; ');
    }
    function fillRmpSlots(root) {
      root.querySelectorAll('.bsx-rmp-slot').forEach(async slot => {
        const { name, kind } = slot.dataset;
        try {
          const d = await rmpLookup(name, kind);
          slot.innerHTML = rmpScoreHtml(name, kind, d);
          const link = slot.parentElement.querySelector('.bsx-rmp-link');
          if (link) link.href = rmpUrl(name, kind, d);
        } catch {
          slot.innerHTML = '<span class="bsx-rmp-meta">Couldn\'t reach Rate My Professors</span>';
        }
      });
    }
    // ---- Grade distributions (anex.us, built from TAMU's public grade reports) ----------------
    // Fetched only when a preview's details dialog is opened; one request per course, cached 7 days.
    // anex.us only covers TAMU, so Blinn classes have no grade data.
    const ANEX = { url: 'https://anex.us/grades/getData/', TTL: 7 * 864e5 };
    const GRADES = ['A', 'B', 'C', 'D', 'F', 'Q'];
    const GRADE_COLORS = ['#2e7d32', '#7cb342', '#f9a825', '#fb8c00', '#e53935', '#9e9e9e'];
    const anexInflight = {};
    function anexLookup(subj, num) {
      const key = `${subj} ${num}`;
      const hit = getVal('anexCache', {})[key];
      if (hit && Date.now() - hit.t < ANEX.TTL) return Promise.resolve(hit.rows);
      return (anexInflight[key] ??= (async () => {
        const text = await gmRequest({ url: ANEX.url, timeout: 12000, data: new URLSearchParams({ dept: subj, number: num }).toString(),
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
        let rows = [];
        if (!/^\s*\{\s*"classes"\s*:\s*\]\s*\}\s*$/.test(text)) { // anex returns `{"classes":]}` for courses it has no data for
          rows = (JSON.parse(text).classes || []).map(r => ({ p: r.prof, y: +r.year, s: r.semester, sec: r.section, g: GRADES.map(k => +r[k] || 0) }));
        }
        const cache = getVal('anexCache', {});
        for (const k of Object.keys(cache)) if (Date.now() - cache[k].t > ANEX.TTL) delete cache[k]; // keep storage small
        cache[key] = { t: Date.now(), rows };
        setVal('anexCache', cache);
        return rows;
      })().finally(() => { delete anexInflight[key]; }));
    }
    // anex lists instructors as "RITCHEY P"; ours look like "Ritchey, Philip Carson".
    const anexName = full => { const { first, last } = splitName(full); return `${last} ${first[0] || ''}`.toUpperCase().replace(/[^A-Z ]/g, '').trim(); };
    const sumGrades = rows => rows.reduce((t, r) => { r.g.forEach((v, i) => { t[i] += v; }); return t; }, GRADES.map(() => 0));
    function gradeStats(g) {
      const n = g[0] + g[1] + g[2] + g[3] + g[4];
      return n ? { n, q: g[5], gpa: (4 * g[0] + 3 * g[1] + 2 * g[2] + g[3]) / n, pct: g.slice(0, 5).map(v => (100 * v) / n), qpct: (100 * g[5]) / (n + g[5]) } : null;
    }
    const SEM_ORDER = { SPRING: 1, SUMMER: 2, FALL: 3 };
    function gradesHtml(rows, subj, num, instructor) {
      const course = `${subj} ${num}`;
      const anexLink = `<a href="https://anex.us/grades/?dept=${encodeURIComponent(subj)}&number=${encodeURIComponent(num)}" target="_blank" rel="noopener noreferrer">anex.us ↗</a>`;
      if (!rows.length) return `<span class="muted">anex.us has no past grades for ${esc(course)}.</span> ${anexLink}`;
      const all = gradeStats(sumGrades(rows));
      const names = instructorsOf(instructor).map(anexName);
      const mine = rows.filter(r => names.some(n => r.p === n || r.p.startsWith(n + ' ')));
      const s = gradeStats(sumGrades(mine));
      const who = esc(instructorsOf(instructor).map(n => splitName(n).last).join(' / ') || 'This instructor');
      const allLine = `<div class="muted">All ${esc(course)} instructors: GPA <b>${all.gpa.toFixed(2)}</b> · A ${all.pct[0].toFixed(0)}% · D/F ${(all.pct[3] + all.pct[4]).toFixed(0)}% · ${all.n.toLocaleString()} students</div>`;
      if (!s) return `<div>No past grades for <b>${who}</b> in ${esc(course)}.</div>${allLine}<div class="note">Source: ${anexLink}</div>`;
      const bar = s.pct.map((p, i) => p > 0 ? `<span style="width:${p}%;background:${GRADE_COLORS[i]}" title="${GRADES[i]} ${p.toFixed(1)}%"></span>` : '').join('');
      const legend = GRADES.slice(0, 5).map((k, i) => `<span><i style="background:${GRADE_COLORS[i]}"></i>${k} ${s.pct[i].toFixed(0)}%</span>`).join('')
        + `<span><i style="background:${GRADE_COLORS[5]}"></i>Q-drop ${s.qpct.toFixed(0)}%</span>`;
      const diff = s.gpa - all.gpa;
      const terms = {};
      for (const r of mine) (terms[`${r.y} ${r.s}`] ??= []).push(r);
      const termRows = Object.entries(terms)
        .sort(([a], [b]) => { const [ya, sa] = a.split(' '), [yb, sb] = b.split(' '); return yb - ya || SEM_ORDER[sb] - SEM_ORDER[sa]; })
        .slice(0, 6).map(([term, rs]) => { const t = gradeStats(sumGrades(rs)); return t ? `<tr><td>${esc(term.replace(/^(\d+) (\w)(\w+)$/, (m, y, a, b) => `${a}${b.toLowerCase()} ${y}`))}</td><td>${rs.length}</td><td>${t.n}</td><td><b>${t.gpa.toFixed(2)}</b></td><td>${t.pct[0].toFixed(0)}%</td><td>${(t.pct[3] + t.pct[4]).toFixed(0)}%</td></tr>` : ''; }).join('');
      return `<div><b>${who}</b> in ${esc(course)}: GPA <b>${s.gpa.toFixed(2)}</b>
          <span class="gd-diff" style="color:${Math.abs(diff) < 0.1 ? '#6b6b6b' : diff > 0 ? '#1b7f3b' : '#b00020'}">${diff >= 0 ? '+' : '−'}${Math.abs(diff).toFixed(2)} vs. course</span>
          <span class="muted">· ${s.n.toLocaleString()} students</span></div>
        <div class="gd-bar" role="img" aria-label="${esc(GRADES.slice(0, 5).map((k, i) => `${k} ${s.pct[i].toFixed(0)}%`).join(', '))}">${bar}</div>
        <div class="gd-legend">${legend}</div>
        ${allLine}
        ${termRows ? `<table class="gd-terms"><thead><tr><th>Term</th><th>Sections</th><th>Students</th><th>GPA</th><th>A</th><th>D/F</th></tr></thead><tbody>${termRows}</tbody></table>` : ''}
        <div class="note">Source: ${anexLink} (TAMU grade reports; all of this instructor's sections, including honors)</div>`;
    }
    function fillGrades(root) {
      root.querySelectorAll('.bsx-grades').forEach(async el => {
        const { subj, num, instr } = el.dataset;
        try { el.innerHTML = gradesHtml(await anexLookup(subj, num), subj, num, instr); }
        catch { el.innerHTML = `<span class="muted">anex.us isn't responding right now. Try again later, or open <a href="https://anex.us/grades/?dept=${encodeURIComponent(subj)}&number=${encodeURIComponent(num)}" target="_blank" rel="noopener noreferrer">anex.us ↗</a>.</span>`; }
      });
    }

    // ---- Add RMP + grades to the scheduler's OWN section dialog (classes already in your cart) ------------
    function decorateNativeModal() {
      const m = [...document.querySelectorAll('.modal.in')].find(x => !x.classList.contains('bsx-modal'));
      if (!m || m.querySelector('.bsx-native')) return;
      const body = m.querySelector('.modal-body');
      const cm = (m.querySelector('.modal-header')?.textContent || '').match(/\b([A-Z]{2,5})\s+(\d{3,4}[A-Z]?)\b/);
      if (!body || !cm) return;
      const [, subj, num] = cm;
      const instrLi = [...body.querySelectorAll('li')].find(li => /^\s*Instructor\s*:/.test(li.textContent));
      const instructor = instrLi ? instrLi.textContent.replace(/^\s*Instructor\s*:\s*/, '').trim() : '';
      if (instrLi && instructorsOf(instructor).length) {
        const span = document.createElement('span');
        span.className = 'bsx-native';
        // the dialog already shows the name, so keep only the link + score slot
        span.innerHTML = ' ' + instructorHtml(instructor, 'tamu').replace(/<span class="bsx-instr">[^<]*/g, '<span class="bsx-instr">');
        instrLi.appendChild(span);
      }
      const extra = document.createElement('div');
      extra.className = 'bsx-native';
      extra.innerHTML = `<div class="bsx-m-more"><details open><summary>Grade distribution</summary>${
        renderSection({ key: 'grades', subj, num, instructor })}</details></div>`;
      body.appendChild(extra);
      fillRmpSlots(m);
      fillGrades(m);
    }

    // ★ on the scheduler's own calendar blocks (cart sections), when "RMP scores" is on.
    function decorateNativeChips(nativeChips) {
      for (const ch of nativeChips) {
        const line = ch.querySelector('[class*="descrCss"]:not([class*="mobile"]) > div:nth-child(2)');
        if (!line) continue;
        const old = line.querySelector('.bsx-native-star');
        const name = [...line.childNodes].filter(n => n !== old).map(n => n.textContent).join('').trim();
        const single = instructorsOf(name).length === 1;
        if (rmpOn() && single && !rmpCached(name, 'tamu')) {
          const k = rmpKey(name, 'tamu');
          if (Date.now() - (rmpFailed[k] || 0) >= 6e5) rmpLookup(name, 'tamu').then(schedule, () => { rmpFailed[k] = Date.now(); });
        }
        const d = rmpOn() && single ? rmpCached(name, 'tamu')?.data : null;
        const want = d?.count ? `★${d.rating.toFixed(1)}` : '';
        if (!want) { old?.remove(); continue; }
        if (old?.textContent === want) continue;
        const star = old || document.createElement('span');
        star.className = 'bsx-native-star';
        star.textContent = want;
        star.style.cssText = `color:${ratingColor(d.rating)};margin-left:4px`;
        if (!old) line.appendChild(star);
      }
    }

    // Small "★ 4.2" for calendar blocks, from cache only (render() requests missing ones in the background).
    function chipRating(c) {
      if (!rmpOn()) return '';
      const list = instructorsOf(c.instructor);
      const d = list.length === 1 ? rmpCached(list[0], c.kind === 'preview' ? 'tamu' : 'blinn')?.data : null;
      return d?.count ? ` <span style="color:${ratingColor(d.rating)}">★${d.rating.toFixed(1)}</span>` : '';
    }

    function chip(c, day, top, height, lane = 0, lanes = 1) {
      const el = document.createElement('div');
      el.className = CHIP + (lanes > 1 ? ' b-narrow' : '');
      el.style.setProperty('--c', rgb(c.color));
      el.style.top = `${top}px`; el.style.height = `${height}px`;
      el.style.left = `${(lane / lanes) * 100}%`; el.style.width = `${100 / lanes}%`;
      const name = `${c.subj} ${c.num}${c.section ? '-' + c.section : ''}`;
      const label = `View section details for ${name} (${c.tag}) on ${day}`;
      el.innerHTML = `<div class="b-bg"><div class="b-wrap"></div>
        <div class="b-detail">
          <button type="button" class="b-info" aria-label="${esc(label)}" title="${esc(label)}"><span aria-hidden="true" class="fa fa-info-circle"></span></button>
          <div class="b-full"><div aria-hidden="true">${esc(c.subj)}-${esc(c.num)} ${esc(c.room)}</div><div>${c.section ? `<b>${esc(c.section)}</b> · ` : ''}${esc(c.instructor)}${chipRating(c)}</div></div>
          <div class="b-compact" aria-hidden="true"><div>${esc(c.subj)}</div><div>${esc(c.num)}</div><div><b>${esc(c.section || c.room.split(' ')[0])}</b></div></div>
        </div></div>`;
      el.querySelector('.b-info').addEventListener('click', e => {
        e.preventDefault(); e.stopPropagation();
        openModal(c.kind === 'preview' ? previewModel(c) : blinnModel(c), e.currentTarget);
      });
      return el;
    }

    // ---- toolbar above the calendar ----------------------------------------
    function ensureBar(cal, term, blinn, previews, week, previewColors) {
      let bar = document.querySelector('.' + BAR);
      // Only require the bar to be in the calendar's container (not directly adjacent), so other
      // extensions inserting elements above the calendar can't cause an endless re-create loop.
      if (!bar || bar.parentElement !== cal.parentElement) {
        bar?.remove();
        bar = document.createElement('div');
        bar.className = BAR;
        bar.innerHTML = `<span class="bsx-status"></span><span class="bsx-pvs"></span>
          <form><input aria-label="Preview sections, e.g. CSCE 120 515, 519" placeholder="Preview: CSCE 120 515, 519"><button type="submit">Preview</button></form>
          <label class="bsx-rmp-toggle" title="Show Rate My Professors scores for Blinn and previewed instructors (fetched from ratemyprofessors.com, cached 7 days)">
            <input type="checkbox"> RMP scores</label>
          <span class="bsx-err" role="alert"></span>`;
        bar.querySelector('.bsx-rmp-toggle input').addEventListener('change', e => { setVal('rmpScores', e.target.checked); schedule(); });
        bar.querySelector('form').addEventListener('submit', async e => {
          e.preventDefault();
          const input = bar.querySelector('input'), err = bar.querySelector('.bsx-err');
          err.textContent = '';
          try { await addPreview(term, input.value); input.value = ''; } catch (x) { err.textContent = x.message; }
        });
        bar.addEventListener('click', e => {
          const rm = e.target.closest('[data-rm]');
          if (rm) savePreviews(term, previewsFor(term).filter(p => p.label !== rm.dataset.rm));
          if (e.target.closest('[data-clear]')) savePreviews(term, []);
        });
        cal.parentElement.insertBefore(bar, cal);
      }
      const rmpBox = bar.querySelector('.bsx-rmp-toggle input');
      if (rmpBox.checked !== rmpOn()) rmpBox.checked = rmpOn();
      const want = prettyTerm(seasonKey(term)) || term;
      const blinnLink = text => `<a href="https://ban9reg.blinn.edu/StudentRegistrationSsb/ssb/registration" target="_blank" rel="noopener">${text}</a>`;
      const courses = [...new Set(blinn.classes.map(c => `${c.subj} ${c.num}`))].map(name => {
        const meets = blinn.classes.some(c => `${c.subj} ${c.num}` === name && c.days.some(d => meetsOn(c, week, d)));
        return meets ? esc(name) : `<span style="opacity:.55" title="No meetings during ${esc(week?.label || 'this week')}">${esc(name)} (not this week)</span>`;
      });
      const ageDays = (Date.now() - blinn.syncedAt) / 864e5;
      const synced = `synced ${esc(new Date(blinn.syncedAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }))}`;
      let status;
      if (courses.length) {
        status = `<b>Blinn:</b> ${courses.join(' · ')} ` + (ageDays > STALE_DAYS
          ? `<span class="bsx-warn">· ⚠ ${synced} (${Math.floor(ageDays)} days ago) — ${blinnLink('re-sync')} if you've added or dropped classes</span>`
          : `<span style="opacity:.65">· ${synced}</span>`);
      } else if (blinn.matched) {
        status = `<b>Blinn:</b> no registered classes with meeting times for ${esc(want)} <span style="opacity:.65">· ${synced}</span>`;
      } else if (blinn.otherTerms.length) {
        status = `<span class="bsx-warn">⚠ <b>Term mismatch:</b> you've synced Blinn <b>${esc(blinn.otherTerms.join(', '))}</b>, but this is <b>${esc(want)}</b>.</span>
          Open ${blinnLink('Blinn → Register for Classes')} and pick ${esc(want)} to sync it.`;
      } else {
        status = `<b>Blinn:</b> nothing synced yet. Open ${blinnLink('Blinn → Register for Classes')} and pick ${esc(want)} to show your Blinn classes here.`;
      }
      const pvs = (previews.length ? 'Previewing ' : '') + previews.map(p =>
        `<span class="bsx-pv"><i class="bsx-dot" style="background:${rgb(previewColors[p.label])}"></i><b>${esc(p.label)}</b>` +
        `<button type="button" data-rm="${esc(p.label)}" aria-label="Stop previewing ${esc(p.label)}" title="Stop previewing">×</button></span>`).join(' ') +
        (previews.length > 1 ? ' <button type="button" class="bsx-clear" data-clear>Clear all</button>' : '');
      const st = bar.querySelector('.bsx-status'), pv = bar.querySelector('.bsx-pvs');
      if (st.dataset.v !== status) { st.innerHTML = status; st.dataset.v = status; }
      if (pv.dataset.v !== pvs) { pv.innerHTML = pvs; pv.dataset.v = pvs; }
    }

    // ---- render -------------------------------------------------------------
    function clearChips() {
      document.querySelectorAll('.' + CHIP).forEach(e => e.remove());
      document.querySelectorAll(`[${HIDDEN}]`).forEach(e => e.removeAttribute(HIDDEN));
    }

    let lastSig = '';
    function render() {
      const term = tamuTerm();
      const cal = document.querySelector('[class*="blockCalendarCss"]');
      if (!term || !cal) { clearChips(); document.querySelector('.' + BAR)?.remove(); lastSig = ''; return; }
      const [head, body] = cal.querySelectorAll('[class*="daysCss"]');
      if (!head || !body) return;
      const dayNames = [...head.children].map(h => (h.textContent.match(/^\s*(Sun|Mon|Tues|Wednes|Thurs|Fri|Satur)day/) || [''])[0].trim());
      const cols = [...body.children].filter(c => /columnCss/.test(c.className));
      const starts = [...cal.querySelectorAll('.hour > .start')];
      if (cols.length !== dayNames.length || starts.length < 2) return;

      ensureStyle();
      const blinn = blinnFor(term);
      const previews = previewsFor(term);
      const week = selectedWeek(cal);

      const nativeChips = [...cal.querySelectorAll('[class*="chipCss"]')].filter(ch => !ch.classList.contains(CHIP));
      decorateNativeChips(nativeChips);
      const nativeFor = course => nativeChips.filter(ch => ch.querySelector(`button[aria-label*="for ${CSS.escape(course)} on"]`));
      const toHide = previews.flatMap(p => nativeFor(p.course));
      // First preview of a course keeps that course's own color; extra sections of it get distinct colors.
      const previewColors = {}, perCourse = {};
      for (const p of previews) {
        const n = perCourse[p.course] = (perCourse[p.course] ?? -1) + 1;
        const native = nativeFor(p.course)[0]?.querySelector('.bg');
        previewColors[p.label] = n === 0 && native ? getComputedStyle(native).borderLeftColor
          : PREVIEW_PALETTE[(n + (native ? -1 : 0) + PREVIEW_PALETTE.length) % PREVIEW_PALETTE.length];
      }
      const previewItems = previews.flatMap(p => {
        const seats = p.open != null ? ` · ${p.open} open seats` : '';
        const section = p.label.split('-').pop();
        return p.meetings.map(m => ({ section, ...m, color: previewColors[p.label], tag: `Preview · not in your cart${seats}`,
          kind: 'preview', pkey: p.label }));
      });
      const items = [...blinn.classes, ...previewItems];
      ensureBar(cal, term, blinn, previews, week, previewColors);

      // RMP scores (opt-in): request any instructor not cached yet; blocks redraw once results arrive.
      const people = rmpOn() ? [...new Map(items.flatMap(c => instructorsOf(c.instructor)
        .map(n => [rmpKey(n, c.kind === 'preview' ? 'tamu' : 'blinn'), [n, c.kind === 'preview' ? 'tamu' : 'blinn']]))).values()] : [];
      for (const [n, kind] of people) {
        const k = rmpKey(n, kind);
        if (rmpCached(n, kind) || Date.now() - (rmpFailed[k] || 0) < 6e5) continue; // back off 10 min after a failure
        rmpLookup(n, kind).then(schedule, () => { rmpFailed[k] = Date.now(); });
      }
      const rmpSig = people.map(([n, kind]) => rmpCached(n, kind)?.data?.rating ?? '-').join(',');

      const ppm = (starts[1].getBoundingClientRect().top - starts[0].getBoundingClientRect().top) / 60;
      const origin = labelMins(starts[0].textContent);
      const offset = starts[0].getBoundingClientRect().top - cols[0].getBoundingClientRect().top;
      const sigOf = () => [JSON.stringify(items), rmpOn(), rmpSig, week?.label, dayNames.join(), ppm.toFixed(3), origin, offset.toFixed(1),
        cols.map(c => c.querySelectorAll('.' + CHIP).length).join(), toHide.filter(n => !n.hasAttribute(HIDDEN)).length].join('|');
      const expected = items.reduce((n, c) => n + c.days.filter(d => dayNames.includes(d) && meetsOn(c, week, d)).length, 0);
      if (sigOf() === lastSig && cal.querySelectorAll('.' + CHIP).length === expected) return;

      clearChips();
      toHide.forEach(n => n.setAttribute(HIDDEN, ''));
      dayNames.forEach((d, i) => {
        const todays = items.filter(c => c.days.includes(d) && meetsOn(c, week, d))
          .map(c => ({ c, s: mins(c.start), e: mins(c.end) })).sort((a, b) => a.s - b.s || a.e - b.e);
        // Overlapping blocks share the column side by side (calendar-style lanes per overlap cluster).
        let cluster = [], clusterEnd = -1;
        const flush = () => {
          const laneEnds = [];
          for (const x of cluster) {
            let lane = laneEnds.findIndex(end => end <= x.s);
            if (lane < 0) lane = laneEnds.push(0) - 1;
            laneEnds[lane] = x.e; x.lane = lane;
          }
          for (const x of cluster) cols[i].appendChild(chip(x.c, d, (x.s - origin) * ppm + offset, (x.e - x.s) * ppm, x.lane, laneEnds.length));
          cluster = []; clusterEnd = -1;
        };
        for (const x of todays) {
          if (cluster.length && x.s >= clusterEnd) flush();
          cluster.push(x); clusterEnd = Math.max(clusterEnd, x.e);
        }
        flush();
      });
      lastSig = sigOf();
    }

    let queued = false;
    // setTimeout rather than requestAnimationFrame: rAF is paused in background tabs,
    // which would delay updates when you sync from a Blinn tab.
    const schedule = () => { if (!queued) { queued = true; setTimeout(() => { queued = false; render(); decorateNativeModal(); }, 30); } };
    new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true });
    addEventListener('resize', schedule);
    addEventListener('popstate', schedule);
    onValChange(STORE, schedule);     // updates live when you sync in a Blinn tab
    onValChange(PREVIEWS, schedule);
    onValChange('rmpScores', schedule);
    render();
  }
})();
