# PrePlot recovery Worker

Private, optional recovery storage for PrePlot. The PWA always saves locally first;
this Worker only accepts authenticated portable recovery copies after local persistence.

The public repository contains no credentials. Device tokens are issued from one-use
enrollment records and stored only in the browser that redeemed them. Recovery objects
live in the private `preplot-recovery` R2 bucket; the Worker is the only public path.

## Deployment

1. Authenticate Wrangler and create the private bucket:
   `npx wrangler@latest r2 bucket create preplot-recovery`
2. From this directory, validate with `npx wrangler@latest deploy --dry-run`.
3. Deploy with `npx wrangler@latest deploy`.
4. Replace the placeholder Worker URL in `../recovery.js` with the deployed URL.
5. Add a 90-day R2 lifecycle rule scoped to the `teams/` prefix. Drive packages remain
   the permanent job record; device credentials and unused enrollment records must not
   inherit the recovery-copy expiration.

## Issue one installation code

Generate the code and its private record locally, then upload only the record:

```sh
node scripts/create-enrollment.mjs --team preplot-team --output /tmp/preplot-enrollment.json
npx wrangler@latest r2 object put preplot-recovery/enrollments/<HASH>.json --remote --file /tmp/preplot-enrollment.json --content-type application/json
```

The command prints the one-use code and exact R2 object key. Send the code to the
surveyor privately. It expires after seven days and cannot be redeemed twice.

Deleting `devices/<sha256-token>.json` revokes an installation. Tokens and enrollment
codes must never be committed, pasted into app source, or stored in survey exports.
