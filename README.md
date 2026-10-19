# Referral Outreach Engine

A serverless cold-outreach automation for job seekers, built on **Google Apps Script**.

For every company on your list it finds recruiters (Prospeo), reveals their **verified** work email, writes a personalized email tailored to the role and job description (Gemini), sends it from your Gmail with your resume attached, and logs everything to a Google Sheet. It runs on Google's servers, so there is nothing to host, keep awake or pay for.

## How it works

```
Google Sheet (target companies)
        │
        ▼
Skip: already contacted · already attempted · excluded companies · duplicates
        │
        ▼
Prospeo search-person ──► rank recruiters (preferred region first) ──► top N
        │
        ▼
Prospeo enrich-person ──► keep only VERIFIED, unmasked emails not contacted before
        │
        ▼
Gemini ──► personalized subject + body (JSON)
        │
        ▼
Gmail ──► send with resume (PDF from Google Drive) attached
        │
        ▼
Google Sheet ──► log sent / attempted / unsent  +  run-summary email to you
```

## Features

- Personalized emails: Gemini writes a new subject and body for every recruiter, using the role, the job description and your profile.
- Verified emails only. Masked, unverified or previously contacted addresses are skipped.
- No duplicate outreach: companies are tracked across runs, and each recruiter's email is only ever used once.
- Fails loudly. An invalid API key, missing credits or an unknown model stops the run with a clear reason, instead of silently sending bad emails.
- A run-summary email after each real run.
- Safety limits: a daily email cap (default 50), plus automatic continuation when a run reaches Apps Script's 6-minute limit.
- A safe test mode: one function tests Gemini, Gmail and the resume attachment without using Prospeo credits, and another tests the full pipeline but sends to you instead of the recruiter.
- An optional daily schedule.

## Google Sheet setup

Create one spreadsheet with four tabs. The header row (row 1) must use these column names. Column order doesn't matter.

| Tab | Columns | Filled by |
|---|---|---|
| Target companies | `Company`, `Position`, `Domain`, `JD Text` | You. `Domain` is the company website, e.g. `stripe.com` |
| Already Contacted | `Name`, `Email`, `Company`, `Subject`, `Email Body` | Script, after each sent email |
| Attempted | `Date`, `Company`, `Domain`, `Status` | Script, for every company searched |
| Unsent Emails | `Date`, `Company`, `Position`, `Domain`, `Contact Name`, `Email`, `JD Text` | Script, when an email couldn't be written or sent |

## Setup (about 10 minutes)

1. Get API keys:
   - Prospeo: create an account at prospeo.io and copy your API key from the dashboard.
   - Gemini: go to aistudio.google.com and use **Get API key**.
2. Upload your resume PDF to Google Drive and copy its file ID, which is the part of the link between `/d/` and `/view`.
3. Create the Apps Script project. Go to [script.google.com](https://script.google.com) → **New project**, signed in as the Gmail account you want to send from. Replace the sample code with [`src/Code.gs`](src/Code.gs).
4. Configure it at the top of the script:
   - paste both API keys;
   - set `CONFIG.SPREADSHEET_ID`, the four tab IDs (the number after `#gid=` in the sheet URL), `RESUME_FILE_ID`, `SENDER_NAME`, `MY_EMAIL` and `EXCLUDE_COMPANIES`;
   - fill in `PROFILE` with your background, achievements and sign-off.
5. Save with **Ctrl+S**.
6. Test it:
   - Run `testEmailOnly`. Google will ask for permission: **Review permissions** → choose your account → **Advanced** → **Go to … (unsafe)** → **Allow**. ("Unsafe" only means Google hasn't reviewed your own private script.) You should receive one email with your resume attached.
   - Optionally, run `testOneCompany` to try the full pipeline with the email sent to you.
7. Do the first real run safely. Set `DAILY_EMAIL_LIMIT` to `1`, run `runOutreach`, and check your Gmail Sent folder and the sheet. Then set it back to `50`.
8. Automate it (optional). Run `setupDailyRun` once. It then runs every day around 10 AM in `CONFIG.TIMEZONE`. You don't need to **Deploy** anything; the schedule always runs your latest saved code.

## Functions

| Function | What it does |
|---|---|
| `testEmailOnly` | Writes one email for the first company and sends it to you. No Prospeo credits used. |
| `testOneCompany` | Full pipeline for one company, but the email goes to you. Nothing is logged. |
| `runOutreach` | The real run. |
| `setupDailyRun` / `stopDailyRun` | Turn the daily schedule on or off. |

## Limits

These are Google's limits for free accounts. See [Apps Script quotas](https://developers.google.com/apps-script/guides/services/quotas).

- About 100 emails per day from a free Gmail account. The script caps itself at `DAILY_EMAIL_LIMIT`.
- 6 minutes per execution. The script stops at about 4.5 minutes and schedules its own continuation.
- Prospeo and Gemini usage is billed or limited by those providers.

## Customizing

- **Tone and content of emails:** edit `PROFILE` and `buildPrompt_()`.
- **Which recruiters to target:** edit `RECRUITER_TITLES`, `CONTACTS_PER_COMPANY` and `PREFERRED_REGION`.
- **Gemini model:** edit `GEMINI_MODEL`.

## Privacy and responsible use

- Never commit real API keys. The keys only live inside your Apps Script project.
- Send personalized, relevant emails at a modest volume, and respect anyone who asks not to be contacted again. Follow the anti-spam laws that apply where you and your recipients are.

## Why Apps Script (and not n8n)

This project started as an n8n workflow on a free cloud instance. The free server kept running out of memory and timing out, and nodes set to "continue on error" hid failures behind green checkmarks, so emails silently weren't being sent. Apps Script runs the same logic on Google's infrastructure, uses the Google account's own access to Sheets, Drive and Gmail (no OAuth tokens to expire), and costs nothing.
