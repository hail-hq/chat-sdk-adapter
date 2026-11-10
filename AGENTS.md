# Hail Chat SDK adapter

This is the standalone source for `@hail-hq/chat-sdk-adapter`, maintained by Hail.
The root is the publishable npm package. `examples/nextjs` is a private workspace package.
The adapter uses Hail's public API; backend services live in `hail-hq/hail`.

## Commands

Use pnpm 9.15.0 and Node.js 20+ (CI uses Node.js 22).

```bash
pnpm install --frozen-lockfile
pnpm test
pnpm typecheck
pnpm build
pnpm format:check
pnpm --filter example-hail-chat-sdk typecheck
REDIS_URL=redis://localhost:6379 HAIL_FROM_NUMBER=+14155550100 pnpm --filter example-hail-chat-sdk build
npm pack --dry-run
```

Do not send real SMS or change production resources to validate changes without an explicit instruction.
Never commit credentials or `.env.local`. Keep the `.env.example` example current.
Preserve AGPL-3.0-only licensing unless the owner explicitly changes it.
Do not add automatic publication. Follow `RELEASING.md` for the release and Vercel listing gates.
The prepared `vercel-chat.patch` must pin the adapter README to a source commit, not a moving branch.

Keep API contracts and runtime behavior in sync with Hail's maintained public source and docs.
