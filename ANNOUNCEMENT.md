# Hail for Vercel Chat SDK

The [original 0.1.0 launch announcement](https://github.com/hail-hq/chat-sdk-adapter/releases/tag/v0.1.0) remains the publication record. The current npm release is [0.1.1](https://www.npmjs.com/package/@hail-hq/chat-sdk-adapter/v/0.1.1); the setup links below point to its `v0.1.1` source tag.

[Hail](https://hail.so) gives AI agents a phone number, an inbox, and a voice. Hail supports text messages, email, and inbound and outbound phone calls.

Hail brings SMS to [Vercel Chat SDK](https://chat-sdk.dev). Your bot can receive signed SMS webhooks and reply from its Hail phone number with `thread.post()`.

```bash
npm install @hail-hq/chat-sdk-adapter chat @chat-adapter/state-memory
```

The adapter supports rotating credentials, separate conversations for each phone-number pair, and message history through a configured Chat SDK state adapter. Memory state works locally; use a shared state adapter for multiple instances or serverless deployments. Redis is one option, not a Hail requirement.

This release supports SMS. Hail's email and phone-call APIs are available directly; the adapter does not expose them yet. WhatsApp and iMessage are planned for Hail.

Requires Node.js 20+ and Chat SDK 4.44.0 or newer. Sending SMS requires a Hail number, workspace credit, and recipient consent. Carrier registration requirements apply.

- [Get started with Hail](https://hail.so)
- [Product documentation](https://hail.so/docs/webhooks#chat-sdk)
- [Published npm package](https://www.npmjs.com/package/@hail-hq/chat-sdk-adapter/v/0.1.1)
- [Source and setup guide](https://github.com/hail-hq/chat-sdk-adapter/tree/v0.1.1)
- [Next.js example](https://github.com/hail-hq/chat-sdk-adapter/tree/v0.1.1/examples/nextjs)

Hail maintains the adapter and handles support in this repository. The vendor-official Vercel listing is a separate submission and is not yet approved.

Validation: the 0.1.1 release workflow passed and npm provides a provenance attestation. The original 0.1.0 release passed 33 automated tests, type checks, package and example builds, a clean npm installation and import, and a real SMS exchange with handset confirmation. That handset test was not repeated for 0.1.1.
