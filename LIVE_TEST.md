# Live SMS end-to-end test

Run this test with an SMS-capable Hail number and a phone you control. It uses Hail's real API and webhook worker, sends one chargeable reply through the adapter, and verifies carrier delivery. It is separate from the regular test suite and never runs automatically in CI.

## Prepare

1. Obtain consent from the test phone's owner. Choose an active Hail number with no text agent assigned. If an existing number has a text agent, obtain explicit authorization before temporarily clearing only its `sms_agent_id`; record the original agent ID and restore it afterward. The runner refuses to use an assigned number and never changes routing itself.
2. Authenticate the Hail CLI with `hail login`, or provide `HAIL_API_KEY` through a private environment file. The runner reads the CLI's existing credential file when no environment key is set. It never prints the key.
3. Install dependencies and build: `pnpm install --frozen-lockfile`, then `pnpm build`.
4. Start a tunnel forwarding to port 8787. With an authenticated ngrok installation:

   ```bash
   ngrok http http://127.0.0.1:8787 --inspect=false
   ```

5. Copy `scripts/live-sms.env.example` to `.env.live` and fill in the Hail number, the approved peer number, and the HTTPS tunnel origin. Protect the file with `chmod 600 .env.live`. The `.env.live` file is ignored by Git. Use Node.js 22 for the runner.

The Hail workspace must have credit. Carrier restrictions still apply, including US registration where required. The sender and peer must be different numbers. No phone numbers are purchased by this test.

## Run

```bash
node --env-file=.env.live scripts/live-sms-e2e.mjs
```

The runner checks number ownership, active SMS capability, and absence of a text agent. It starts a loopback-only webhook receiver and creates a temporary Hail subscription for SMS events. The subscription's secret stays in memory. It verifies that the public endpoint rejects an unsigned request before printing `READY`.

After `READY`, send exactly the displayed `HAIL-E2E <nonce>` challenge from the approved phone to the Hail number. The expected handset reply is `HAIL-E2E OK <nonce>`.

Only that peer and exact challenge can trigger a send. The probe permits at most one reply per process, including when the send fails or the challenge is sent twice. Other incoming messages receive no reply. It does not retry outbound sends.

## Result and cleanup

A passing JSON report confirms:

- A real inbound API record matches the approved peer, Hail number, and challenge.
- The adapter handled a signed webhook, and Hail recorded a successful HTTP 200 delivery.
- The outbound API record matches the expected reply and reached `delivered` status.
- An unsigned webhook was rejected, and the temporary subscription was removed.

The report contains message/subscription IDs and only the last four digits of each number. It excludes API keys, signing secrets, and original webhook payloads. Its default location is the OS temporary directory; `HAIL_E2E_REPORT` can override it.

The runner waits up to 10 minutes for the challenge and 2 minutes for carrier delivery. A `sent` status alone does not pass. A timeout, failure, or interruption returns a nonzero exit code. Confirm the reply on the handset as well; the carrier receipt is a separate observation.

The runner removes its temporary subscription in `finally`, including after Ctrl+C. If `webhookRemoved` is false, use the reported subscription ID to remove it from Hail before ending the session. An OS crash or forced kill can prevent cleanup. The callback URL contains the unique test nonce so the test subscription can be identified if creation succeeded but its response was lost.

Stop only the tunnel started for this test. Restore any separately authorized temporary SMS-agent detachment and confirm that the number's voice routing is unchanged. Do not publish live credentials or phone numbers in a test report or pull request.
