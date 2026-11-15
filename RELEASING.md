# Release and submit the Hail adapter

The adapter is prepared as `@hail-hq/chat-sdk-adapter@0.1.0`. This document is a release checklist, not a publication record.

## Validate the artifact

From this directory:

```bash
pnpm install --frozen-lockfile
pnpm test
pnpm typecheck
pnpm build
pnpm --filter example-hail-chat-sdk typecheck
# Build-only placeholders; this does not start Redis or send SMS.
REDIS_URL=redis://localhost:6379 HAIL_FROM_NUMBER=+14155550100 pnpm --filter example-hail-chat-sdk build
npm pack --dry-run
```

Chat SDK is MIT-licensed and compatible with the adapter's AGPL-3.0-only license.
The package contains its ESM build, TypeScript declarations, README, and license.
Before publication, run the [live SMS test](LIVE_TEST.md) using an authorized test number and credits.
The automated tests use the real Chat runtime and a fake Hail HTTP transport; they do not establish carrier delivery.

## Publish the package

Releases publish from GitHub Actions with npm trusted publishing. There is no npm token in the repository or in GitHub secrets. npm adds a provenance attestation to each release.

One-time setup, by an npm account that can publish under `@hail-hq`:

```bash
npx -y npm@latest trust github @hail-hq/chat-sdk-adapter \
  --file release.yml \
  --repo hail-hq/chat-sdk-adapter \
  --env npm \
  --allow-publish
```

npm asks for two-factor confirmation in the browser. A new trusted publisher must publish once within 2 days, so run this shortly before the first tag.

For each release:

1. Set `version` in `package.json` in a pull request, and merge it after CI passes.
2. Tag the merged commit on `main` and push the tag:

   ```bash
   git fetch origin
   git tag v0.1.1 origin/main
   git push origin v0.1.1
   ```

3. The `Release` workflow (`.github/workflows/release.yml`) has two jobs:
   - `build` checks that the tag matches `package.json` and points to a commit on `main`. It installs without dependency lifecycle scripts, runs the same checks as CI, and packs the tarball. It cannot publish.
   - `publish` runs in the `npm` environment, which allows only `v*` tags and waits for a required reviewer to approve the run in GitHub Actions. Then it publishes that tarball. A version with a `-` suffix (for example `0.2.0-rc.1`) is published under the `next` dist-tag, not `latest`.
4. Confirm `npm view @hail-hq/chat-sdk-adapter@<version> version repository dist.integrity dist.attestations` shows the repository and a provenance attestation, and install the published artifact into a clean app.
5. Confirm the Hail product documentation at `https://hail.so/docs/webhooks#chat-sdk` is live. Publish the reviewed announcement from `ANNOUNCEMENT.md` and save its public URL.

Do not publish from a local machine. A local publish has no provenance.

If the `build` job fails, fix it in a new pull request with a new version, and push a new tag. If the `publish` job fails with an authentication error, check the trusted publisher with `npx -y npm@latest trust list @hail-hq/chat-sdk-adapter`, fix it, then re-run the failed `publish` job.

## Submit the Vercel listing

Use the prepared `vercel-chat.patch` against the Vercel source revision recorded in the patch.
Check current upstream requirements before applying it. The patch adds the MDX page, catalog entry, CLI scaffold, and changeset.
Current docs tests derive allowed packages and adapter pages from the catalog, so there are no static allowlists to extend.

Follow [Vercel's vendor-official requirements](https://chat-sdk.dev/docs/contributing/vendor-official):

- The npm package must already be published.
- The public Hail docs must cover the adapter, and the announcement must be public.
- Hail must commit to maintenance and developer support.
- The source must remain in Hail's official GitHub organization.
- The APIs must be public, not closed beta.
- The listing README URL must stay pinned to the reviewed source revision.

Run the upstream catalog, CLI, and integration checks before opening a listing PR against `vercel/chat`.
Include the published package, pinned source, product docs, and announcement links.
Vercel requires verified signed commits and DCO sign-off. Verify commit signing before submission.
The listing does not grant Vercel Connect registration or Vercel maintenance.

## Maintenance

Keep the package, README, Hail docs, Vercel catalog, and scaffold configuration in sync when the adapter changes.
Test against new Chat SDK releases. Handle adapter bug reports in this repository.
