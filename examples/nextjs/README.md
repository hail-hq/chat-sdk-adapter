# Hail SMS echo bot

From the repository root, install and build the adapter:

```bash
pnpm install --frozen-lockfile
pnpm build
cp examples/nextjs/.env.example examples/nextjs/.env.local
```

Fill in the Hail credentials and number. Set `HAIL_RECIPIENT_CONSENT=true` only after confirming consent for recipients.
Run `pnpm --filter example-hail-chat-sdk dev` and expose port 3000 through your HTTPS tunnel.
Subscribe to `sms.received` at `https://your-tunnel.example/api/webhooks/hail`, then copy its signing secret into `.env.local`.
Send an SMS to the configured Hail number. The bot replies with `You said: …`.

This example selects Redis for shared Chat SDK state in production. `REDIS_URL` is used by that state adapter, not by Hail. The shared state coordinates deduplication, conversation locks, thread subscriptions, and cached history across bot instances. Development uses process-local memory when `REDIS_URL` is absent.

Before a production build of this example, set `REDIS_URL` and the Hail variables in the build and runtime environments. Run `pnpm --filter example-hail-chat-sdk build` followed by `pnpm --filter example-hail-chat-sdk start`.

To use another shared backend, replace the `state` implementation in `lib/bot.ts`; for example, Chat SDK provides a [PostgreSQL state adapter](https://chat-sdk.dev/adapters/official/postgres). Hail does not require a Redis service. Refer to the [adapter README](../../README.md) for Hail setup and current channel support.
