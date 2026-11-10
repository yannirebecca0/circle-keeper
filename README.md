# Circle Keeper

**An AI coordinator for lending circles, powered by PayPal.**

Lending circles (tandas, susus, chit funds, hui) are one of the oldest ways people save and borrow together. Each round, every member pays in and one member takes home the whole pot. They usually run on group chats, spreadsheets, and one tired organizer who has to remember who paid, chase whoever is late, and decide who gets the money when.

Circle Keeper gives every circle a coordinator. An AI agent plans the payout order, keeps track of payments through PayPal, reminds late members in the right tone, and suggests changes when someone is struggling. PayPal collects every contribution and pays out the pot. The organizer stays in control: **the agent can't move money without the organizer's approval.**

> **Try it:** `<hosted demo URL>` · Sandbox buyer login for checkout: `<sandbox email>` / `<sandbox password>`

## What it does

1. **Start a circle in a minute.** The organizer names the circle, sets the contribution and adds members with their PayPal emails and a line about each person's situation. There's also a one-click demo circle.
2. **The AI plans the rotation.** It reads each member's situation and decides who receives when. Steady, reliable members go early. Members who could stop paying after receiving go later. Urgent needs are respected when it's safe. The plan comes with a plain-language rationale and a risk tag for each member. Risk is described as a circumstance, never as a judgment of character.
3. **Every member gets a private link.** Members see only their own status, the schedule and a **Pay with PayPal** button, never other members' notes or risk tags.
4. **PayPal collects contributions.** Orders v2 creates and captures each member's payment. Captures are confirmed three ways: PayPal's return redirect, **signed PayPal webhooks**, and the agent looking up open orders. That last check catches members who approved a payment but closed the tab before returning.
5. **The AI coordinator runs each round.** One click runs a check-in, and the agent works through it with tools:
   - syncs the round's open PayPal orders and captures approved ones
   - writes reminders that fit the relationship and get firmer as a payment gets later
   - proposes a **position swap** when a member is struggling (the organizer can also tell it things like "Luz just lost a shift")
   - once everyone has paid, **asks the organizer to approve the payout**
   - checks the PayPal status of past payouts
6. **PayPal pays out the pot.** After approval, Payouts v1 sends the pot to the round's recipient, and the next round begins. Payout status updates through webhooks.

Everything the agent does is recorded in an activity feed, so the organizer can see exactly what happened and why.

### Guardrails (enforced in code, not just in the prompt)

- The agent has **no tool that moves money**. Payouts and position swaps become requests that the organizer approves or declines.
- A payout is only possible when every member has paid. It uses a deterministic `sender_batch_id` per round, so a repeated request is rejected by PayPal instead of paying twice. A second payout request while one is in flight is also refused.
- A member can't be charged twice in a round: a second approved order is not captured.
- The agent can't remind someone who has already paid, or remind the same member twice in one day.
- Members' private notes and risk tags are only visible on the organizer's page. The agent is told never to repeat them in reminders.
- Access is by unguessable links: one organizer link and one private link per member. Pages send no referrer, so links don't leak to other sites.

## Tools used

| Tool | How it's used |
|---|---|
| **PayPal Orders v2** | Create, look up and capture each member's contribution (`paypal.js`). |
| **PayPal Payouts v1** | Send the pot to each round's recipient and check payout status. |
| **PayPal Webhooks** | Signed `PAYMENT.CAPTURE.*` and `PAYMENT.PAYOUTS*` events, verified with `verify-webhook-signature`, update payments and payouts as they happen. |
| **Google Gemini** (`gemini-3.8-flash` by default, free tier) **or Anthropic Claude** (`claude-sonnet-5-5`) | Rotation planning with validated JSON output, and the coordinator agent through function calling / tool use (`ai.js`, `agent.js`). Choose with `GEMINI_API_KEY` or `ANTHROPIC_API_KEY`. |
| **Render** | Hosting through the included `render.yaml` blueprint. |
| **Node.js 18+** | Zero npm dependencies: only Node built-ins and `fetch`. Plain HTML/JS frontend. |

If no AI key is set, the app still works with rule-based fallbacks: sign-up order, template reminders, and a payout request when everyone has paid.

## Run it locally

You need Node 18+ and a free [PayPal Developer](https://developer.paypal.com) account.

```bash
git clone https://github.com/<your-username>/circle-keeper.git
cd circle-keeper
cp .env.example .env
# fill in .env (see below)
npm start
# open http://localhost:3000
```

### Configure `.env`

1. **PayPal app:** In the PayPal Developer Dashboard, go to **Apps & Credentials** (Sandbox) and create an app. Copy the **Client ID** and **Secret** into `PAYPAL_CLIENT_ID` and `PAYPAL_CLIENT_SECRET`. Make sure **Payouts** is enabled for the app.
2. **Sandbox accounts:** Under **Sandbox > Accounts**, create sandbox *personal* accounts. Put five of their emails in `DEMO_EMAILS` (comma-separated). Demo payouts go to these. Log in with any sandbox personal account when you pay at checkout.
3. **AI:** Set `GEMINI_API_KEY` (free at https://aistudio.google.com/apikey) or `ANTHROPIC_API_KEY`. If a Gemini model name stops working, set `GEMINI_MODEL` to a current one from AI Studio.
4. **Webhooks (optional, needs a public URL):** In your sandbox app, add a webhook pointing at `https://<your-host>/api/paypal/webhook`. Subscribe to `Payment capture completed/denied/pending/refunded/reversed` and the `Payouts` batch and item events, then put the Webhook ID in `PAYPAL_WEBHOOK_ID`. Without webhooks the app checks PayPal directly, through **Check PayPal now** or the agent's sync.

### Demo walkthrough

1. Click **Load demo circle** (five members, USD 20 each, pot of USD 100).
2. Click **Let AI plan the rotation** and read the plan and risk tags.
3. Click **Link** next to a member and open it in a private window to see their page.
4. Click **+3 days** on the demo clock, then **Run AI check-in**. Watch the agent sync PayPal and send reminders. Try adding a note like "Luz just lost a shift at work" and see it suggest a swap.
5. Skip ahead a week and run it again: reminders become firmer, and the agent won't remind anyone twice in one day.
6. Pay for each member with **Pay with PayPal**, logging in with a sandbox personal account.
7. When everyone has paid, run a check-in: the agent asks you to approve the payout. Approve it and the pot is sent with PayPal Payouts.

The demo clock only exists to show how the coordinator behaves as days pass without waiting a week.

## Deploy on Render

1. Push this repo to GitHub.
2. In Render: **New > Blueprint**, pick the repo. `render.yaml` sets up the service.
3. Fill in the secret environment variables. `BASE_URL` is detected automatically from `RENDER_EXTERNAL_URL`.
4. Add the webhook in your PayPal sandbox app using the Render URL (see step 4 above).

On Render's free plan the filesystem isn't permanent, so circles reset when the service restarts or wakes from sleep. Each visitor gets their own circles, so judges never overwrite each other's demo.

## Project layout

```
server.js        HTTP server, routes, webhooks
circle.js        Circle rules: payments, payouts, reminders, swaps, guardrails, views per role
agent.js         AI coordinator: tools, instructions, rule-based fallback
ai.js            Gemini / Claude calls, tool-use loop, rotation planner
paypal.js        PayPal Orders, Payouts and Webhooks wrapper
store.js         Small JSON store for many circles
public/index.html  UI: landing, organizer view, member view
render.yaml      Render blueprint
```

## Limitations (it's a hackathon prototype)

- Sandbox only. A production version would need KYC, compliance review and a legal structure suited to each country. Contributions are collected into the app's PayPal business account and paid out from it; a production version would use PayPal's marketplace/partner features so money moves between members without the app holding it.
- Reminders appear on the member's page. They aren't sent by email or SMS yet.
- No user accounts: access is by private links. Data is stored in a JSON file.

## License

MIT. See [LICENSE](LICENSE).
