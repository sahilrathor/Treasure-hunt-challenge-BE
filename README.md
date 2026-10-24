# College Fest Hunt Backend

Authoritative Node.js/Express API for the eight-checkpoint college fest QR treasure hunt. It owns
identity, QR validation, no-repeat game assignment, attempt timing, game-result validation,
progression, clues, pauses, ranking, audit history, and exports. PostgreSQL is the source of truth;
the project uses parameterized `pg` queries and no ORM.

## Requirements

- Node.js 22.12+
- npm 11+
- PostgreSQL 15+ with permission to create the `pgcrypto` and `citext` extensions

## Local setup

```bash
npm install
Copy-Item .env.example .env
docker compose up -d postgres
npm run db:migrate
npm run db:seed
npm run admin:create -- admin@example.edu StrongPassword123 "Event Admin"
npm run dev
```

On macOS/Linux use `cp .env.example .env`. The API defaults to `http://localhost:3000/api/v1`.
`GET /health` checks the process and `GET /ready` checks PostgreSQL connectivity under that base
path.

## Event setup order

1. Log in with the bootstrapped administrator.
2. Create an event.
3. Create 21–50 teams and add 3–5 individual participants to each.
4. Create eight checkpoints. The raw QR token is returned once; encode the returned `scanUrl` in
   the physical QR image.
5. Configure rounds 1–8, each with one checkpoint, clue, and difficulty.
6. Review the seeded eight games and their easy/medium/hard levels.
7. Start the event. Readiness checks reject invalid round, game, or team counts.

Participants start their team timer once, retrieve the first clue, scan the matching checkpoint,
and receive a stable randomized assignment. Refreshing or concurrent rescanning cannot reroll it.
Checkpoint QR tokens are stored only as hashes. Generating a replacement invalidates the prior QR,
and organizers may rotate tokens while the event is running or paused. Rotation immediately
invalidates the previous QR. Assignment retrieval and attempt creation are restricted to the
team's active round.

## Commands

```bash
npm run lint
npm run typecheck
npm test
npm run build
npm run format:check
```

Database-backed integration tests are opt-in to protect developer data. Point `DATABASE_URL` to a
disposable migrated test database and run with `RUN_DB_TESTS=true npm test`.

## Data integrity and security

- Opaque random sessions are stored only as SHA-256 hashes and delivered in HttpOnly cookies.
  Production cookies use `SameSite=None; Secure` for separately hosted HTTPS frontends.
- Passwords use Argon2id. Disabled users have active sessions revoked.
- Participant, admin, and ownership checks run on every private route.
- QR tokens are stored as hashes. Rotating a checkpoint token invalidates the old QR.
- Assignment creation and attempt completion lock authoritative progress rows in transactions.
- Unique constraints prevent repeated games, duplicate round assignments, and concurrent active
  attempts. Attempt ownership is also enforced by a database trigger.
- Server timestamps determine attempt and hunt duration. Client timestamps, durations, team IDs,
  and `passed` booleans are ignored.
- State-changing attempt starts/submissions require idempotency keys.
- Event pause intervals are organizer-controlled and serialized. Ranking subtracts only the overlap
  between approved pauses and a team's active hunt interval.
- Admin recovery is explicit and audited. Normal participant flows cannot delete attempt history.
- Logs redact authorization, cookies, passwords, and tokens.

## Game verification

Pattern Recall and Chess compare submissions with server-held solutions. Memory Match validates the
pair log against the issued board. Number Merge, Tetris, and Snake replay their bounded action
sequences. Brick Breaker and Space Invaders verify challenge binding and unique target-hit evidence.
Every game has an isolated validator registered under its stable game code.

The four browser-run arcade validators are pragmatic tamper resistance, not perfect anti-cheat. A
determined user controls the browser and can fabricate action evidence. For a higher-stakes event,
replace these validators with deterministic frame/input replay or supervised checkpoint devices.
This limitation does not affect authoritative assignment, retry, progression, or timing rules.

## API and reports

The API is versioned under `/api/v1`. See [openapi.yaml](./openapi.yaml) for the core contract.
Organizer endpoints provide event controls, team/member/checkpoint/round/game management, live
progress, paginated attempt reports, audit logs, CSV export, and assignment recovery. CSV reports
emit `NOT_PLAYED` rather than a fake zero duration.

## Deployment

To run the API and PostgreSQL together locally:

```bash
docker compose up --build -d
docker compose exec api npm run db:seed:prod
docker compose exec api npm run admin:create:prod -- admin@example.edu StrongPassword123 "Event Admin"
```

The Compose stack runs schema migrations when the API starts. Override `POSTGRES_DB`,
`POSTGRES_USER`, `POSTGRES_PASSWORD`, and `FRONTEND_ORIGIN` through the shell or a Compose `.env`
file when the defaults are unsuitable.

To run only the API image against an existing database:

```bash
docker build -t college-fest-hunt-backend .
docker run --rm --env-file .env -p 3000:3000 college-fest-hunt-backend
```

For a standalone container, `DATABASE_URL` must name a database host reachable from inside the
container; `localhost` points back to the API container. Run `npm run db:seed:prod` as a release
job before starting a new event.
The runtime container is non-root. Terminate HTTPS at the platform/load balancer, set the exact
`FRONTEND_ORIGIN`, use a managed PostgreSQL service with encrypted backups, and alert on readiness,
5xx rate, latency, connection saturation, and storage growth.

Before the event, test concurrent scans/submissions against production-like PostgreSQL, verify all
physical QRs, rehearse pause/recovery procedures, test current Android/iOS browsers, export a sample
report, and freeze configuration.
