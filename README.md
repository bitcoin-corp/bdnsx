# bDNSX lease service (v1)

**Licence: [Open BSV License version 4](LICENSE)**, © The Bitcoin Corporation Ltd. (GitHub labels it "Other" because it is not on GitHub's standard licence list.)

Rent OpNS names that the vault holds, by the year. Each lease is a public record on chain
(B + MAP `app=bdnsx` + AIP signed by the vault key). A resolver answers "who is this name pointing at right now".

Record formats and test vectors: [`spec/RECORDS.md`](spec/RECORDS.md), [`spec/vectors.json`](spec/vectors.json).

## Run locally

```bash
pnpm install
pnpm test          # vitest, offline
cp .env.example .env.local   # fill in public values; leave BDNSX_VAULT_WIF empty unless signing
set -a; . ./.env.local; set +a
pnpm dev           # builds and starts on :8787, dry-run
```

Without `BDNSX_VAULT_WIF` the server still resolves and quotes; lease requests return `503 no_vault_key`.
With it set and `BDNSX_BROADCAST` unset, records are signed but **not** broadcast (dry-run ids are
`sha256(record script)`).

## Environment

| Var | Needed | Purpose |
|---|---|---|
| `BDNSX_VAULT_WIF` | to sign | Vault signing key. Read only when a record is signed, never stored |
| `BDNSX_VAULT_PUBKEY` | yes | Vault identity key (public). Must match the WIF |
| `BDNSX_PAY_TO` | yes | Store address rent is paid to |
| `BDNSX_OWNER_PUBKEY` | for revoke | Key whose signature authorises a revocation |
| `BDNSX_BROADCAST` | no | `1` = fund and broadcast via WhatsOnChain. Default dry-run |
| `BDNSX_FUNDING_WIF` | no | Separate fee key; default is the vault key (UTXOs < 1000 sats skipped) |
| `BDNSX_NETWORK` | no | `main` (default) or `test` |
| `BDNSX_VAULT_NAMES_FILE` | yes in practice | Newline list of names the vault holds |
| `BDNSX_NOT_FOR_LEASE_FILE` | no | Brands / KEEP names never leased |
| `BDNSX_CACHE_FILE` | no | JSON cache file; empty = memory only |
| `BDNSX_PRICING_FILE` | no | Override `config/pricing.json` |
| `BDNSX_OWNED_NAMES_COUNT` | no | Sold names counted toward adoption |
| `BDNSX_MIN_CONFIRMATIONS` | no | Confirmations required on payment (default 0) |
| `PORT` | no | Default 8787 |

## Endpoints

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/health` | | `{ok, broadcast}` |
| GET | `/api/resolve/:name` | | `{name, holder: 'owner'\|'renter', key, until, status, site?}` or 404 |
| GET | `/api/leases/:name` | | Lease status + every record published for it |
| POST | `/api/lease/quote` | `{name, years, renterKey?}` | Price in USD and sats, `payTo`. With the current renter's key, a capped renewal quote |
| POST | `/api/lease` | `{name, years, paymentTxid, renterKey, signature}` | 201 lease record. `signature` = BSM over `bdnsx:lease:<name>:<years>:<paymentTxid>` |
| POST | `/api/lease/renew` | same shape, message `bdnsx:renew:...` | Extended lease (from current expiry) |
| POST | `/api/lease/transfer` | `{name, toKey, fromSig, toSig}` | Two-party handover (see spec) |
| POST | `/api/admin/revoke` | `{name, reason, ownerSig}` | Owner-signed revocation, published |
| POST | `/api/link` | `{domain, key, name?, site?}` | Checks TXT `_bdnsx.<domain>`, publishes a link record |

Errors are `{error, message}` with 400/401/402/403/404/409/413/415/422/503. No rate limiting (by request); inputs are validated
and bodies are capped at 16 KB. The payment txid is the nonce, so each signature/payment works once.

## Rules implemented

- Only names in the vault list, not on the not-for-lease list, and not under a live lease can be leased.
- Payment: outputs to `BDNSX_PAY_TO` in the payment tx must cover the quote (3% tolerance for rate drift). Each payment txid is used once.
- Renew: renter only, extends from the current expiry, allowed during the 30-day grace period. After grace the lease has lapsed; anyone may lease the name again.
- Resolver: renter during the lease and grace, owner (vault) otherwise.
- Transfer: active leases only (not in grace); needs the current and new renter's signatures; keeps the expiry and price.
- Revoke: owner signature required; the revoke record is published.

## Pricing (`config/pricing.json`)

- Buy: 1–2 chars $500, 3 chars $100, 4 chars $50, 5+ chars $10. Lease: 15% of buy per year.
- Adoption multiplier, on active leases + `BDNSX_OWNED_NAMES_COUNT`:

  | adoption ≥ | 0 | 250 | 1,000 | 2,500 | 5,000 | 10,000 |
  |---|---|---|---|---|---|---|
  | multiplier | 1.0 | 1.1 | 1.25 | 1.5 | 2.0 | 3.0 |

  The highest multiplier ever applied is kept (high-water mark), so prices never drop automatically.
  The config is validated: steps must rise and multipliers must never decrease.
- Renewal cap: a renter's annual price can rise at most 25% per year over their last price (`renewalCapPctPerYear`).
- `prepayFreeYears` (e.g. `{"3": 1}` = 3 years for the price of 2) is off by default.
- USD → sats at the WhatsOnChain BSV/USD rate, rounded up.

## Not built (v1)

- **v2 time-lock leases** (ordinal in a script the renter controls until expiry).
- **Wallet UI**: Rent button, My rentals, reminders in bWalletX (separate session).
- **.com link** beyond a DNS TXT signature check: no periodic recheck, no b0-x serving, no brand-at-cost flow.
- **Postgres store**: the migration is written (`migrations/001_bdnsx_leases.sql`, not run); the service uses the JSON/memory store.
- **Chain indexer**: the cache is not rebuilt from on-chain records yet.
- **Live vault holdings check**: names come from `BDNSX_VAULT_NAMES_FILE`, not a live ordinals lookup.
- **Live broadcast** has not been exercised; it is off unless `BDNSX_BROADCAST=1`.
- Reminders, rent-to-own, lease marketplace.
