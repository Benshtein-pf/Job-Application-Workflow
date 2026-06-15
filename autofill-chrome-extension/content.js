(function () {
  'use strict';

  const TAG = '[job-autofill]';
  const LOG = (...a) => console.log(TAG, ...a);
  const WARN = (...a) => console.warn(TAG, ...a);

  // ─── Data loaders ────────────────────────────────────────────────────────
  let CANDIDATE = null;
  let OVERRIDES = null;

  async function loadData() {
    if (CANDIDATE && OVERRIDES) return;
    const [c, o] = await Promise.all([
      fetch(chrome.runtime.getURL('candidate-data.json')).then(r => r.json()),
      fetch(chrome.runtime.getURL('selector-overrides.json'))
        .then(r => r.json())
        .catch(() => ({})),
    ]);
    CANDIDATE = c;
    OVERRIDES = o || {};
  }

  // ─── Field setters (React-safe) ──────────────────────────────────────────
  function setInputValue(el, value) {
    if (!el || value == null) return false;
    const proto = el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(el, String(value));
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }

  function setSelectValue(el, value) {
    if (!el) return false;
    const v = String(value).trim().toLowerCase();
    const opts = Array.from(el.options || []);
    const match =
      opts.find(o => (o.value || '').trim().toLowerCase() === v) ||
      opts.find(o => (o.text || '').trim().toLowerCase() === v) ||
      opts.find(o => (o.text || '').toLowerCase().includes(v));
    if (!match) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
    setter.call(el, match.value);
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }

  function clickEl(el) {
    if (!el) return;
    try { el.scrollIntoView({ block: 'center' }); } catch {}
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    el.click();
  }

  // ─── Rippling main-world bridge ──────────────────────────────────────────
  // __reactProps$xxx on DOM nodes is only visible in the page's MAIN world.
  // bridge-main.js (declared in manifest with "world":"MAIN") listens for
  // postMessages and performs React prop calls, posting results back.
  // window.postMessage crosses the isolated↔main world boundary.
  function ripplingBridge(step) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        window.removeEventListener('message', handler);
        reject(new Error('ripplingBridge timeout: ' + step));
      }, 3000);
      function handler(e) {
        if (!e.data || e.data.__job_autofill_result !== 'rippling' || e.data.step !== step) return;
        window.removeEventListener('message', handler);
        clearTimeout(timer);
        resolve(e.data);
      }
      window.addEventListener('message', handler);
      window.postMessage({ __job_autofill: 'rippling', step }, '*');
    });
  }

  // ─── Wait helpers ────────────────────────────────────────────────────────
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  async function waitFor(fn, { timeout = 5000, interval = 100 } = {}) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      try { const v = fn(); if (v) return v; } catch {}
      await sleep(interval);
    }
    return null;
  }

  // ─── Visibility / DOM helpers ────────────────────────────────────────────
  function isVisible(el) {
    if (!el || el.disabled) return false;
    const t = (el.type || '').toLowerCase();
    if (t === 'hidden') return false;
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    if (t === 'radio' || t === 'checkbox') return true;
    const r = el.getBoundingClientRect();
    return r.width > 0 || r.height > 0;
  }

  // root can be document or a ShadowRoot
  function getLabelText(el, root = document) {
    if (!el) return '';
    const parts = [];
    if (el.id) {
      try {
        const lbl = root.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        if (lbl) parts.push(lbl.innerText || '');
      } catch {}
    }
    const aria = el.getAttribute('aria-label');
    if (aria) parts.push(aria);
    const ariaBy = el.getAttribute('aria-labelledby');
    if (ariaBy) {
      ariaBy.split(/\s+/).forEach(id => {
        try {
          const e = (root.getElementById ? root.getElementById(id) : root.querySelector(`#${CSS.escape(id)}`));
          if (e) parts.push(e.innerText || '');
        } catch {}
      });
    }
    let p = el.parentElement;
    while (p && parts.length === 0) {
      if (p.tagName === 'LABEL') { parts.push(p.innerText || ''); break; }
      p = p.parentElement;
    }
    if (el.placeholder) parts.push(el.placeholder);
    if (el.name) parts.push(el.name.replace(/[_\-\.\[\]]/g, ' '));
    if (el.id) parts.push(el.id.replace(/[_\-]/g, ' '));
    return parts.join(' ').toLowerCase();
  }

  function fillableInputs(root = document) {
    return Array.from(root.querySelectorAll('input, textarea, select')).filter(el => {
      const t = (el.type || '').toLowerCase();
      if (['hidden', 'submit', 'button', 'reset', 'image', 'file'].includes(t)) return false;
      if (el.readOnly) return false;
      return isVisible(el);
    });
  }

  function findInputByPattern(pattern, root = document) {
    return fillableInputs(root).find(el => pattern.test(getLabelText(el, root)));
  }

  function findFileInputByPattern(pattern, root = document) {
    const files = Array.from(root.querySelectorAll('input[type=file]'));
    return files.find(el => pattern.test(getLabelText(el, root))) || files[0] || null;
  }

  function getUniqueSelector(el) {
    if (!el) return null;
    if (el.id) return `#${CSS.escape(el.id)}`;
    for (const attr of ['name', 'data-automation-id', 'data-testid', 'data-qa']) {
      const val = el.getAttribute(attr);
      if (val) return `input[type="file"][${attr}="${val}"]`;
    }
    const tempId = `job-autofill-resume-${Date.now()}`;
    el.id = tempId;
    return `#${CSS.escape(tempId)}`;
  }

  // ─── Patterns ────────────────────────────────────────────────────────────
  const P = {
    first_name: /first.?name|given.?name|forename|prénom|שם.?פרטי/i,
    last_name: /last.?name|family.?name|surname|שם.?משפחה/i,
    full_name: /(^|\b)(full.?name|name)(\b|$)/i,
    email: /e-?mail|דוא["']?ל|דואר.?אל/i,
    phone: /phone|mobile|tel(?:ephone)?|cell|טלפון/i,
    city: /\bcity\b|\btown\b|עיר/i,
    country: /\bcountry\b|מדינה/i,
    location: /location|address|where.*based/i,
    linkedin: /linkedin/i,
    sponsorship: /sponsor|visa.*support|require.*visa/i,
    authorized: /authori[sz]ed|legally.?(allowed|able).?to.?work|right.?to.?work|eligible.?to.?work|work.?authori[sz]ation/i,
    relocate: /relocat/i,
    resume: /resume|curriculum|\bcv\b/i,
  };

  // ─── Yes/No detection & set ──────────────────────────────────────────────
  function findYesNoGroup(pattern, root = document) {
    const radios = Array.from(root.querySelectorAll('input[type=radio]')).filter(isVisible);
    const groups = {};
    radios.forEach(r => {
      const key = r.name || (r.closest('fieldset')?.id ?? '');
      if (!key) return;
      (groups[key] = groups[key] || []).push(r);
    });
    for (const list of Object.values(groups)) {
      const container = list[0].closest('fieldset, [role=radiogroup], .field, .form-group, label')
        || list[0].parentElement?.parentElement;
      const text = (container?.innerText || '').toLowerCase();
      if (pattern.test(text)) return { kind: 'radio', els: list };
    }
    for (const s of Array.from(root.querySelectorAll('select')).filter(isVisible)) {
      if (!pattern.test(getLabelText(s, root))) continue;
      const opts = Array.from(s.options).map(o => (o.text || '').toLowerCase());
      if (opts.some(o => /^\s*yes\s*$/.test(o)) && opts.some(o => /^\s*no\s*$/.test(o))) {
        return { kind: 'select', els: [s] };
      }
    }
    return null;
  }

  function setYesNo(group, yes) {
    if (!group) return false;
    if (group.kind === 'select') return setSelectValue(group.els[0], yes ? 'Yes' : 'No');
    const labelOf = r => {
      const lbl = r.id ? document.querySelector(`label[for="${CSS.escape(r.id)}"]`) : null;
      return (lbl?.innerText || r.parentElement?.innerText || r.value || '').toLowerCase();
    };
    const target = group.els.find(r => yes ? /\byes\b|^true$/.test(labelOf(r)) : /\bno\b|^false$/.test(labelOf(r)));
    if (target) { clickEl(target); return true; }
    return false;
  }

  // ─── Generic heuristic filler ────────────────────────────────────────────
  function fillHeuristic(skipped, root = document) {
    if (!CANDIDATE) return;
    const p = CANDIDATE.personal;

    const setIfEmpty = (key, pattern, value) => {
      const el = findInputByPattern(pattern, root);
      if (!el) { skipped.push(key); return false; }
      if (el.value && el.value.trim()) return 'already-filled';
      if (el.tagName === 'SELECT') return setSelectValue(el, value);
      return setInputValue(el, value);
    };

    const hasFirst = !!findInputByPattern(P.first_name, root);
    const hasLast = !!findInputByPattern(P.last_name, root);
    if (hasFirst) setIfEmpty('first_name', P.first_name, p.first_name);
    if (hasLast) setIfEmpty('last_name', P.last_name, p.last_name);
    // Always attempt full_name — when first/last exist, require "full" prefix to avoid
    // matching "First Name" or "Last Name" labels that also contain the word "name"
    const fullNamePattern = (hasFirst || hasLast) ? /full.?name/i : P.full_name;
    setIfEmpty('full_name', fullNamePattern, p.full_name);

    setIfEmpty('email', P.email, p.email);

    // Phone: prefer type=tel (avoids matching dial-code text inputs that contain "phone" in their ID)
    const phoneEl = fillableInputs(root).find(el => el.type === 'tel') || findInputByPattern(P.phone, root);
    if (!phoneEl) {
      skipped.push('phone');
    } else {
      // Search up 2 levels to capture dial-code inputs that sit alongside the tel input
      const wrap = phoneEl.parentElement?.parentElement || phoneEl.parentElement;
      const dialSel = wrap && Array.from(wrap.querySelectorAll('select')).find(s =>
        Array.from(s.options).some(o => /^\+\d/.test((o.value || o.text).trim()))
      );
      const dialCustom = !dialSel && wrap &&
        wrap.querySelector('[class*="flag"],[class*="country"],[class*="dial"],[class*="phone-code"]');
      // Also detect text inputs pre-filled with a dial code (e.g. Oracle "+972")
      const dialText = !dialSel && !dialCustom && wrap &&
        Array.from(wrap.querySelectorAll('input[type=text],input[type=search]'))
          .find(i => i !== phoneEl && /^\+\d/.test(i.value.trim()));
      const hasDialPicker = !!(dialSel || dialCustom || dialText);

      if (hasDialPicker) {
        const dialIndicator = dialSel || dialCustom || dialText;
        const dialValue = dialSel
          ? (dialSel.options[dialSel.selectedIndex]?.text || '') + dialSel.value
          : (dialIndicator.textContent || '') + (dialIndicator.value || '') +
            (dialIndicator.getAttribute('title') || '') + (dialIndicator.getAttribute('data-country') || '');
        const isIsrael = /\+972|^IL$|Israel|🇮🇱/i.test(dialValue);
        if (isIsrael) {
          const local = p.phone_local || p.phone.replace(/^\+972[- ]?0?/, '').replace(/[^0-9]/g, '');
          // Always overwrite — field may be pre-filled with full international number by session restore
          setInputValue(phoneEl, local);
        } else {
          WARN('phone dial code is not Israel — skipping phone fill', dialValue);
          skipped.push('phone_dial_code_not_israel');
        }
      } else if (!phoneEl.value || !phoneEl.value.trim()) {
        setInputValue(phoneEl, p.phone);
      }
    }

    // LinkedIn: try label pattern first, fall back to first visible url input
    if (!setIfEmpty('linkedin', P.linkedin, p.linkedin)) {
      const urlEl = fillableInputs(root).find(el => el.type === 'url');
      if (urlEl && (!urlEl.value || !urlEl.value.trim())) setInputValue(urlEl, p.linkedin);
    }

    const hasCity = !!findInputByPattern(P.city, root);
    const hasCountry = !!findInputByPattern(P.country, root);
    if (hasCity) setIfEmpty('city', P.city, p.location.city);
    if (hasCountry) setIfEmpty('country', P.country, p.location.country);
    if (!hasCity && !hasCountry) setIfEmpty('location', P.location, `${p.location.city}, ${p.location.country}`);

    const sd = CANDIDATE.screening_defaults;
    const auth = findYesNoGroup(P.authorized, root);
    if (auth) setYesNo(auth, sd.authorized_to_work); else skipped.push('authorized_to_work');
    const sponsor = findYesNoGroup(P.sponsorship, root);
    if (sponsor) setYesNo(sponsor, sd.requires_sponsorship); else skipped.push('requires_sponsorship');
  }

  // ─── Split dial-code phone fixer (Rippling) ──────────────────────────────
  // Rippling's country code selector is a React-controlled combobox. Standard
  // DOM events don't open it — must call its __reactProps onClick directly.
  async function fixSplitPhone() {
    if (!CANDIDATE) return;
    const p = CANDIDATE.personal;
    const local = p.phone_local || p.phone.replace(/^\+972[- ]?0?/, '').replace(/[^0-9]/g, '');

    // ── Rippling-specific path ───────────────────────────────────────────────
    // React props (__reactProps$xxx) are only visible in the page's main world,
    // not in the content script's isolated world. Use runInPage() for all React
    // prop interactions.
    const phoneCodeDiv = document.querySelector('[data-testid="phone_number-code"]');
    if (phoneCodeDiv) {
      // Step 1: open dropdown via bridge-main.js (MAIN world)
      const step1 = await ripplingBridge('open_dropdown').catch(e => ({ ok: false, error: e.message }));
      LOG('fixSplitPhone open_dropdown:', step1);
      await sleep(400);

      // Step 2: set search input to 'IL' (native setter works in isolated world)
      const searchInput = phoneCodeDiv.querySelector('[data-testid="input-select-search-input"]');
      if (searchInput) {
        const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        nativeSetter.call(searchInput, 'IL');
        searchInput.dispatchEvent(new Event('input', { bubbles: true }));
        searchInput.dispatchEvent(new Event('change', { bubbles: true }));
        await sleep(400);
      }

      // Step 3: click Israel option via bridge-main.js (MAIN world)
      const step3 = await ripplingBridge('click_israel').catch(e => ({ ok: false, error: e.message }));
      LOG('fixSplitPhone click_israel:', step3);
      await sleep(300);

      // Set local number in the phone input
      const phoneEl = findInputByPattern(P.phone);
      if (phoneEl) setInputValue(phoneEl, local);
      return;
    }

    // ── Generic fallback for other split-phone patterns ──────────────────────
    const phoneEl = findInputByPattern(P.phone);
    if (!phoneEl) return;
    const dialEl = Array.from(document.querySelectorAll('input')).find(el =>
      el !== phoneEl && (el.type === 'text' || el.type === 'search') &&
      (/^\+\d/.test(el.value) || /^\+\d/.test(el.placeholder))
    );
    if (!dialEl) return;

    setInputValue(dialEl, 'Israel');
    dialEl.dispatchEvent(new Event('focus', { bubbles: true }));
    await sleep(600);
    const israelOpt = await waitFor(() =>
      Array.from(document.querySelectorAll('li, [role=option], [class*="option"], [class*="item"]'))
        .find(el => /israel/i.test(el.textContent)),
      { timeout: 2500 }
    );
    if (israelOpt) { clickEl(israelOpt); await sleep(300); }
    setInputValue(phoneEl, local);
  }

  // ─── Selector overrides ──────────────────────────────────────────────────
  function applyOverrides() {
    if (!CANDIDATE || !OVERRIDES) return null;
    const host = location.hostname.replace(/^www\./, '');
    const map = OVERRIDES[location.hostname] || OVERRIDES[host];
    if (!map) return null;
    const p = CANDIDATE.personal;
    const valueFor = {
      first_name: p.first_name, last_name: p.last_name, full_name: p.full_name,
      email: p.email, phone: p.phone, linkedin: p.linkedin,
      city: p.location.city, country: p.location.country,
      location: `${p.location.city}, ${p.location.country}`,
    };
    Object.entries(map).forEach(([field, sel]) => {
      if (field === 'resume_input') return;
      const el = document.querySelector(sel);
      const v = valueFor[field];
      if (el && v != null && (!el.value || !el.value.trim())) {
        if (el.tagName === 'SELECT') setSelectValue(el, v);
        else setInputValue(el, v);
      }
    });
    return map;
  }

  // ─── Platform: Greenhouse ────────────────────────────────────────────────
  async function fillGreenhouse(skipped) {
    const p = CANDIDATE.personal;
    const direct = {
      first_name: '#first_name, input[autocomplete="given-name"], input[name="first_name"]',
      last_name: '#last_name, input[autocomplete="family-name"], input[name="last_name"]',
      email: '#email, input[autocomplete="email"], input[type=email]',
      phone: '#phone, input[autocomplete="tel"], input[type=tel]',
    };
    Object.entries(direct).forEach(([k, sel]) => {
      const el = document.querySelector(sel);
      if (el && (!el.value || !el.value.trim())) setInputValue(el, p[k]);
      else if (!el) skipped.push(k);
    });
    const li = findInputByPattern(P.linkedin);
    if (li && (!li.value || !li.value.trim())) setInputValue(li, p.linkedin);

    const locInput = document.querySelector(
      '#candidate-location, input[name="job_application[location]"], #job_application_location, input[id*="location" i]'
    );
    if (locInput && (!locInput.value || !locInput.value.trim())) {
      try {
        setInputValue(locInput, p.location.city);
        locInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
        const opt = await waitFor(
          () => document.querySelector('.select__option, .select__menu [role="option"], [role="option"], li.ui-menu-item'),
          { timeout: 2500 }
        );
        if (opt) clickEl(opt);
      } catch { skipped.push('location'); }
    }

    const sd = CANDIDATE.screening_defaults;
    const auth = findYesNoGroup(P.authorized);
    if (auth) setYesNo(auth, sd.authorized_to_work);
    const sponsor = findYesNoGroup(P.sponsorship);
    if (sponsor) setYesNo(sponsor, sd.requires_sponsorship);

    const resume =
      document.querySelector('input[type=file]#resume, input[type=file][name*="resume" i], input[type=file][id*="resume" i]') ||
      findFileInputByPattern(P.resume);
    return { resume_input_found: !!resume };
  }

  // ─── Platform: Lever ─────────────────────────────────────────────────────
  function fillLever(skipped) {
    const p = CANDIDATE.personal;
    [
      ['full_name',  'input[name="name"]',                                  p.full_name],
      ['email',      'input[name="email"]',                                 p.email],
      ['phone',      'input[name="phone"]',                                 p.phone],
      ['linkedin',   'input[name="urls[LinkedIn]"], input[name*="linkedin" i]', p.linkedin],
      ['location',   'input[name="location"]',                              `${p.location.city}, ${p.location.country}`],
    ].forEach(([k, sel, v]) => {
      const el = document.querySelector(sel);
      if (el && (!el.value || !el.value.trim())) setInputValue(el, v);
      else if (!el) skipped.push(k);
    });
    const sd = CANDIDATE.screening_defaults;
    const auth = findYesNoGroup(P.authorized); if (auth) setYesNo(auth, sd.authorized_to_work);
    const sponsor = findYesNoGroup(P.sponsorship); if (sponsor) setYesNo(sponsor, sd.requires_sponsorship);
    const resume = document.querySelector('input[name="resume"], input[type=file]') || findFileInputByPattern(P.resume);
    return { resume_input_found: !!resume };
  }

  // ─── Platform: LinkedIn Easy Apply (shadow DOM) ───────────────────────────
  async function fillLinkedIn(skipped) {
    // LinkedIn renders Easy Apply inside #interop-outlet shadow root
    const shadowRoot = await waitFor(() => {
      const sr = document.getElementById('interop-outlet')?.shadowRoot;
      if (!sr) return null;
      const inputs = sr.querySelectorAll('input:not([type=hidden]), select, textarea');
      return inputs.length > 0 ? sr : null;
    }, { timeout: 10000 });

    if (!shadowRoot) {
      skipped.push('easy_apply_modal_not_open');
      return { resume_input_found: false };
    }

    let pages = 0;
    let resumeSelector = null;
    while (pages < 8) {
      pages++;
      await sleep(500);
      fillHeuristic(skipped, shadowRoot);
      const fileInput = shadowRoot.querySelector('input[type=file]');
      if (fileInput && !resumeSelector) {
        resumeSelector = getUniqueSelector(fileInput);
        break; // stop here — Cowork uploads via CDP, then advances
      }

      const buttons = Array.from(shadowRoot.querySelectorAll('button'));
      const submit = buttons.find(b => /^submit application$/i.test((b.innerText || '').trim()));
      if (submit) break;
      const next = buttons.find(b => /^(next|continue|review)$/i.test((b.innerText || '').trim()));
      if (!next) break;
      clickEl(next);
      await sleep(1200);
    }

    return { resume_input_found: !!resumeSelector, resume_selector: resumeSelector, shadow_host: '#interop-outlet' };
  }

  // ─── Platform: Workday ───────────────────────────────────────────────────
  async function fillWorkday(skipped) {
    const p = CANDIDATE.personal;
    const direct = {
      first_name: 'input[data-automation-id*="firstName" i], input[data-automation-id*="legalName_firstName" i]',
      last_name: 'input[data-automation-id*="lastName" i], input[data-automation-id*="legalName_lastName" i]',
      email: 'input[data-automation-id*="email" i], input[type=email]',
      phone: 'input[data-automation-id*="phone-number" i], input[data-automation-id*="phone" i], input[type=tel]',
    };
    Object.entries(direct).forEach(([k, sel]) => {
      const el = document.querySelector(sel);
      if (el && (!el.value || !el.value.trim())) setInputValue(el, p[k]);
      else if (!el) skipped.push(k);
    });
    skipped.push('workday_dropdowns_unhandled');
    const resume = document.querySelector('input[type=file]') || findFileInputByPattern(P.resume);
    return { resume_input_found: !!resume };
  }

  // ─── Platform: Comeet ─────────────────────────────────────────────────────
  // The form is inside a cross-origin iframe (comeet.co). We postMessage to
  // the iframe content script which fills and posts results back.
  async function fillComeet(skipped) {
    const findComeetIframe = () =>
      document.querySelector('iframe[src*="comeet.co"][src*="/apply"]') ||
      document.querySelector('iframe[name^="comeet-applyform"]');
    let iframe = findComeetIframe();
    if (!iframe) {
      const applyBtn = Array.from(document.querySelectorAll('a, button')).find(el =>
        /apply for this job/i.test((el.innerText || '').trim())
      );
      if (applyBtn) {
        clickEl(applyBtn);
        iframe = await waitFor(findComeetIframe, { timeout: 8000 });
      }
    }
    if (!iframe?.contentWindow) {
      skipped.push('comeet_apply_iframe_not_found');
      return { resume_input_found: false };
    }
    // Wait for the iframe's content script to finish loading
    await sleep(1500);
    return new Promise(resolve => {
      let resumeSelector = null;
      let resumeFrameUrl = null;
      const timeout = setTimeout(() => resolve({ resume_input_found: false }), 12000);
      window.addEventListener('message', function handler(e) {
        if (e.data?.type === 'job-autofill-resume') {
          resumeSelector = e.data.selector || null;
          resumeFrameUrl = e.data.frame_url || null;
          return;
        }
        if (e.data?.type !== 'job-autofill-result') return;
        clearTimeout(timeout);
        window.removeEventListener('message', handler);
        (e.data.skipped || []).forEach(s => skipped.push(s));
        resolve({ resume_input_found: !!e.data.resume_input_found, resume_selector: resumeSelector, resume_frame_url: resumeFrameUrl });
      });
      iframe.contentWindow.postMessage({
        type: 'job-autofill-trigger',
        jobId: document.body.getAttribute('data-job-id') || '',
      }, 'https://www.comeet.co');
    });
  }

  // ─── Platform: Oracle Cloud (two-step) ───────────────────────────────────
  async function fillOracle(skipped) {
    const p = CANDIDATE.personal;
    const hasFullForm = () => !!document.querySelector(
      'input[name*="firstName" i], input[name*="first_name" i], input[id*="first" i]'
    );
    if (!hasFullForm()) {
      const emailOnly = document.querySelector('input[type=email], input[name*=email i], input[id*=email i]');
      if (emailOnly) {
        if (!emailOnly.value) setInputValue(emailOnly, p.email);
        const next = Array.from(document.querySelectorAll('button, a[role=button]')).find(b =>
          /^(sign.?in|continue|next|apply|submit)$/i.test((b.innerText || '').trim())
        );
        if (next) clickEl(next);
        await waitFor(hasFullForm, { timeout: 10000 });
      }
    }
    fillHeuristic(skipped);
    const resume = document.querySelector('input[type=file]') || findFileInputByPattern(P.resume);
    return { resume_input_found: !!resume };
  }

  // ─── Platform: Greenhouse embedded in company page ──────────────────────
  async function fillGreenhouseEmbed(skipped) {
    const iframe =
      document.querySelector('iframe#grnhse_iframe') ||
      document.querySelector('iframe[src*="boards.greenhouse.io/embed"]');
    if (!iframe?.contentWindow) {
      skipped.push('greenhouse_embed_iframe_not_found');
      return { resume_input_found: false };
    }
    await sleep(1500);
    return new Promise(resolve => {
      let resumeSelector = null;
      let resumeFrameUrl = null;
      const timeout = setTimeout(() => resolve({ resume_input_found: false }), 12000);
      window.addEventListener('message', function handler(e) {
        if (e.data?.type === 'job-autofill-resume') {
          resumeSelector = e.data.selector || null;
          resumeFrameUrl = e.data.frame_url || null;
          return;
        }
        if (e.data?.type !== 'job-autofill-result') return;
        clearTimeout(timeout);
        window.removeEventListener('message', handler);
        (e.data.skipped || []).forEach(s => skipped.push(s));
        resolve({ resume_input_found: !!e.data.resume_input_found, resume_selector: resumeSelector, resume_frame_url: resumeFrameUrl });
      });
      iframe.contentWindow.postMessage({
        type: 'job-autofill-trigger',
        jobId: document.body.getAttribute('data-job-id') || '',
      }, '*');
    });
  }

  // ─── Platform detection ──────────────────────────────────────────────────
  function detectPlatform() {
    const h = location.hostname;
    if (h.includes('greenhouse.io')) return 'greenhouse';
    if (h === 'jobs.lever.co') return 'lever';
    if (h.endsWith('linkedin.com')) return 'linkedin';
    if (h.endsWith('.myworkdayjobs.com')) return 'workday';
    if (h === 'ats.rippling.com') return 'rippling';
    if (h.endsWith('comeet.com')) return 'comeet';
    if (h === 'employer.dueto.io') return 'dueto';
    if (h.endsWith('.fa.ocs.oraclecloud.com') || h.includes('oraclecloud')) return 'oracle';
    // Detect embedded ATS iframes on company-hosted career pages
    if (document.querySelector('iframe[name^="comeet-applyform"], iframe[src*="comeet.co"]')) return 'comeet';
    if (document.querySelector('iframe#grnhse_iframe, iframe[src*="boards.greenhouse.io/embed"]')) return 'greenhouse-embed';
    return 'generic';
  }

  // ─── Main ────────────────────────────────────────────────────────────────
  let running = false;

  async function runFill(jobId) {
    if (running) return;
    running = true;
    document.body.removeAttribute('data-fill-done');
    document.body.removeAttribute('data-fill-skipped');
    document.body.removeAttribute('data-resume-input');

    try {
      await loadData();
      const platform = detectPlatform();
      LOG('fill start', { platform, host: location.hostname, jobId });
      const skipped = [];

      const overrideMap = applyOverrides();

      let extras = {};
      if (platform === 'greenhouse') extras = await fillGreenhouse(skipped);
      else if (platform === 'greenhouse-embed') extras = await fillGreenhouseEmbed(skipped);
      else if (platform === 'lever') extras = fillLever(skipped);
      else if (platform === 'linkedin') extras = await fillLinkedIn(skipped);
      else if (platform === 'workday') extras = await fillWorkday(skipped);
      else if (platform === 'comeet') extras = await fillComeet(skipped);
      else if (platform === 'oracle') extras = await fillOracle(skipped);
      else extras = {}; // rippling, dueto, generic — heuristic below

      // Heuristic fallback — skip platforms where the form is in a cross-origin iframe
      const crossOriginIframe = ['linkedin', 'comeet', 'greenhouse-embed'];
      if (!crossOriginIframe.includes(platform)) fillHeuristic(skipped);

      // Fix split dial-code phone fields (Rippling and similar)
      if (['rippling', 'generic'].includes(platform)) {
        await fixSplitPhone();
      }

      // Resume input detection — build data-resume-input JSON
      const overrideResumeSel = overrideMap?.resume_input;
      let resumeInfo = null;

      if (overrideResumeSel) {
        const el = document.querySelector(overrideResumeSel);
        if (el) resumeInfo = { selector: getUniqueSelector(el), frame_url: null, shadow_host: null };
      } else if (extras.resume_selector && extras.shadow_host) {
        // Shadow DOM (LinkedIn): selector captured inside shadow root
        resumeInfo = { selector: extras.resume_selector, frame_url: null, shadow_host: extras.shadow_host };
      } else if (extras.resume_selector) {
        // Cross-origin iframe (Comeet, Greenhouse-embed): selector valid within iframe context
        resumeInfo = { selector: extras.resume_selector, frame_url: extras.resume_frame_url || null, shadow_host: null };
      } else {
        const resumeEl =
          (extras.resume_input_found ? (document.querySelector('input[type=file]') || findFileInputByPattern(P.resume)) : null) ||
          findFileInputByPattern(P.resume);
        if (resumeEl) resumeInfo = { selector: getUniqueSelector(resumeEl), frame_url: null, shadow_host: null };
      }

      if (resumeInfo && jobId) {
        document.body.setAttribute('data-resume-input', JSON.stringify({
          pdf_path: `~/Documents/job-application-automation/CVs/tailored/${jobId}.pdf`,
          ...resumeInfo,
        }));
      }

      const uniq = Array.from(new Set(skipped));
      document.body.setAttribute('data-fill-skipped', JSON.stringify(uniq));
      document.body.setAttribute('data-fill-done', 'true');
      LOG('fill done', { skipped: uniq, resume: !!resumeInfo });
    } catch (e) {
      WARN('fill error', e);
      document.body.setAttribute(
        'data-fill-skipped',
        JSON.stringify(['__error__:' + (e?.message || String(e))])
      );
      document.body.setAttribute('data-fill-done', 'true');
    } finally {
      running = false;
    }
  }

  function watchTrigger() {
    const check = () => {
      if (document.body.getAttribute('data-ready-to-fill') === 'true' &&
          document.body.getAttribute('data-fill-done') !== 'true') {
        const jobId = document.body.getAttribute('data-job-id') || '';
        runFill(jobId);
      }
    };
    new MutationObserver(check).observe(document.body, {
      attributes: true,
      attributeFilter: ['data-ready-to-fill', 'data-job-id'],
    });
    check();
  }

  // ─── Iframe fill receiver (e.g. Comeet's comeet.co embed) ───────────────
  // When running inside a cross-origin iframe, listen for postMessage trigger
  // from the parent content script instead of body attributes.
  if (window !== window.top) {
    window.addEventListener('message', async (e) => {
      if (e.data?.type !== 'job-autofill-trigger') return;
      try {
        await loadData();
        const skipped = [];
        // Wait for form inputs to be ready
        await waitFor(() => fillableInputs().length > 0, { timeout: 5000 });
        await sleep(300);
        fillHeuristic(skipped);
        const resume = findFileInputByPattern(P.resume);
        if (resume && e.data.jobId) {
          window.parent.postMessage({
            type: 'job-autofill-resume',
            path: `~/Documents/job-application-automation/CVs/tailored/${e.data.jobId}.pdf`,
            selector: getUniqueSelector(resume),
            frame_url: window.location.href,
          }, e.origin || '*');
        }
        window.parent.postMessage({
          type: 'job-autofill-result',
          skipped,
          resume_input_found: !!resume,
        }, e.origin || '*');
      } catch (err) {
        window.parent.postMessage({
          type: 'job-autofill-result',
          skipped: ['__error__:' + (err?.message || String(err))],
          resume_input_found: false,
        }, e.origin || '*');
      }
    });
  }

  if (document.body) watchTrigger();
  else document.addEventListener('DOMContentLoaded', watchTrigger);

  // ─── Manual trigger from popup button ───────────────────────────────────
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg?.type !== 'job-autofill-run') return;
    runFill(msg.jobId || '').then(() => {
      sendResponse({
        ok: true,
        skipped: JSON.parse(document.body.getAttribute('data-fill-skipped') || '[]'),
        resumeInput: JSON.parse(document.body.getAttribute('data-resume-input') || 'null'),
      });
    });
    return true; // keep message channel open for async response
  });

  // ─── LinkedIn: Auto-Apply Redirect toggle ──────────────────────────────────
  function initLinkedInAutoApply() {
    if (!location.hostname.endsWith('linkedin.com')) return;
    if (window !== window.top) return; // only in top frame

    let autoRedirectOn = false;
    let lastClickedUrl = null;

    chrome.storage.local.get('auto-redirect', (data) => {
      autoRedirectOn = !!data['auto-redirect'];
    });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && 'auto-redirect' in changes) {
        autoRedirectOn = !!changes['auto-redirect'].newValue;
      }
    });

    async function tryAutoClick() {
      if (!autoRedirectOn) return;
      if (!/\/jobs\/view\//.test(location.pathname)) return;
      if (lastClickedUrl === location.href) return;

      const found = await waitFor(() => {
        const btns = Array.from(document.querySelectorAll('button, a'));
        // Easy Apply takes priority (inline modal handled by existing fillLinkedIn)
        const easy = btns.find(b =>
          /easy\s*apply/i.test((b.innerText || '').trim()) && b.offsetParent !== null
        );
        if (easy) return easy;
        // External Apply — match text "Apply" possibly with a trailing icon glyph
        const ext = btns.find(b =>
          /^apply$/i.test((b.innerText || '').replace(/[^\w ]/g, '').trim()) && b.offsetParent !== null
        );
        return ext || null;
      }, { timeout: 8000 });

      if (!found) return;
      lastClickedUrl = location.href;
      found.click();
    }

    // Detect SPA navigations via history API interception
    const origPushState = history.pushState.bind(history);
    history.pushState = (...args) => {
      origPushState(...args);
      setTimeout(tryAutoClick, 1000);
    };
    window.addEventListener('popstate', () => setTimeout(tryAutoClick, 1000));

    setTimeout(tryAutoClick, 500);
  }

  initLinkedInAutoApply();

  LOG('content script loaded', { host: location.hostname, isFrame: window !== window.top });
})();
