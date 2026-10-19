# VPS migration plan

Status: preparation only. The production dashboard remains on GitHub Pages + Supabase. No production records or credentials have been moved.

## Target architecture

- Caddy terminates HTTPS and serves the dashboard from the application container.
- A private PostgreSQL container stores team accounts, operational records, financial records, sessions, invitations, password-reset tokens, and metadata-only audit events.
- A same-origin application API owns authentication, membership checks, invitations, password reset/change, operational CRUD, and finance access checks.
- The PostgreSQL port stays on the Docker private network; only HTTPS is public. SSH remains limited to administration.
- Persistent database storage uses a named volume. Off-host encrypted backups and tested restores must be configured before production cutover.

The static client currently calls Supabase Auth, PostgREST, and the `invite-team-member` Edge Function. These interfaces must be replaced or safely adapted; removing Supabase configuration alone is not a migration.

## Data mapping

| Current Supabase object | VPS target |
| --- | --- |
| `auth.users` | local account table with password hashes; do not import Supabase password hashes |
| `team_members` | member table with role, active state, and finance-access flag |
| `workspace_records` | operational records, preserving record type, key, customer key, JSON payload, and timestamps |
| `finance_records` | separate finance table with the same keys/payloads and server-enforced finance permission |
| `audit_events` | metadata-only audit log; never copy message content, customer payloads, or money values |
| `invite-team-member` | authenticated owner/general-manager API endpoint plus one-use, expiring invitation token and email delivery |

Customer records and financial records remain in Supabase during development and rehearsal. Passwords are reset/re-invited; password hashes are not migrated.

## Safe delivery gates

1. Add the self-hosted API and schema in a review branch; keep the existing Pages workflow unchanged.
2. Test sign-in, sign-out, session expiry, password change/reset, invitation acceptance, role checks, finance denial, and operational/finance CRUD with automated tests.
3. Export a current Supabase snapshot using the existing approved backup process; import only into an isolated VPS test database.
4. Compare record counts and keys, then test allowed and denied operations for signed-out users, interns, project contributors, general managers, and owners.
5. Verify HTTPS, secure cookies, CSRF protection, login throttling, secret handling, and database network isolation.
6. Configure and test off-site encrypted backups and a restore to a separate database.
7. Run a parallel pilot and obtain Stephanie's acceptance before changing any live URL or moving live writes.
8. Keep Supabase and its verified backups untouched until the VPS has passed the parallel pilot and a rollback rehearsal.

## Current blockers and limits

- The GitHub Pages repository stores the site ZIP and deploy workflow, not the editable source tree. The current source copy is in the private project workspace and must be deliberately brought into this branch.
- The disputed `relocationvietnam.com` domain is not available for VPS DNS changes. A verified domain and TLS certificate are required before any public login with real data.
- SMTP delivery details are not yet confirmed; invitations and password reset cannot be considered complete until delivery is tested.
- The Hostinger snapshot is a temporary rollback point, not a recurring backup. Daily backups and off-site encrypted exports must be verified separately.
- Hostinger deployment must use a new project name and must not replace any existing project or overwrite the snapshot. Any VPS write will be performed only after a concrete compose configuration and target are reviewed.
