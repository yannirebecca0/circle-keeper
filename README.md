# Circle Keeper

**An AI coordinator for lending circles, powered by PayPal.**

Lending circles (tandas, susus, chit funds, hui) are how hundreds of millions of people save and borrow outside the banking system. Each round, every member pays in and one member receives the whole pot. They run on spreadsheets, group chats, and trust. Circle Keeper gives them a coordinator that never forgets a date and never plays favorites.

## What it does

1. **AI plans the rotation.** The coordinator reads each member's situation (steady income, urgent need, no history yet) and decides who receives when. Members who might stop paying after they receive go later; urgent but reliable members go earlier. It explains its reasoning in plain language and flags risk kindly, as circumstances, never character.
2. **PayPal collects contributions.** Each member pays through PayPal Checkout (Orders v2). Payments are captured and tracked per round.
3. **PayPal pays out the pot.** When everyone has paid, one click sends the pot to the round's recipient with PayPal Payouts.
4. **AI writes the nudges.** Late payers get a reminder whose tone fits the relationship and how overdue they are. It never shames and never reveals anyone else's private situation.

## Tools used

- **PayPal** (sandbox): Orders v2 (create + capture contributions) and Payouts v1 (pay the pot). See `paypal.js`.
- **AI:** Google Gemini (`gemini-3.8-flash` by default, with automatic retries and fallback models, free tier available) via the Gemini API, or Anthropic Claude as an alternative (`claude-sonnet-5-5` by default). Used for rotation planning with structured JSON output and validation, and for tone-aware reminders. See `ai.js`. Choose with `GEMINI_API_KEY` or `ANTHROPIC_API_KEY`; override models with `GEMINI_MODEL` / `CLAUDE_MODEL`.
- **Runtime:** Node.js 18+, zero npm dependencies. Plain HTML/JS frontend.

If no AI key is set, the app still runs with deterministic fallbacks (sign-up order, template reminders) and the UI shows the AI badge as off.

## Run it

You need Node 18+ and a free [PayPal Developer](https://developer.paypal.com) account.

```bash
git clone <this repo>
cd circle-keeper
cp .env.example .env
# fill in .env (see below)
npm start
# open http://localhost:3000
```

### Configure `.env`

1. In the PayPal Developer Dashboard, go to **Apps & Credentials** (Sandbox) and create an app. Copy the **Client ID** and **Secret** into `PAYPAL_CLIENT_ID` and `PAYPAL_CLIENT_SECRET`.
2. Under **Sandbox > Accounts**, you need sandbox *personal* accounts. Put five of their emails in `DEMO_EMAILS` (comma-separated), one per demo member (Maria, Ayesha, Dev, Luz, Tomas). Payouts go to these.
3. Turn the AI coordinator on with one key: `GEMINI_API_KEY` (free at https://aistudio.google.com/apikey) or `ANTHROPIC_API_KEY` (https://console.anthropic.com). If both are set, Gemini is used. If a Gemini model name stops working, set `GEMINI_MODEL` to a current one from AI Studio.

### Demo walkthrough

1. Click **Load demo circle** (five members, USD 20 each, pot of USD 100).
2. Click **Let AI plan the rotation** and read the plan and risk tags.
3. For each member, click **Pay with PayPal**, log in with a sandbox personal account, and approve. You land back on the circle with that member marked paid.
4. Try **Nudge** on an unpaid member and change "days late" to see the tone shift.
5. Once everyone has paid, click **Pay out** to send the pot to the round's recipient with PayPal Payouts.

Notes: the sandbox buyer you log in with can be any sandbox personal account; the payout recipient is the email set in `DEMO_EMAILS`. Payouts must be enabled for your sandbox app/business account. If the payout call fails with a permissions error, check your app's features in the dashboard.

## Project layout

```
server.js        HTTP server, routes, tiny JSON store
paypal.js        PayPal Orders + Payouts wrapper
ai.js            AI rotation planner and nudge writer
public/index.html  UI
```

## Limitations (it's a hackathon prototype)

- Single demo circle stored in `data.json`; no user accounts or auth.
- Sandbox only. A production version would need KYC, compliance review, and a legal structure suited to each jurisdiction.
- Contributions are collected into the app's PayPal business account and paid out from it.

## License

MIT. See [LICENSE](LICENSE).
