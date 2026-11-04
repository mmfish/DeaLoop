# config/

## `firebase.json` — public Firebase web configuration (intentionally committed)

The `apiKey` in [`firebase.json`](./firebase.json) is a **Firebase Web API key**
(`AIza…`). Despite the name, it is **not a secret**: it is a public project
identifier that Firebase ships to every browser running the app (see
`app/login/sign-in-form.tsx`, which passes this file to `initializeApp()`).
GitHub secret scanning flags `AIza…` strings, so this file may trigger a
"Google API key" alert — that alert is a **false positive** for this file.

Do NOT "fix" the alert by deleting the key or moving it to `.env`: the same
value is embedded in the client bundle at build time, and removing it here
only breaks sign-in.

What actually protects this project (instead of hiding the key):

- **API restrictions** (Google Cloud Console → APIs & Services → Credentials):
  restrict this key to the Identity Toolkit / Token Service APIs the app uses.
- **Application restrictions**: restrict HTTP referrers to the deployed
  DeaLoop origin(s), plus `localhost` only if needed for development.
- **Firebase authorized domains** (Firebase Console → Authentication →
  Settings): only the deployed hostname(s) may complete sign-in.
- **Backend verification**: ID tokens are verified server-side in
  `backend/auth.ts` (`verifyFirebaseToken`, issuer/audience/`auth_time`
  checks); the key alone grants no account or data access.
- **Usage monitoring**: watch Identity Toolkit traffic for unexpected spikes.

Rotate the key in Firebase Console only if its restrictions were misconfigured
or abuse is observed — not merely because it appears in the repo.
