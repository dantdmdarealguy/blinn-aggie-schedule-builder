// ==UserScript==
// @name         Blinn Classes on Aggie Schedule Builder
// @namespace    https://github.com/dantdmdarealguy/blinn-aggie-schedule-builder
// @version      2.2.1
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
      .bsx-modal .bsx-m-more{border-top:1px solid #e5e5e5;padding:10px 15px 0}
      .bsx-modal details{border-bottom:1px solid #eee;padding:6px 0}
      .bsx-modal summary{cursor:pointer;font-weight:bold;color:#333}
      .bsx-modal details > div{padding:6px 0 2px 16px;white-space:pre-line;color:#333}`;

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
      left.push(field('Instructor', esc([...new Set(meetings.map(m => m.instructor))].join('; '))));
      for (const [k, v] of kv(d.enrollment)) if (k) left.push(field(k, esc(v)));
      if (d.attributes) left.push(field('Section Attributes', esc(d.attributes.lines.join(', '))));
      const more = ['description', 'prerequisites', 'corequisites', 'restrictions', 'fees', 'bookstore', 'linked', 'crossList']
        .map(k => d[k]).filter(Boolean);
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
        field('Component', esc(i.component)), field('Instruction Mode', esc(i.mode)), field('Instructor', esc(m0.instructor)),
        field('Campus', esc(i.campus || m0.campus)), field('Credits', esc(i.credits)),
        field('Section Attributes', i.attributes?.length ? esc(i.attributes.join(', ')) : null)];
      return { title: `${m0.subj} ${m0.num}`, subtitle: m0.title, tag: 'Preview · not in your cart', color: c.color,
        left, meetings: p.meetings, linkRooms: true, more: [], note: '' };
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
          ${model.more.length ? `<div class="bsx-m-more">${model.more.map(s => `<details><summary>${esc(s.title)}</summary><div>${
            esc(s.lines.filter(l => !(s.links || []).some(k => k.text === l)).join('\n'))}${(s.links || []).map(l => `<br><a href="${esc(l.href)}" target="_blank" rel="noopener noreferrer">${esc(l.text)}</a>`).join('')}</div></details>`).join('')}</div>` : ''}
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
    }

    const rgb = color => (/^rgb/.test(color) ? color : `rgb(${color})`);

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
          <div class="b-full"><div aria-hidden="true">${esc(c.subj)}-${esc(c.num)} ${esc(c.room)}</div><div>${c.section ? `<b>${esc(c.section)}</b> · ` : ''}${esc(c.instructor)}</div></div>
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
          <span class="bsx-err" role="alert"></span>`;
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

      const ppm = (starts[1].getBoundingClientRect().top - starts[0].getBoundingClientRect().top) / 60;
      const origin = labelMins(starts[0].textContent);
      const offset = starts[0].getBoundingClientRect().top - cols[0].getBoundingClientRect().top;
      const sigOf = () => [JSON.stringify(items), week?.label, dayNames.join(), ppm.toFixed(3), origin, offset.toFixed(1),
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
    const schedule = () => { if (!queued) { queued = true; setTimeout(() => { queued = false; render(); }, 30); } };
    new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true });
    addEventListener('resize', schedule);
    addEventListener('popstate', schedule);
    onValChange(STORE, schedule);     // updates live when you sync in a Blinn tab
    onValChange(PREVIEWS, schedule);
    render();
  }
})();
