# Relocation Vietnam dashboard — VPS migration workspace

This is the self-hosted migration package for the existing dashboard. It is not deployed and does not connect to production Supabase. It contains no live customer records, finance entries, password hashes, or secret configuration.

## Stack

- Static dashboard and same-origin Node.js API served together.
- PostgreSQL 16 on a private Docker network; finance records are stored in a separate table and every finance read/write checks the signed-in member's role and finance permission.
- Caddy handles HTTPS. Only ports 80 and 443 are published; PostgreSQL is not published to the host.
- Account invitations and password reset use SMTP configured in the VPS environment. Bootstrap creates the first owner; invited users choose their own password.

## Before deployment

1. Choose a dashboard hostname on a domain the business controls and verify DNS access. The hostname must resolve to the VPS before Caddy can issue a trusted HTTPS certificate. Use only a domain whose DNS you are authorized to manage; do not change an unverified or contested domain.
2. Have an approved sender address and SMTP credentials ready. Add them only to the server's private `.env`; never commit that file or send credentials in chat.
3. Confirm with the business owner that hosting customer and financial records in the selected VPS region is approved.
4. Confirm who will hold the first owner account. Existing passwords are not copied; team members will receive new invitations/reset links.
5. Verify Hostinger's automatic VPS backup schedule and at least one completed restore point. A temporary snapshot is not a recurring backup.

## Initial server setup

Prepare a private working directory on the VPS, place this package there, and create `.env` from `.env.example`. Generate the database password and one-time bootstrap token on the VPS with a password manager or `openssl rand -hex 32`. Set `APP_ORIGIN` to the exact HTTPS hostname. Do not use the example values.

The server firewall currently needs inbound TCP 80 and 443 in addition to the existing SSH rule. Keep port 22 open so SSH remains available. Do not expose PostgreSQL port 5432.

Start the services from the project directory:

```sh
docker compose up -d --build
docker compose ps
docker compose logs --tail=100 app proxy
```

After DNS and TLS work, visit `/setup.html` once and create the first owner with the one-time bootstrap token. Remove `BOOTSTRAP_TOKEN` from `.env` immediately after setup and restart the app. Configure SMTP and test invitation and password reset delivery before inviting the team.

## Data migration and cutover

1. Export `workspace_records` and `finance_records` from Supabase to a temporary private location. Do not put those exports in GitHub.
2. Keep credentials and Auth password hashes out of the export. The new accounts are created through the invitation flow.
3. First import only to a clean, isolated VPS database. `api/import-data.js` refuses to merge into non-empty tables and prints only import counts.
4. Compare source/target counts, check several records against their source, and test signed-out, intern, project-contributor, general-manager, and owner permissions (including denied finance reads/writes).
5. Test the VPS backup restore in an isolated environment. Keep Supabase and the existing public dashboard available until the business owner accepts the parallel pilot and the rollback plan is tested.

## Local checks

The source includes a same-origin API client smoke test and Safari compatibility checks. The broader manual workflow stress suite is run locally with a test-only fixture; that fixture is intentionally excluded from the production site package. The complete Docker stack still needs a build and end-to-end test on a staging server because Docker is not installed on the development PC.

No Gmail, WhatsApp, Zalo, Mailchimp, or carrier account is connected by this package. The dashboard continues to store messages and marketing results entered by the team; channel integrations are a later, separate implementation.