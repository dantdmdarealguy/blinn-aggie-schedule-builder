// ==UserScript==
// @name         Blinn Classes on Aggie Schedule Builder
// @namespace    https://github.com/dantdmdarealguy/blinn-aggie-schedule-builder
// @version      2.1.0
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
        const classes = [];
        for (const e of registered.values()) {
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
        all[term.code] = { code: term.code, description: term.description, syncedAt: Date.now(), classes };
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
      .${BAR} .bsx-err,.${BAR} .bsx-warn{color:#b00020}
      .bsx-pop{position:absolute;z-index:10000;background:#fff;border:1px solid #ccc;border-radius:4px;box-shadow:0 4px 14px rgba(0,0,0,.2);
        padding:10px 14px;font-size:14px;line-height:1.45;color:#222;min-width:240px;max-width:320px}
      .bsx-pop h4{margin:0 0 4px;font-size:15px}
      .bsx-pop .tag{display:inline-block;font-size:11px;font-weight:600;padding:1px 6px;border-radius:3px;background:#500000;color:#fff;margin-bottom:6px}`;

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
        tag: 'Blinn College · Registered' })));
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

    async function addPreview(term, text) {
      const m = text.trim().toUpperCase().match(/^([A-Z]{2,5})\s*-?\s*(\d{3,4}[A-Z]?)\s*[-\s]\s*(\d{3}[A-Z]?)$/);
      if (!m) throw new Error('Use the format: CSCE 120 519');
      const [, subj, num, sec] = m;
      const url = `/api/terms/${encodeURIComponent(term)}/subjects/${subj}/courses/${num}/regblocks`;
      const r = await fetch(url, { credentials: 'same-origin', headers: { Accept: 'application/json' } });
      if (!r.ok) throw new Error(`Couldn't find ${subj} ${num} this term.`);
      const data = await r.json();
      const s = (data.sections || []).find(x => String(x.sectionNumber) === sec);
      if (!s) throw new Error(`${subj} ${num} has no section ${sec} this term.`);
      const instructor = (s.instructor || []).map(i => i.name).join('; ') || 'TBA';
      const meetings = [];
      for (const mt of s.meetings || []) {
        const days = (String(mt.days || '').match(/Th|Su|Sa|[MTWRFSU]/g) || []).map(d => DAY_CODES[d]).filter(Boolean);
        if (!days.length || !mt.startTime || !mt.endTime) continue;
        const t = n => `${String(Math.floor(n / 100)).padStart(2, '0')}:${String(n % 100).padStart(2, '0')}`;
        meetings.push({ subj, num, title: data.sections[0]?.title || s.title || `${subj} ${num}`, crn: String(s.registrationNumber),
          type: mt.meetingTypeDescription || '', days: [...new Set(days)], start: t(mt.startTime), end: t(mt.endTime),
          room: mt.location || 'TBA', instructor, campus: s.campus || 'Texas A&M',
          dates: `${usDate(mt.startDate)} - ${usDate(mt.endDate)}` });
      }
      if (!meetings.length) throw new Error(`${subj} ${num}-${sec} has no scheduled meeting times to show.`);
      const list = previewsFor(term).filter(p => p.course !== `${subj} ${num}`);
      list.push({ course: `${subj} ${num}`, label: `${subj} ${num}-${sec}`, open: s.openSeats, meetings });
      savePreviews(term, list);
    }

    // ---- popover ------------------------------------------------------------
    function closePop() { document.querySelectorAll('.bsx-pop').forEach(p => p.remove()); }
    function openPop(btn, c) {
      closePop();
      const p = document.createElement('div');
      p.className = 'bsx-pop'; p.setAttribute('role', 'dialog');
      p.innerHTML = `<span class="tag">${esc(c.tag)}</span>
        <h4>${esc(c.subj)} ${esc(c.num)} – ${esc(c.title)}</h4>
        <div>CRN ${esc(c.crn)}${c.type ? ' · ' + esc(c.type) : ''}</div>
        <div>${esc(c.days.join(', '))} ${fmt(c.start)} – ${fmt(c.end)}</div>
        <div>${esc(c.room)}${c.campus ? ' · ' + esc(c.campus) : ''}</div>
        <div>Instructor: ${esc(c.instructor)}</div>
        ${c.dates ? `<div style="opacity:.7">${esc(c.dates)}</div>` : ''}`;
      document.body.appendChild(p);
      const r = btn.getBoundingClientRect();
      p.style.left = `${Math.max(8, r.left + scrollX)}px`;
      p.style.top = `${r.bottom + scrollY + 4}px`;
    }
    document.addEventListener('click', e => { if (!e.target.closest('.bsx-pop, .b-info')) closePop(); }, true);
    document.addEventListener('keydown', e => { if (e.key === 'Escape') closePop(); });

    function chip(c, day, top, height) {
      const el = document.createElement('div');
      el.className = CHIP;
      el.style.setProperty('--c', /^rgb/.test(c.color) ? c.color : `rgb(${c.color})`);
      el.style.top = `${top}px`; el.style.height = `${height}px`;
      const label = `View section details for ${c.subj} ${c.num} (${c.tag}) on ${day}`;
      el.innerHTML = `<div class="b-bg"><div class="b-wrap"></div>
        <div class="b-detail">
          <button type="button" class="b-info" aria-label="${esc(label)}" title="${esc(label)}"><span aria-hidden="true" class="fa fa-info-circle"></span></button>
          <div><div aria-hidden="true">${esc(c.subj)}-${esc(c.num)} ${esc(c.room)}</div><div>${esc(c.instructor)}</div></div>
        </div></div>`;
      el.querySelector('.b-info').addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); openPop(e.currentTarget, c); });
      return el;
    }

    // ---- toolbar above the calendar ----------------------------------------
    function ensureBar(cal, term, blinn, previews, week) {
      let bar = document.querySelector('.' + BAR);
      if (!bar || bar.nextElementSibling !== cal) {
        bar?.remove();
        bar = document.createElement('div');
        bar.className = BAR;
        bar.innerHTML = `<span class="bsx-status"></span><span class="bsx-pvs"></span>
          <form><input aria-label="Preview a different section" placeholder="Preview: CSCE 120 519"><button type="submit">Preview</button></form>
          <span class="bsx-err" role="alert"></span>`;
        bar.querySelector('form').addEventListener('submit', async e => {
          e.preventDefault();
          const input = bar.querySelector('input'), err = bar.querySelector('.bsx-err');
          err.textContent = '';
          try { await addPreview(term, input.value); input.value = ''; } catch (x) { err.textContent = x.message; }
        });
        bar.addEventListener('click', e => {
          const rm = e.target.closest('[data-rm]');
          if (rm) savePreviews(term, previewsFor(term).filter(p => p.course !== rm.dataset.rm));
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
      const pvs = previews.map(p => `<span class="bsx-pv">Previewing <b>${esc(p.label)}</b><button type="button" data-rm="${esc(p.course)}" aria-label="Stop previewing ${esc(p.label)}" title="Back to your cart's section">×</button></span>`).join(' ');
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
      ensureBar(cal, term, blinn, previews, week);

      const nativeChips = [...cal.querySelectorAll('[class*="chipCss"]')].filter(ch => !ch.classList.contains(CHIP));
      const nativeFor = course => nativeChips.filter(ch => ch.querySelector(`button[aria-label*="for ${CSS.escape(course)} on"]`));
      const toHide = previews.flatMap(p => nativeFor(p.course));
      const previewItems = previews.flatMap(p => {
        const native = nativeFor(p.course)[0]?.querySelector('.bg');
        const color = native ? getComputedStyle(native).borderLeftColor : '73, 134, 231';
        const seats = p.open != null ? ` · ${p.open} open seats` : '';
        return p.meetings.map(m => ({ ...m, color, tag: `Preview · not in your cart${seats}` }));
      });
      const items = [...blinn.classes, ...previewItems];

      const ppm = (starts[1].getBoundingClientRect().top - starts[0].getBoundingClientRect().top) / 60;
      const origin = labelMins(starts[0].textContent);
      const offset = starts[0].getBoundingClientRect().top - cols[0].getBoundingClientRect().top;
      const sigOf = () => [JSON.stringify(items), week?.label, dayNames.join(), ppm.toFixed(3), origin, offset.toFixed(1),
        cols.map(c => c.querySelectorAll('.' + CHIP).length).join(), toHide.filter(n => !n.hasAttribute(HIDDEN)).length].join('|');
      const expected = items.reduce((n, c) => n + c.days.filter(d => dayNames.includes(d) && meetsOn(c, week, d)).length, 0);
      if (sigOf() === lastSig && cal.querySelectorAll('.' + CHIP).length === expected) return;

      clearChips();
      toHide.forEach(n => n.setAttribute(HIDDEN, ''));
      for (const c of items) for (const d of c.days) {
        const i = dayNames.indexOf(d);
        if (i < 0 || !meetsOn(c, week, d)) continue;
        cols[i].appendChild(chip(c, d, (mins(c.start) - origin) * ppm + offset, (mins(c.end) - mins(c.start)) * ppm));
      }
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
