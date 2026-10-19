/**
 * Referral Outreach Engine — Google Apps Script
 *
 * Finds recruiters at your target companies (Prospeo), reveals verified emails,
 * writes a personalized cold email for each one (Gemini), sends it from your Gmail
 * with your resume attached, and logs everything to a Google Sheet.
 *
 * Functions (pick one in the dropdown next to "Run"):
 *   testEmailOnly   -> writes one email and sends it to YOU. Uses no Prospeo credits.
 *   testOneCompany  -> full pipeline for one company, but the email goes to YOU, not the recruiter.
 *   runOutreach     -> the real run: emails recruiters and logs to the sheet.
 *   setupDailyRun   -> run once to schedule runOutreach every day (~10 AM in CONFIG.TIMEZONE).
 *   stopDailyRun    -> removes that schedule.
 *
 * Setup: see README.md.
 */

// ===================== PASTE YOUR TWO KEYS HERE =====================
// Never commit real keys to a public repository.
const PROSPEO_API_KEY = 'PASTE_PROSPEO_KEY_HERE';
const GEMINI_API_KEY = 'PASTE_GEMINI_KEY_HERE';
// ====================================================================

const CONFIG = {
  SPREADSHEET_ID: 'YOUR_SPREADSHEET_ID',  // from the sheet URL: docs.google.com/spreadsheets/d/<THIS>/edit
  TARGET_GID: 0,                          // tab ids: the number after "#gid=" in the URL when that tab is open
  CONTACTED_GID: 111111111,               // "Already Contacted" tab
  ATTEMPTED_GID: 222222222,               // "Attempted" tab
  UNSENT_GID: 333333333,                  // "Unsent Emails" tab
  RESUME_FILE_ID: 'YOUR_RESUME_DRIVE_FILE_ID', // from the Drive link: drive.google.com/file/d/<THIS>/view
  GEMINI_MODEL: 'gemini-3.8-flash',
  SENDER_NAME: 'Your Name',
  MY_EMAIL: 'you@example.com',            // test emails and run summaries go here
  EXCLUDE_COMPANIES: ['your-current-employer'], // lowercase; any company containing these is skipped
  CONTACTS_PER_COMPANY: 2,          // top N recruiters per company
  REVEAL_DELAY_MS: 7000,            // minimum gap between Prospeo email reveals
  DAILY_EMAIL_LIMIT: 50,            // safety cap; free Gmail allows ~100/day
  MAX_RUNTIME_MS: 4.5 * 60 * 1000,  // stop safely before Apps Script's 6-minute limit
  TEST_MAX_COMPANIES: 3,            // testOneCompany tries at most this many companies
  TIMEZONE: 'Asia/Kolkata',
  RECRUITER_TITLES: ['recruiter', 'talent', 'hr', 'hiring', 'people'],
  PREFERRED_REGION: 'india',        // recruiters whose headline mentions this are tried first
};

// Everything Gemini needs to know about you. Edit freely.
const PROFILE = {
  name: 'Your Name',
  currentRole: 'SDE-2 at Example Corp',
  roleFraming:
    'SDE-2 at Example Corp, 3+ years building and scaling backend and product systems; owns features end-to-end (design, development, production rollout, observability, optimization).',
  aiTooling:
    'Claude, Cursor, GitHub Copilot, MCP integrations, AI agent workflows, spec-driven development, RAG, vector databases, LLMs, embeddings.',
  techStack:
    'Go, Java, Spring Boot, Microservices, gRPC, REST APIs, Kafka, AWS, GCP, Redis, Kubernetes, CI/CD, System Design.',
  achievements: [
    'Built systems serving 2M+ monthly users with measurable business impact.',
    'Delivered end-to-end features that improved user retention and GMV.',
    'Strong production ownership: observability, SLOs, monitoring, incident handling, performance optimization.',
    'Built a multimodal RAG image search system (search by uploading an image).',
  ],
  // Highlight to lead with when the role mentions AI/ML/LLM/agents/data/search.
  aiLeadProject: 'the multimodal RAG image search project',
  signOff: 'Phone - +00 00000 00000\nEmail - you@example.com\nLinkedIn - https://www.linkedin.com/in/your-profile/\nRegards,\nYour Name',
};

// ----------------------------- Entry points -----------------------------

function testOneCompany() {
  run_({ test: true });
}

function runOutreach() {
  run_({ test: false });
}

// Used only by the automatic "continue after 6-minute limit" trigger.
function continueOutreach() {
  run_({ test: false });
}

// Checks Gemini + Gmail + resume attachment WITHOUT using any Prospeo credits:
// writes an email for the first company in your sheet and sends it to you.
function testEmailOnly() {
  checkKeys_();
  const ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  const resume = getResume_();
  const row = readSheet_(ss, CONFIG.TARGET_GID).rows.find(
    r => String(r['Company'] || '').trim() && !isExcluded_(r['Company'])
  );
  if (!row) throw new Error('No company found in the target companies tab.');
  const c = {
    name: 'Test Recruiter',
    company: String(row['Company']).trim(),
    position: String(row['Position'] || '').trim(),
    jd: String(row['JD Text'] || '').trim(),
  };
  const draft = generateEmail_(c);
  if (!draft) throw new Error('Gemini did not return an email — see the log lines above.');
  GmailApp.sendEmail(CONFIG.MY_EMAIL, `[TEST — email + resume check] ${draft.subject}`, draft.body, {
    attachments: [resume],
    name: CONFIG.SENDER_NAME,
  });
  console.log(`Test email for ${c.company} sent to ${CONFIG.MY_EMAIL}. No Prospeo credits used.`);
}

function setupDailyRun() {
  stopDailyRun();
  ScriptApp.newTrigger('runOutreach').timeBased().everyDays(1).atHour(10).inTimezone(CONFIG.TIMEZONE).create();
  console.log('Daily run scheduled for ~10 AM IST.');
}

function stopDailyRun() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'runOutreach')
    .forEach(t => ScriptApp.deleteTrigger(t));
}

// ------------------------------ Main logic ------------------------------

function run_(opts) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) {
    console.log('Another run is already in progress. Try again in a few minutes.');
    return;
  }
  const summary = { companies: 0, sent: 0, unsent: 0, noContact: 0, skipped: 0, stoppedReason: '' };
  let ctx = null;
  try {
    clearContinuationTriggers_();
    checkKeys_();

    const start = Date.now();
    const ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
    const resume = getResume_(); // fail fast before spending any credits

    const target = readSheet_(ss, CONFIG.TARGET_GID);
    const contacted = readSheet_(ss, CONFIG.CONTACTED_GID);
    const attempted = readSheet_(ss, CONFIG.ATTEMPTED_GID);

    const contactedCompanies = new Set(contacted.rows.map(r => norm_(r['Company'])).filter(Boolean));
    const attemptedCompanies = new Set(attempted.rows.map(r => norm_(r['Company'])).filter(Boolean));
    const contactedEmails = new Set(contacted.rows.map(r => norm_(r['Email'])).filter(Boolean));

    const seen = new Set(); // same company listed twice (e.g. two roles) is searched only once per run
    const queue = target.rows.filter(r => {
      const c = norm_(r['Company']);
      if (!c) return false;
      if (seen.has(c)) return false;
      seen.add(c);
      if (isExcluded_(c)) return false; // e.g. current employer
      if (!String(r['Domain'] || '').trim()) return false; // Prospeo needs a website/domain
      return !contactedCompanies.has(c) && !attemptedCompanies.has(c);
    });

    console.log(`${queue.length} new companies to process${opts.test ? ' (TEST MODE)' : ''}.`);

    ctx = {
      test: opts.test,
      ss,
      resume,
      contactedEmails,
      sentToday: getSentToday_(),
      lastRevealAt: 0,
      summary,
    };

    for (const row of queue) {
      if (Date.now() - start > CONFIG.MAX_RUNTIME_MS) {
        if (!opts.test) {
          scheduleContinuation_();
          summary.stoppedReason = 'Reached the 6-minute limit; continuing automatically in ~1 minute.';
        } else {
          summary.stoppedReason = 'Reached the time limit.';
        }
        break;
      }
      if (!opts.test && ctx.sentToday >= CONFIG.DAILY_EMAIL_LIMIT) {
        summary.stoppedReason = `Daily limit of ${CONFIG.DAILY_EMAIL_LIMIT} emails reached.`;
        break;
      }
      if (opts.test && (summary.sent >= 1 || summary.companies >= CONFIG.TEST_MAX_COMPANIES)) break;

      summary.companies++;
      processCompany_(row, ctx);
    }
  } catch (e) {
    summary.stoppedReason = 'STOPPED: ' + (e && e.message ? e.message : e);
    console.error(summary.stoppedReason);
  } finally {
    const text =
      `Companies processed: ${summary.companies}\n` +
      `Emails sent: ${summary.sent}\n` +
      `Not sent (logged to "Unsent Emails"): ${summary.unsent}\n` +
      `No recruiter found: ${summary.noContact}\n` +
      `Skipped (no verified email / already contacted): ${summary.skipped}\n` +
      (summary.stoppedReason ? `\nNote: ${summary.stoppedReason}\n` : '');
    console.log('SUMMARY\n' + text);
    if (!opts.test && (summary.companies > 0 || summary.stoppedReason)) {
      try {
        GmailApp.sendEmail(CONFIG.MY_EMAIL, `Referral Engine run summary — ${summary.sent} sent`, text);
      } catch (e) {
        console.log('Could not send summary email: ' + e);
      }
    }
    lock.releaseLock();
  }
}

function processCompany_(row, ctx) {
  const company = String(row['Company'] || '').trim();
  const position = String(row['Position'] || '').trim();
  const domain = String(row['Domain'] || '').trim();
  const jd = String(row['JD Text'] || '').trim();

  const people = searchRecruiters_(domain);
  if (!ctx.test) {
    appendRow_(ctx.ss, CONFIG.ATTEMPTED_GID, { Date: today_(), Company: company, Domain: domain, Status: 'Searched' });
  }

  const picked = pickBest_(people).slice(0, CONFIG.CONTACTS_PER_COMPANY);
  if (!picked.length) {
    console.log(`${company}: no recruiter found.`);
    ctx.summary.noContact++;
    return;
  }

  for (const p of picked) {
    if (ctx.test && ctx.summary.sent >= 1) return;
    if (!ctx.test && ctx.sentToday >= CONFIG.DAILY_EMAIL_LIMIT) return;

    const personId = p.person_id || p.id;
    if (!personId) continue;

    const revealed = revealEmail_(personId, ctx);
    const rp = (revealed && revealed.person) || {};
    const eo = rp.email || {};
    const email = String(eo.email || '').trim();
    const name = rp.full_name || p.full_name || [p.first_name, p.last_name].filter(Boolean).join(' ').trim() || '';
    const verified = eo.status === 'VERIFIED' && eo.revealed === true && !!email && !email.includes('*');

    if (!verified) {
      console.log(`${company}: no verified email for ${name || personId}.`);
      ctx.summary.skipped++;
      continue;
    }
    if (ctx.contactedEmails.has(email.toLowerCase())) {
      console.log(`${company}: ${email} was already contacted — skipping.`);
      ctx.summary.skipped++;
      continue;
    }

    const contact = { name, email, company, position, domain, jd };
    let draft;
    try {
      draft = generateEmail_(contact);
    } catch (e) {
      // Gemini key/model problem: log this contact so the revealed email isn't lost, then stop the run
      // so we don't keep spending Prospeo credits on companies we can't email.
      logUnsent_(ctx, contact);
      throw e;
    }
    if (!draft) {
      console.log(`${company}: Gemini could not write the email — logged to "Unsent Emails".`);
      logUnsent_(ctx, contact);
      continue;
    }

    const to = ctx.test ? CONFIG.MY_EMAIL : email;
    const subject = ctx.test ? `[TEST — would go to ${email}] ${draft.subject}` : draft.subject;
    try {
      GmailApp.sendEmail(to, subject, draft.body, { attachments: [ctx.resume], name: CONFIG.SENDER_NAME });
    } catch (e) {
      console.log(`${company}: sending to ${email} failed: ${e}`);
      logUnsent_(ctx, contact);
      continue;
    }

    console.log(`${company}: email sent to ${to}${ctx.test ? ' (test)' : ''}.`);
    ctx.summary.sent++;
    ctx.contactedEmails.add(email.toLowerCase());
    if (!ctx.test) {
      appendRow_(ctx.ss, CONFIG.CONTACTED_GID, {
        Name: name,
        Email: email,
        Company: company,
        Subject: draft.subject,
        'Email Body': draft.body,
      });
      ctx.sentToday = incrementSentToday_();
    }
  }
}

function logUnsent_(ctx, c) {
  ctx.summary.unsent++;
  if (ctx.test) return;
  appendRow_(ctx.ss, CONFIG.UNSENT_GID, {
    Date: today_(),
    Company: c.company,
    Position: c.position,
    Domain: c.domain,
    'Contact Name': c.name,
    Email: c.email,
    'JD Text': c.jd,
  });
}

// ------------------------------- Prospeo --------------------------------

function searchRecruiters_(domain) {
  const res = postJson_(
    'https://api.prospeo.io/search-person',
    { 'X-KEY': PROSPEO_API_KEY },
    {
      page: 1,
      filters: {
        company: { websites: { include: [domain] } },
        person_job_title: { include: CONFIG.RECRUITER_TITLES, match_mode: 'CONTAINS' },
      },
    },
    3,
    2000
  );
  checkProspeoFatal_(res);
  if (!res || !res.json) return [];
  if (res.json.error) {
    if (res.json.error_code !== 'NO_RESULTS') console.log(`Prospeo search for ${domain}: ${res.text}`);
    return [];
  }
  return (res.json.results || []).map(r => r.person || {});
}

function revealEmail_(personId, ctx) {
  const wait = CONFIG.REVEAL_DELAY_MS - (Date.now() - ctx.lastRevealAt);
  if (ctx.lastRevealAt && wait > 0) Utilities.sleep(wait);
  const res = postJson_(
    'https://api.prospeo.io/enrich-person',
    { 'X-KEY': PROSPEO_API_KEY },
    { only_verified_email: true, data: { person_id: personId } },
    3,
    5000
  );
  ctx.lastRevealAt = Date.now();
  checkProspeoFatal_(res);
  if (!res || !res.json || res.json.error) return null;
  return res.json;
}

function checkProspeoFatal_(res) {
  if (!res) return;
  const code = res.code;
  const errCode = res.json && res.json.error_code ? String(res.json.error_code) : '';
  if (code === 401 || code === 403 || /INVALID_API_KEY|UNAUTHORIZED/i.test(errCode)) {
    throw new Error('Prospeo rejected the API key. Check PROSPEO_API_KEY at the top of the script.');
  }
  if (code === 402 || /CREDIT/i.test(errCode)) {
    throw new Error('Prospeo says you are out of credits.');
  }
}

// Recruiters in CONFIG.PREFERRED_REGION first, clearly-elsewhere ones last.
function pickBest_(people) {
  function indiaScore(p) {
    const text = [p.headline, p.current_job_title].filter(Boolean).join(' ').toLowerCase();
    if (CONFIG.PREFERRED_REGION && text.includes(CONFIG.PREFERRED_REGION)) return 2;
    if (/\b(usa|uk|europe|emea|apac|singapore|dubai|uae)\b/.test(text)) return 0;
    return 1;
  }
  return people
    .map(p => ({ p, score: indiaScore(p) }))
    .sort((a, b) => b.score - a.score)
    .map(x => x.p);
}

// -------------------------------- Gemini --------------------------------

function generateEmail_(c) {
  const res = postJson_(
    `https://generativelanguage.googleapis.com/v1beta/models/${CONFIG.GEMINI_MODEL}:generateContent`,
    { 'x-goog-api-key': GEMINI_API_KEY },
    {
      contents: [{ parts: [{ text: buildPrompt_(c) }] }],
      generationConfig: { responseMimeType: 'application/json' },
    },
    3,
    5000
  );
  if (!res) return null;
  if (res.code === 400 && /API key/i.test(res.text)) throw new Error('Gemini rejected the API key. Check GEMINI_API_KEY at the top of the script.');
  if (res.code === 401 || res.code === 403) throw new Error('Gemini rejected the API key. Check GEMINI_API_KEY at the top of the script.');
  if (res.code === 404) throw new Error(`Gemini model "${CONFIG.GEMINI_MODEL}" was not found. Change GEMINI_MODEL in CONFIG.`);
  if (res.code !== 200 || !res.json) {
    console.log(`Gemini error ${res.code}: ${String(res.text).slice(0, 300)}`);
    return null;
  }
  try {
    let text = res.json.candidates[0].content.parts[0].text;
    text = String(text).trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '').trim();
    const parsed = JSON.parse(text);
    const subject = String(parsed.subject || '').trim();
    const body = String(parsed.body || '').replace(/\\n/g, '\n').trim();
    if (!subject || !body) return null;
    return { subject, body };
  } catch (e) {
    console.log('Could not read Gemini reply: ' + e);
    return null;
  }
}

function buildPrompt_(c) {
  const p = PROFILE;
  const achievements = p.achievements.map(a => '- ' + a).join('\n');
  return `You are writing a cold outreach email from ${p.name}, ${p.currentRole}, to a recruiter/HR contact, applying for a role. Write in a warm, direct, professional tone, 160-220 words, no fluff, no hedging.

RECIPIENT: ${c.name || 'the hiring team'} at ${c.company}
ROLE: ${c.position}
JOB DESCRIPTION (for tailoring, may be partial): ${c.jd || 'Not provided'}

CANDIDATE BACKGROUND:

ALWAYS INCLUDE THESE, do not cut them for length:
- Role framing: ${p.roleFraming}
- AI & Engineering tooling, as its own labeled bullet (e.g. "AI & Engineering: ..."): ${p.aiTooling}
- Technical stack, as its own labeled bullet (e.g. "Technical Expertise: ..."): ${p.techStack}

PICK 2-3 OF THESE, choose the ones most relevant to this specific role/JD, use 1-2 concrete metrics:
${achievements}

IF the JD or role title mentions AI, ML, LLM, agents, automation, data, or search/recommendation systems: lead with ${p.aiLeadProject} and frame the candidate as an AI-native engineer throughout the email.
- Always position the candidate as a product/backend engineer who ships end-to-end features, NOT as an infra/platform/DevOps engineer.

STRUCTURE (follow this shape, but tailor the wording and chosen highlights to the role):
1. Opening line: came across the ${c.position} opening at ${c.company} and it closely aligns with the candidate's experience.
2. One sentence on the current role and years of experience.
3. 4-6 bullet-style highlights (use • characters): must include the AI & Engineering bullet and the Technical Expertise bullet, plus the 2-3 JD-tailored achievement bullets chosen above.
4. Closing: resume attached, happy to discuss fit.
5. Sign-off exactly as:
${p.signOff}

SUBJECT LINE: Write a short, attention-grabbing subject line a recruiter would actually open — specific to the role and company, professional (no ALL CAPS, no spam words like "free" or excessive punctuation). Think like a recruiter scanning a crowded inbox.

Return ONLY valid JSON, no markdown, no code fences, in exactly this shape: {"subject": "...", "body": "..."}. In the body, use \\n for line breaks.`;
}

// ------------------------------- Helpers --------------------------------

function postJson_(url, headers, payload, tries, waitMs) {
  let last = null;
  for (let i = 0; i < tries; i++) {
    if (i > 0) Utilities.sleep(waitMs);
    try {
      const res = UrlFetchApp.fetch(url, {
        method: 'post',
        contentType: 'application/json',
        headers: headers,
        payload: JSON.stringify(payload),
        muteHttpExceptions: true,
      });
      const code = res.getResponseCode();
      const text = res.getContentText();
      let json = null;
      try {
        json = JSON.parse(text);
      } catch (e) {}
      last = { code, json, text };
      if (code === 429 || code >= 500) continue; // rate-limited or server hiccup: retry
      return last;
    } catch (e) {
      last = { code: 0, json: null, text: String(e) };
    }
  }
  return last;
}

function getSheetByGid_(ss, gid) {
  const sheet = ss.getSheets().find(s => s.getSheetId() === Number(gid));
  if (!sheet) throw new Error(`Could not find the sheet tab with gid ${gid} in the tracker spreadsheet.`);
  return sheet;
}

function readSheet_(ss, gid) {
  const values = getSheetByGid_(ss, gid).getDataRange().getValues();
  if (!values.length) return { headers: [], rows: [] };
  const headers = values[0].map(h => String(h).trim());
  const rows = values.slice(1).map(v => {
    const o = {};
    headers.forEach((h, i) => {
      if (h) o[h] = v[i];
    });
    return o;
  });
  return { headers, rows };
}

// Appends a row by matching column headers (case/space tolerant), so column order doesn't matter.
function appendRow_(ss, gid, obj) {
  const sheet = getSheetByGid_(ss, gid);
  const lastCol = sheet.getLastColumn();
  let headers = lastCol ? sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(h => String(h).trim()) : [];
  if (!headers.filter(Boolean).length) {
    headers = Object.keys(obj);
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  }
  const lookup = {};
  Object.keys(obj).forEach(k => (lookup[k.trim().toLowerCase()] = obj[k]));
  const row = headers.map(h => {
    const v = lookup[h.toLowerCase()];
    if (v === undefined || v === null) return '';
    const s = String(v);
    return /^[=+\-@]/.test(s) ? "'" + s : s; // stop text being treated as a formula
  });
  sheet.appendRow(row);
}

function getResume_() {
  try {
    return DriveApp.getFileById(CONFIG.RESUME_FILE_ID).getBlob();
  } catch (e) {
    throw new Error(
      `Cannot open the resume file (ID ${CONFIG.RESUME_FILE_ID}). Share it with ${CONFIG.MY_EMAIL} (Viewer is enough), or change RESUME_FILE_ID.`
    );
  }
}

function checkKeys_() {
  if (PROSPEO_API_KEY.indexOf('PASTE_') === 0) throw new Error('Paste your Prospeo API key at the top of the script.');
  if (GEMINI_API_KEY.indexOf('PASTE_') === 0) throw new Error('Paste your Gemini API key at the top of the script.');
  if (CONFIG.SPREADSHEET_ID.indexOf('YOUR_') === 0) throw new Error('Set CONFIG.SPREADSHEET_ID to your Google Sheet ID.');
  if (CONFIG.RESUME_FILE_ID.indexOf('YOUR_') === 0) throw new Error('Set CONFIG.RESUME_FILE_ID to your resume\'s Google Drive file ID.');
}

function isExcluded_(company) {
  const c = norm_(company);
  return (CONFIG.EXCLUDE_COMPANIES || []).some(x => x && c.includes(String(x).toLowerCase()));
}

function norm_(v) {
  return String(v || '').toLowerCase().trim();
}

function today_() {
  return Utilities.formatDate(new Date(), CONFIG.TIMEZONE, 'yyyy-MM-dd');
}

function getSentToday_() {
  return Number(PropertiesService.getScriptProperties().getProperty('sent_' + today_()) || 0);
}

function incrementSentToday_() {
  const props = PropertiesService.getScriptProperties();
  const key = 'sent_' + today_();
  const n = Number(props.getProperty(key) || 0) + 1;
  props.setProperty(key, String(n));
  return n;
}

function scheduleContinuation_() {
  ScriptApp.newTrigger('continueOutreach').timeBased().after(60 * 1000).create();
}

function clearContinuationTriggers_() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'continueOutreach')
    .forEach(t => ScriptApp.deleteTrigger(t));
}
