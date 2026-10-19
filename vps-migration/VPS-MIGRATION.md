# VPS migration foundation

This branch contains a self-hosted application and backend package for review. It has not been deployed, and it does not change the current GitHub Pages site or Supabase project.

## Prepared

- Same-origin dashboard API with PostgreSQL storage, session authentication, invitations, password reset, audit events, and manager-controlled team/finance access.
- Separate finance table with server-side permission checks; database is internal to the Docker network.
- Caddy HTTPS reverse proxy and a first-import-only data loader.
- Production site source with fictional seed data removed; test-only walkthrough remains local and is not included in the site.

## Still required before production data moves

- A business-controlled hostname and DNS pointed to the VPS.
- An approved SMTP sender for invitations and password reset.
- Owner confirmation of hosting location and the data transfer.
- Verified scheduled VPS backups and a successful isolated restore rehearsal.
- A Docker deployment, invitation/role test matrix, record-count comparison, and parallel pilot.

See `dashboard-demo/vps-migration/README.md` in the workspace package for setup details. Supabase and the existing dashboard stay available for rollback until the owner accepts the VPS pilot.