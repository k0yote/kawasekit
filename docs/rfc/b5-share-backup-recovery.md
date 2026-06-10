# RFC B5 — Key-Share Backup / Recovery (mpc-2p)

| | |
|---|---|
| **RFC** | B5 (M6-3 key-share lifecycle) |
| **Title** | Encrypted key-share backup, export/import, and a recovery ceremony for the mpc-2p 2-of-2 co-signer |
| **Status** | Draft v2 — `web3-cto-review` pass 1 done, **all findings closed** (0🔴 / 2🟠 H1–H2 / 4🟡 M1–M4 / 3🟢 L1–L3). Review record: `docs/rfc/b5-share-backup-recovery-review-pass1.md`. |
| **Author** | k0yote |
| **Reviewers (invited)** | `web3-cto-review` skill (mandatory pass before implementation) |
| **Milestone** | M6-3 key-share lifecycle (M6-1 RFC §9); Track B of `docs/STATUS.md` |
| **Satisfies** | RFC M6-1 `docs/rfc/mpc-2p-cosigner.md` §4.10 ("B5 — a hard requirement"), threat **T9** (single share lost ⇒ permanent fund lock), and open question §10 Q2 (recoverability vs. non-custody) |
| **Implements in** | `kawasekit-mpc-2p` (private): `crypto-core` + a backend CLI + `agent-wasm`/`agent-ts` glue. The public kawasekit SDK is **unchanged** — no new public surface. |
| **Created** | 2026-06-10 |

> **Ship is testnet; the code is mainnet-grade.** Every mechanism here lands implemented
> AND tested (positive + negative), with no testnet shortcut in secret handling or error
> paths. The one thing this RFC does not (and cannot) change: the third-party crypto
> audit (T2) remains the sole mainnet/real-value gate.

---

## 1. Summary (TL;DR)

2-of-2 means **either share lost ⇒ funds permanently locked** — there is no
counterparty-assisted recovery path, *by design* (that absence is exactly the
non-custodial property). So each party MUST be able to back up **its own share** and
recover it after loss, **without** the backup mechanism ever weakening the 2-of-2 split.

This RFC specifies a single, versioned, authenticated-encrypted **backup blob format**
(one Rust implementation in `crypto-core`, compiled native for the owner backend and to
wasm32 for the agent), strictly **per-party** export/import (no combined container, no
escrow, no network endpoint), an **AAD-bound header** (role, party index, group EOA,
share id, epoch) so a blob cannot be confused, swapped, or rolled back silently, and a
documented **recovery ceremony** with a post-recovery liveness check. Proactive share
refresh (ePrint 2019/1328) is **designed for** (the epoch field) but its implementation
is staged as a follow-on (B5.2) — see §9. Until B5.2 ships there is **no rotation**: a
stolen blob + secret remains a stolen share until the key is retired — v1's mitigations
are the custody rules, revoke, and the 2-of-2 split itself (§5 B-T2).

The non-custodial invariant survives untouched: a backup blob contains exactly **one**
share; a recovered share alone still cannot sign (the §6 kill-one negative control is
re-asserted against a *recovered* share).

---

## 2. Problem statement

### 2.1 What exists today (evidence)

`kawasekit-mpc-2p/src/share_store.rs` provides persistence only:

- `ShareStore` trait — `save`/`load` of opaque share bytes by id (`share_store.rs:24`).
- `FileShareStore` — plaintext on disk, testnet only (`share_store.rs:56`).
- `EncryptedShareStore` — XChaCha20-Poly1305 at-rest decorator under a 32-byte KEK;
  blob = `nonce(24) || ciphertext(+tag)`; decrypted shares come back `Zeroizing`
  (`share_store.rs:95-144`). KEK custody is the operator's (module docs, `:7-9`).

There is **no export, no import, no recovery, no backup format, no runbook**. A disk
loss, a host loss, or (Track D) a Railway redeploy without a persistent volume destroys
the share — and with it, irrevocably, every fund behind the group EOA.

### 2.2 Why at-rest persistence is not backup

At-rest encryption defends a blob that **stays on the host**. Backup is a different
artifact with a different threat model: it deliberately **leaves the trust boundary**
(cold storage, another machine, an operator's safe), it must remain importable across
host rebuilds and store-backend changes, it must be **bound to its identity** (whose
share, which wallet, which epoch) because at import time there is no surrounding context
to disambiguate it, and it interacts with future share refresh (a stale backup must fail
*loud*, not sign *wrong*). None of that is provided by `EncryptedShareStore`.

### 2.3 The tension this RFC resolves (M6-1 §10 Q2)

"The agent genuinely holds a share" (non-custody) and "the share is recoverable"
(availability) pull in opposite directions: every recovery affordance is a new theft
surface, and any *shared* recovery affordance (escrow, cloud copy held by the other
party) quietly reconstitutes custody. Resolution: **recoverability is strictly
per-party.** Each party backs up its own share, holds its own backup secret, and
recovers alone. Nothing in this design lets one party (or kawasekit) recover — or even
hold sealed material for — the other party's share.

---

## 3. Design constraints (non-negotiable)

1. **Non-custody is sacred.** A backup blob contains exactly **one** share. There is no
   multi-share container, no escrow role, no "kawasekit holds a copy" mode, and no
   cross-party custody of blobs (not even sealed — see B-T2/§5). The M6-1 invariant
   (share + policy, never funds; negative control only) is preserved verbatim.
2. **No share ever crosses the wire.** Export and import are **local-only** (library
   call / CLI on the host that owns the share). There is NO network endpoint, NO
   `CoSignFrame` message, and NO admin API that emits or accepts share material. The
   wire protocol (`wire.rs`) is unchanged.
3. **One implementation, two builds.** The format and the seal/open code live once in
   `crypto-core` (Rust), compiled native (owner) and wasm32 (agent). No TS
   re-implementation of the cryptography — drift between two sealers is how backups
   silently die (same single-source-of-truth discipline as A4/B8).
4. **Deny-closed and fail-loud.** Any tag failure, header mismatch, version unknown,
   role/EOA/epoch conflict, or deserialization anomaly ⇒ typed error, no partial
   import, nothing written. A recovered share is verified (recomputed group EOA ==
   header) **before** it is persisted.
5. **Secrets hygiene as everywhere else in this repo.** Plaintext share bytes exist
   only inside `Zeroizing` buffers; backup secrets are never logged (logger rules);
   bounded deserialization on import (the self-audit M2 `MAX_FRAME_BYTES` discipline
   applies to the backup payload too).
6. **Scope guard.** Single-instance topology (locked decision); SQLite ledger backups
   are Track-D ops, not B5; the public SDK surface is unchanged; no new chain or
   protocol behavior.

---

## 4. Design

### 4.1 Components and who backs up what

| Party | Live share location | Backup actor | Backup artifact |
|---|---|---|---|
| **Owner backend** | `ShareStore` (file/encrypted) on the backend host | Backend operator, via a local CLI (`share-backup` bin) | sealed blob (file) + a 32-byte **backup secret** held by the operator |
| **Agent** | host-held share hex, fed to the WASM `CoSignSigner` per ceremony | Agent host owner, via wasm-bindgen exports (surfaced in `agent-ts`) | sealed blob (bytes/file) + a 32-byte **backup secret** held by the agent owner |

Both paths call the same two `crypto-core` functions:

```
seal_share_backup(share_bytes, backup_secret, header) -> Vec<u8>      // export
open_share_backup(blob, backup_secret, expected: ExpectedIdentity)
    -> (Zeroizing<Vec<u8>>, BackupHeader)                             // recover
```

`share_bytes` is the canonical `KeyShare::to_bytes` serialization — the *same* bytes
`ShareStore` persists and the agent holds as hex — so one payload format covers both
parties and every store backend.

### 4.2 Backup blob format v1

```
magic(16) = "KWSK-MPC2P-BKP\0\0"
│ version (u8) = 1
│ header_len (u32 LE)
│ header (serde_json, verbatim bytes)
│ nonce (24)                          ── XChaCha20-Poly1305
│ ciphertext + tag (16)
```

**Header** (stored verbatim; those exact bytes — prefixed by `magic ‖ version` — are
the AEAD **AAD**, so any tamper breaks the tag):

```jsonc
{
  "role": "owner" | "agent",      // which side of the 2-of-2
  "party_index": 0 | 1,           // the DKLs party index of this share
  "group_eoa": "0x…",             // EIP-55; the joint address this share belongs to
  "share_id": "…",                // the ShareStore id / agent share label
  "epoch": 0,                     // share-refresh epoch; v1 always 0 (§4.5)
  "kdf_salt": "hex…",             // 16-byte random salt for HKDF (per blob)
  "created_at": 1760000000        // unix seconds, ops metadata only
}
```

**Sealing key.** The operator supplies a **32-byte backup secret** (generated by the
tool: `share-backup keygen` → hex; raw key, NOT a passphrase — see §7 R1). The actual
AEAD key is derived per blob:

```
sealing_key = HKDF-SHA256(ikm = backup_secret,
                          salt = kdf_salt,
                          info = "kawasekit/mpc-2p/share-backup/v1/" || role)
```

This buys: (a) **domain separation** from the at-rest KEK even if an operator wrongly
reuses bytes, (b) per-blob keys under one secret, (c) role separation (an owner-sealed
blob cannot be opened "as" an agent blob even with the same secret). New **direct
dependencies of `crypto-core`** (the wasm-compiled crate — none of these are direct deps
there today; verified against `crypto-core/Cargo.toml`, M1): `chacha20poly1305`
(currently backend-only), `hkdf`, `sha2`, `serde_json` (header), and `getrandom`
(salt/nonce sampling — the same crate+version the agent's signing path already uses) —
all wasm32-safe; the RustCrypto three are audited lineage, `serde_json` is already
trusted in the backend. Flagged per repo dependency policy.

**Cipher.** XChaCha20-Poly1305 with a fresh random 24-byte nonce — the same primitive
as `EncryptedShareStore` (no new cipher *primitive*, though the crate moves into the
wasm build — see the dependency note above). Nonce/salt sampling calls `getrandom`
directly (no OsRng indirection; `chacha20poly1305` runs default-features-off so its own
getrandom-0.2 feature never enters the wasm build); on wasm32 it rides the
already-pinned `wasm_js` backend (`.cargo/config.toml`, verified) and is
**security-load-bearing** (the M6-1 T12 discipline: a broken host RNG ⇒ nonce reuse
under a long-lived backup secret). The backup secret MUST be distinct from the
at-rest KEK (documented requirement; HKDF context bounds the damage if not).

The `role`↔`party_index` assignment is fixed at DKG provisioning time and recorded in
the operator's out-of-band export record (§4.3) — import verifies the header against
that record, not against itself (L1: the header is data, not authority).

### 4.3 Export (seal)

- **Owner:** `share-backup export --share-id <id> --out <file>` (new backend bin). The
  CLI constructs its store from its own config — the existing bins/tests pattern;
  `service.rs` does not wire a `ShareStore` (M3) — including `EncryptedShareStore`
  (export re-seals the *plaintext* share under the *backup* key; it does not copy the
  at-rest blob, which would chain recoverability to the KEK). It builds the header
  (role=owner, recomputed `group_eoa` from the share, epoch = constant 0 in v1, §4.5),
  seals, and writes the file **atomically with `0600` permissions** (tmp + fsync +
  rename — L2; note `FileShareStore::save` at `share_store.rs:71` is a pre-existing
  non-atomic write to align while in the area). Prints the blob path, the **group
  EOA**, the **blob fingerprint** (SHA-256), and the share's `role`/`party_index`; the
  runbook mandates recording these **out-of-band** — that record is what import
  verifies against (M2/L1). Never prints secrets.
- **Agent:** `sealShareBackup(shareHex, backupSecretHex, {shareId})` exported from
  `agent-wasm` and surfaced as a helper in `agent-ts`. Same header/format, role=agent.
- **Inventory:** `share-backup list` enumerates the store's share ids + group EOAs
  (M4). A backend holds one share per wallet/session (multi-session keying), so the
  backup cadence covers **every** listed id — a single un-backed-up id is that wallet's
  LOCKED row (§4.6).
- Export is **read-only** with respect to the live share and may be repeated freely.
- **Runbook mandate:** export immediately after DKG completes — **no EOA is funded
  before its share id has a verified backup on both parties** (§4.7) — and re-export
  after every future refresh (§4.5).

### 4.4 Import (recover)

`open_share_backup(blob, secret, expected)` enforces, in order:

1. magic + version known (else `UnsupportedVersion` — forward-compat explicit);
2. `header_len` bounded; the header parses; then the **cheap refuse-only checks** over
   the (still unauthenticated) header: epoch is v1, `header.role`/`party_index` match
   the operator's out-of-band record (fixed at DKG provisioning — L1), and
   `header.group_eoa` equals the **mandatory** `expected.group_eoa` (M2: anyone holding
   the *same secret* produces self-consistent blobs, so header-vs-recompute alone is
   vacuous against substitution — the caller-supplied expectation, taken from the
   out-of-band export record, is the non-vacuous check). These checks can only
   **refuse** — nothing is accepted on header data alone;
3. **AEAD opens** (tag covers magic ‖ version ‖ the verbatim header bytes);
4. the payload deserializes via the **bounded** `KeyShare::from_bytes` path (M2
   discipline);
5. authority checks against the decrypted share itself: its recomputed group EOA equals
   the header's and the expectation's, and its own party index equals the header's (the
   header is data, not authority).

Only then is the share returned (`Zeroizing`) / persisted. Owner CLI:
`share-backup import --in <file> --share-id <id> --expect-eoa 0x…` (**`--expect-eoa` is
required, no default**). If the store
**already holds** a live share under that id, import refuses unless `--force` — an
explicit anti-rollback / anti-clobber gate (B-T4, B-T5). Agent side:
`openShareBackup(blob, secretHex, {expectEoa})` (`expectEoa` **required**) → share hex
for the host to custody.

### 4.5 Epoch and proactive refresh (designed now, built in B5.2)

Proactive refresh re-randomizes both shares without changing the group key
(M6-1 §4.10; the DKLs23 fork carries the refresh protocol). Interaction with backup is
the dangerous part, so the format anticipates it **now**:

- `epoch` lives in the AAD-bound header. **v1 writes the constant 0 at seal time** — no
  share-metadata layer exists today (`ShareStore` is id→bytes, `share_store.rs:24`) and
  none is built in v1 (M3). B5.2 introduces epoch **persistence**, incremented
  atomically with share replacement — exactly the slice that needs it.
- **A stale backup is an availability event, never a fund-safety event.** A
  pre-refresh share cannot co-sign with a post-refresh counterparty — the ceremony
  aborts (the same class as kill-one), it cannot produce a *wrong* signature. Import
  of a stale epoch over a live newer share is additionally blocked by the `--force`
  gate; restoring stale-onto-empty surfaces at the mandatory liveness check (§4.7).
- **Refresh mandates re-backup**: the B5.2 ceremony is not "done" until both parties
  have re-exported + verified new backups and destroyed the old blobs (old blobs stop
  being *useful* to their owner but remain *secret-bearing* toward T1-class analysis;
  destruction is cheap hygiene).
- Security dividend — **a B5.2 property, not v1's (H1)**: once refresh ships it
  **invalidates stolen backups** — a blob exfiltrated at epoch N is protocol-dead at
  epoch N+1, which is precisely the M6-1 §4.10 rationale ("bound the window in which a
  single stolen share is useful"). v1 has no rotation; see B-T2 for the honest posture.

### 4.6 Custody rules and the loss matrix

The backup secret is a **second long-lived secret** per party. Rules (documented in the
runbook, enforced where code can):

- The backup secret MUST NOT be co-located with the live share host (a single host
  compromise must not yield share + backup-decryption capability — B-T8). Cold/offline
  custody recommended.
- Blob and secret SHOULD be stored separately from each other.
- Neither blob nor secret is ever transmitted to, or held by, the counterparty or
  kawasekit (constraint 1).
- **Inventory rule (M4):** every share id in `share-backup list` has a current,
  verified backup; funding an EOA before its id is backed up is a runbook violation
  (§4.3).

| Live share | Blob | Secret | Outcome |
|---|---|---|---|
| ✅ | — | — | normal operation (export any time) |
| ❌ | ✅ | ✅ | **RECOVER** (§4.7) |
| ❌ | ❌ | ✅ | **LOCKED** — counterparty cooperation cannot help, by design |
| ❌ | ✅ | ❌ | **LOCKED** — blob is sealed; no passphrase fallback exists |

The two LOCKED rows are the irreducible price of non-custody; this RFC's job is to make
reaching them require **two independent losses on the same party**, and to say so
plainly in operator docs rather than imply rescue that does not exist.

### 4.7 Recovery ceremony (runbook + liveness)

1. Provision the replacement host; restore config (KEK, policy, mTLS material — out of
   B5 scope but listed in the runbook).
2. `share-backup import …` (owner) / `openShareBackup(…)` (agent) — structural
   verification per §4.4 happens here.
3. **Mandatory liveness check (H2 — the artifact is pinned):** co-sign a **minimal
   self-transfer intent** — `from == to == group EOA`, value 0 (or the minimal unit if
   the token rejects 0), a deliberately short `validBefore` window — driven through the
   **full production path** (A3 auth → A4 digest re-derivation → policy → atomic ledger
   commit → ceremony) against the live counterparty on **testnet**, verifying the
   signature recovers to the group EOA. Self-transfer makes the authorization harmless
   even if it leaks and settles. The check **intentionally consumes a nonce and a
   ledger entry** — that is what makes it a real liveness proof. **Prohibition:** no
   raw-digest or "test-mode" signing affordance may be introduced for recovery — that
   would be the A4 bypass (M6-1 §4.5/T4) this system exists to prevent. A recovered
   share is not "recovered" until it has co-signed. (This is also the stale-epoch
   detector of §4.5.)
4. Re-export a fresh backup if anything about the custody arrangement changed.

Recovery is a **juicy target** (M6-1 §4.10): it is the one moment plaintext share
material is handled outside steady state, possibly under incident pressure. The runbook
therefore requires: local-only operation (constraint 2), no recovery "as a service",
and treating any unexpected import failure (tag/EOA/epoch mismatch) as a potential
substitution attack — stop, do not retry with relaxed checks (there are none to relax).

### 4.8 What B5 is NOT

- NOT escrow, social recovery, or a 2-of-3 re-design (rejected for v1, §7 R2).
- NOT SQLite ledger backup (C1 store) — Track D ops; the ledger is reconstructible
  policy state, not key material.
- NOT a key-rotation/migration scheme across DKLs implementations (that is B6,
  M6-1 §4.11; B6's "new keys only" rule is unaffected).
- NOT a kawasekit (public SDK) feature — no public API change, no new SDK deps.

---

## 5. Threat model (backup-specific; composes with M6-1 §5)

| # | Threat | Treatment |
|---|---|---|
| B-T1 | **Sealed blob stolen** (no secret) | XChaCha20-Poly1305 confidentiality + 32-byte random-key HKDF (no passphrase ⇒ no offline-guessing surface, §7 R1). Blob alone is dead weight. |
| B-T2 | **Blob + secret stolen** = stolen share | Reduces to M6-1 T11 (single share ≠ signing capability; 2-of-2 holds). **v1 mitigations: custody rules (§4.6) + revoke (M6-1 §4.12) + the 2-of-2 itself — there is NO rotation until B5.2 ships, so a stolen blob+secret remains a stolen share until the key is retired (H1).** Refresh-epoch invalidation (§4.5) bounds this only from B5.2 on. This is why even *sealed* cross-party blob custody is forbidden: it concentrates both parties' B-T2 preconditions behind one door. |
| B-T3 | **Tampered / substituted blob** | AEAD tag over magic‖version‖header‖payload; EOA recompute-and-compare on import (§4.4 step 4) catches a *validly sealed but wrong-wallet* substitution by anyone holding the same secret. |
| B-T4 | **Rollback to a stale epoch** | Epoch in AAD; `--force` gate over live shares; mixed-epoch ceremony aborts (availability-only, §4.5); refresh mandates old-blob destruction. |
| B-T5 | **Import-surface abuse** (attacker drives a recovery) | No network surface exists (constraint 2); import is an explicit local operator action; overwrite needs `--force`; a planted share still must open under the operator's secret AND match the expected EOA. |
| B-T6 | **Plaintext exposure during seal/open** | `Zeroizing` on all Rust-side buffers; no logging of secrets/share bytes (repo logger rules); CLI prints fingerprints only. **Known limitation (L3):** agent-side JS strings (share hex / backup secret) cannot be wiped — inherited from the live path (`CoSignSigner::new(shareHex)`). |
| B-T7 | **Cross-wallet / cross-role confusion** | Role + party_index + group_eoa + share_id in the AAD-bound header; HKDF info string binds role into the key itself. |
| B-T8 | **Secret co-located with live host** | Custody rules §4.6 (ops mandate — code cannot enforce geography; the runbook + review checklist carry it). |
| B-T9 | **Double loss ⇒ permanent lock** | Not solvable without weakening non-custody. Mitigated by cadence (backup-before-funding mandate §4.3, re-backup-after-refresh §4.5) and honest operator docs (§4.6). |

---

## 6. Conformance & tests (definition of "tested")

All in `kawasekit-mpc-2p` (Rust unless noted). Security-relevant behavior gets a
negative test (repo rule).

1. **Roundtrip**: seal → open returns byte-identical share + parsed header.
2. **Recovery e2e (the Track-B done-definition)**: distributed DKG → export both
   parties' backups → **wipe both live shares** → import both → run a full co-sign of
   the **§4.7 liveness-intent shape** (self-transfer, short window) → signature
   recovers to the original group EOA.
3. **Backup-alone cannot sign (the non-custody negative)**: a recovered single share,
   driving the honest protocol with no counterparty, produces no signature (kill-one
   re-asserted against a *recovered* share).
4. **Tamper**: flip any byte of header or ciphertext ⇒ typed failure, nothing returned.
5. **Wrong secret** ⇒ typed failure (and: at-rest KEK used as backup secret fails —
   domain separation is real, not aspirational).
6. **Identity mismatch**: role, party_index, or `expected.group_eoa` mismatch ⇒ typed
   failure before any persistence; **a missing expectation ⇒ refusal (M2: the parameter
   is required, not optional)**; valid-seal-wrong-wallet substitution (B-T3) covered.
7. **Bounded deserialization**: oversized / garbage payload under a valid seal ⇒
   `from_bytes` rejects without panic or unbounded allocation.
8. **Anti-clobber**: import over an existing live share refuses without `--force`;
   epoch-mismatch refusal mechanics exercised (epoch values injected; v1 ships 0).
9. **wasm parity**: a blob sealed by the wasm build opens in native and vice versa
   (one format, two builds — constraint 3), exercised in a Node gate alongside the
   existing slice gates.

Gates: the standard mpc-2p 4-point (test / clippy / fmt / wasm32) + the Node gate run.

---

## 7. Alternatives rejected

- **R1 — Passphrase + Argon2id instead of a raw 32-byte secret.** Human-memorable
  passphrases hand the adversary an offline-guessing surface on an artifact designed
  to sit in cold storage for years, and add a KDF dependency + parameter-tuning
  burden. Operators here are service operators and developers, not retail users; a
  generated raw key in proper custody is strictly stronger. Revisit only if a future
  product surface demands human-memorable recovery.
- **R2 — 2-of-3 with an owner-held recovery share** (M6-1 §10 Q2's variant). Changes
  the trust topology of the whole system to solve an availability problem; v1 stays
  2-of-2 (M6-1 decision) and solves availability per-party.
- **R3 — Cloud escrow / kawasekit-held sealed copies.** Custody creep (M6-1 T10);
  violates constraint 1 even sealed (see B-T2).
- **R4 — Reusing the at-rest `EncryptedShareStore` blob as the backup.** Chains
  recovery to the at-rest KEK and a context-free format (no AAD identity, no version,
  no epoch); fails §2.2's requirements wholesale.
- **R5 — Network export/import endpoints.** An exfiltration channel with a login page.
  Constraint 2.

---

## 8. Definition of Done (Track B)

- `crypto-core` backup module (format v1, seal/open, typed errors) — implemented +
  tested per §6, native and wasm32.
- Owner CLI (`share-backup` bin: `keygen` / `export` / `import` / `list`) —
  implemented; atomic writes + `0600` on secret-bearing outputs (L2); exercised by the
  e2e test path.
- Agent-side wasm exports + `agent-ts` helpers — implemented; wasm-parity gate green.
- Recovery runbook (`docs/` in mpc-2p) covering §4.3 cadence, §4.6 custody rules and
  loss matrix, §4.7 ceremony + liveness check.
- §6 tests 1–9 green; mpc-2p 4-point gate green; no public-SDK change.
- This RFC: `web3-cto-review` pass with all findings closed **before** implementation
  lands (design-first rule).

## 9. Staging

- **B5.1 (this track, implement now):** everything in §8.
- **B5.2 (follow-on, designed here):** proactive refresh ceremony (epoch
  **persistence introduced here** and incremented atomically with share replacement,
  over-the-wire refresh frames, mandatory re-backup + old-blob destruction step). Deliberately staged: refresh adds new wire frames and a
  two-party ceremony; backup must exist first and already anticipates it (§4.5).
- **B5.3 (with Track D):** deployment-environment custody guidance (Railway volume +
  where the backup secret lives in a managed deploy).

## 10. Decisions for the maintainer (pre-implementation)

1. **Backup secret form** — raw 32-byte generated key (recommended, §7 R1) vs.
   passphrase+KDF.
2. **Refresh staging** — B5.2 as follow-on (recommended) vs. pulled into Track B.
3. **New dependencies** — the full crypto-core delta `chacha20poly1305` + `hkdf` +
   `sha2` + `serde_json` (recommended; all wasm32-safe — M1) vs. direct-key AEAD with
   documented-only separation (drops `hkdf`/`sha2` but loses derived domain
   separation).
4. **Agent backup surface placement** — wasm-bindgen exports + `agent-ts` wrappers
   (recommended; one implementation) vs. TS-side reimplementation (rejected by
   constraint 3, listed for completeness).

## Appendix — anchors

| Claim | Anchor |
|---|---|
| B5 is a hard requirement; scope sketch | `docs/rfc/mpc-2p-cosigner.md` §4.10 |
| T9 single-share loss = fund lock | `docs/rfc/mpc-2p-cosigner.md` §5 T9 |
| Recoverability-vs-custody tension | `docs/rfc/mpc-2p-cosigner.md` §10 Q2 |
| Current store = persist + at-rest only | `kawasekit-mpc-2p/src/share_store.rs:24,56,95` |
| `Zeroizing` on share load (self-audit M1) | `kawasekit-mpc-2p/src/share_store.rs:22,141` |
| Bounded deserialization discipline (M2) | mpc-2p self-audit Sprint 2 (`MAX_FRAME_BYTES`) |
| Kill-one negative control to re-assert | `docs/rfc/mpc-2p-cosigner.md` §6.1 |
| Refresh protocol availability in the fork | kawasekit-dkls23 fork (refresh module; fork self-audit M3 touched it) |
| Track B mandate + done-definition | `docs/STATUS.md` §2 item 2, `docs/STAUS_REVIEW.md` Track B |
