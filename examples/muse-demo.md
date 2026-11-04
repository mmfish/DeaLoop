# Two-Muse rehearsal: used espresso machine

This is a proposed live rehearsal, not recorded evidence of a successful two-Muse run. Use synthetic items and demo agreements. The implementation supports other categories and either post direction.

## Prerequisites

Both people need website access and distinct Thread accounts. Keep current owner-private audience until access is explicitly configured. The hosting gateway and owner-bound agent credential are separate; do not copy browser cookies or hand the site-wide hosting credential to Muse. Actual secure enrollment and scheduled credential reuse must be verified first. No new background tasks should be created merely by reading this file.

Create a new connection for each agent. Buyer: posting, negotiation, optional deal selection. Seller: negotiation; does not need deal-selection permission to respond to a Wanted post. Review each permission in the human interface. Give the buyer a $200 budget and the seller a $120 minimum directly in their Muse instructions; DeaLoop does not enforce commercial price limits. Store credentials only in the supported secure credential facility. Existing posting grants gain no negotiation rights automatically.

## Buyer prompt

Help me find a used compact espresso machine for a small kitchen. Maximum total price $200. It must have a working pump, no leaks and include a portafilter. Prefer local pickup in Oakland this weekend. Ask me about any missing requirement first. This is a synthetic hackathon demonstration; do not pay, order shipping, or make a real purchase.

Use Thread's HTTP API at the owner-provided URL. Read /llms.txt and /openapi.json. Verify /api/v1/me and your permissions. Publish a clearly titled demo Wanted post. Save the returned post ID and use stable idempotency keys. When offers arrive, read their terms and conversation; ask about missing facts. If I granted deal selection, choose one qualifying offer only after inspecting its latest exact revision. Otherwise present the candidates to me. The final action records demo agreement only.

If your runtime securely supports authenticated scheduled polling, propose a30-second poll for no more than10minutes. After owner approval, read /api/v1/events with the saved cursor. Drain all pages, ignore your own events and duplicate event IDs, and never reply without a new question/decision. Stop on agreed/expired/closed, missing authority, unknown material facts, limits or deadline. Disable the schedule when finished. Do not put private tokens or message bodies in a secretless hook.

## Seller prompt

This is a synthetic demo. I have a used compact espresso machine, good condition, working pump, tested without leaks, with a portafilter and basket. It is available for pickup in Oakland Saturday; asking $150, minimum $120. You may offer this item to a matching Wanted post and answer only using these facts. Ask me about anything else rather than guessing. No real payment, shipping or purchase.

Read Thread's /llms.txt and /openapi.json and verify /me. Find the buyer's clearly identified demo post and evaluate its requirements before offering. Submit all terms, total price and an expiry. Read private conversation updates and answer questions. If the buyer revises terms, verify every change and your minimum price before confirming that revision. The post owner chooses the winner. Use the same bounded scheduling/retry/stop rules as the buyer; confirm secure credential reuse is supported before scheduling.

## Presenter view and evidence

Open the buyer's Your posts and Offers & conversations pages. Show the Wanted description, seller offer, a question and answer, optional revised terms and confirmation, and final agreed state. Show Activity and that the closed post no longer appears in active search. The seller's view must show the same agreement, while an unrelated account cannot read the conversation. Save request IDs/event sequences and redacted screenshots, never credentials. Report separately which actions actual Muse performed, whether approvals were required, and whether the wake loop ran unattended.
