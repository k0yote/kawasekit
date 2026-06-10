# CTO Review — RFC B5 Key-Share Backup / Recovery (pass 1)

**Artifact:** `docs/rfc/b5-share-backup-recovery.md` (Draft v1)
**Reviewed:** 2026-06-10, against `kawasekit-mpc-2p` source (main @ post-`1fcd384`) and the
`kawasekit-dkls23` fork (dev @ `ddaa091`).
**Reviewer:** web3-cto-review (CTO-class external review persona)

---

## §1. Executive Summary

**Verdict: Conditional Approval.** The RFC may proceed to implementation once the two High
findings (H1, H2) are closed in the RFC text; the Medium findings are strongly recommended
before implementation begins since they change the spec'd CLI/API surface. No Critical
findings: the core design — strictly per-party backup, a single AAD-bound versioned AEAD
format implemented once in `crypto-core` and compiled both ways, no network surface, raw-key
(not passphrase) sealing, deny-closed import with EOA recompute — is sound and correctly
preserves the non-custodial invariant.

**Strengths**

- **The custody answer is right.** Per-party-only recovery (no escrow, no cross-party blob
  custody, no kawasekit copy) is the only resolution of M6-1 §10 Q2 that doesn't quietly
  reconstitute custody, and the RFC commits to it as a hard constraint, including the
  non-obvious "not even sealed" rule with a correct justification (B-T2 concentration).
- **"No share ever crosses the wire" as a structural constraint** (no `CoSignFrame`, no
  admin endpoint) kills the whole remote-exfiltration class at design time rather than
  mitigating it at review time.
- **The format anticipates refresh without building it.** Epoch in the AAD-bound header,
  stale-backup-is-availability-not-fund-safety reasoning, and the mixed-epoch-abort argument
  are all correct DKLs23 reasoning.
- **Raw 32-byte secret over passphrase KDF** (§7 R1) is the right call for this operator
  profile and removes the offline-guessing surface entirely — most teams get this backwards.
- **Empirically grounded.** The RFC's claims about the existing code checked out almost
  everywhere (see Appendix): bounded `from_bytes`, `Zeroizing` handling, kill-one test,
  agent-share byte-compatibility, fork refresh module — all verified real.

**Weaknesses that gate sign-off**

- **H1** — the threat model cites refresh-epoch invalidation as a mitigation for stolen
  backups while staging refresh OUT to B5.2: the exact "mitigation rests on un-built code"
  pattern that produced the C1 correction in M6-3a. Must be stated honestly for v1.
- **H2** — the mandatory post-recovery "liveness check" is underspecified: a co-sign
  produces a *real, settleable EIP-3009 authorization*. Without pinning a safe liveness
  artifact, implementers will either mint a live bearer instrument as a "test" or — worse —
  add a raw-digest test mode that bypasses A4.

---

## §2. Findings matrix

| ID | Severity | Title | Est. effort | Release-blocking |
|---|---|---|---|---|
| H1 | 🟠 High | Stolen-backup mitigation cites refresh, which is staged out to B5.2 (self-consistency) | 0.25d | ✅ (RFC gate) |
| H2 | 🟠 High | Recovery liveness check signs a real authorization; safe artifact unspecified, raw-digest bypass risk | 0.25d | ✅ (RFC gate) |
| M1 | 🟡 Medium | crypto-core dependency delta understated (chacha20poly1305/hkdf/sha2/serde_json all new there) + wasm nonce-RNG note | 0.25d | strongly rec. |
| M2 | 🟡 Medium | `--expect-eoa` is optional → header-vs-header verification is vacuous against same-secret substitution | 0.25d | strongly rec. |
| M3 | 🟡 Medium | "epoch from share metadata" — no share metadata exists; v1 epoch sourcing must be specified honestly | 0.25d | strongly rec. |
| M4 | 🟡 Medium | Multi-share inventory: a backend holds N shares; one un-backed-up id = that wallet locked | 0.25d | strongly rec. |
| L1 | 🟢 Low | Role↔party_index mapping convention unpinned | 0.1d | — |
| L2 | 🟢 Low | Atomic writes + 0600 permissions for blob/store files unspecified | 0.1d | — |
| L3 | 🟢 Low | Agent-side JS string non-zeroizability not named as a known limitation | 0.1d | — |

**Total:** High 0.5d · Medium 1.0d · Low 0.3d — all RFC-text changes, pre-implementation.

---

## §3. Per-finding detail

### H1. Stolen-backup mitigation cites refresh, which is staged out to B5.2

**Problem** — §5 B-T2 says a stolen blob+secret is "bounded further by refresh epoch
invalidation (§4.5)", and §4.5 presents the "security dividend: refresh invalidates stolen
backups." But §9 stages refresh to **B5.2 (follow-on, not built in Track B)**. Until B5.2
ships, there is **no rotation**: a stolen blob+secret is a stolen share for the *lifetime of
the key*.
**Impact** — the threat model overstates v1's posture using an un-built mechanism — the
identical failure pattern as the M6-3a C1 finding (§4.6 claimed properties of a store that
didn't exist), which this project already paid for once. An external auditor reading B-T2
would reject the row.
**Fix approach** — (recommended) Keep the design as-is, fix the text: B-T2 states v1
mitigations are custody rules (§4.6) + revoke (M6-1 §4.12) + the 2-of-2 itself, with refresh
invalidation explicitly labeled "B5.2-forward, not v1". §4.5's dividend sentence gets the
same label. Alternative (not recommended): pull refresh into Track B — scope creep against
the STAUS_REVIEW track definition and it needs new wire frames.
**Done definition** — B-T2 and §4.5 carry no un-built mitigation without an explicit
"(B5.2, not v1)" label; §1 summary names the v1 limitation in one sentence.

**Claude Code prompt**
````
In kawasekit/docs/rfc/b5-share-backup-recovery.md, fix the H1 self-consistency finding:
(1) §5 B-T2 — rewrite so v1 mitigations are custody rules (§4.6) + revoke + the 2-of-2
itself; refresh-epoch invalidation must be explicitly labeled as arriving only with B5.2.
(2) §4.5 "security dividend" sentence — add the same "(B5.2 property, not v1)" label.
(3) §1 — one honest sentence: until B5.2, a stolen blob+secret remains potent until the
key is retired. Do not commit — leave the diff for PR review.
````

### H2. Recovery liveness check signs a real authorization; safe artifact unspecified

**Problem** — §4.7 step 3 mandates "run one real co-sign ceremony … on testnet" but never
says **what intent is signed**. A successful co-sign yields a valid, settleable EIP-3009
`transferWithAuthorization` — a bearer instrument. The naive implementations are both bad:
(a) sign an arbitrary spend "as a test" (mints a live authorization that must then be
custodied or burned), or (b) add a raw-digest "test mode" to the backend — which is exactly
the A4 bypass (M6-1 §4.5/T4) this system's entire design forbids.
**Impact** — a recovery runbook that quietly creates either a stray live payment
authorization or a policy-bypassing side door, at the most incident-pressured moment in the
system's lifecycle (§4.7's own "juicy target" observation).
**Fix approach** — (recommended) Pin the liveness artifact: a **minimal self-transfer
intent** — `from == to == group EOA`, value 0 (or 1 wei-unit if the token rejects 0), a
deliberately short `validBefore` window — driven through the **full production path** (A3
auth → A4 digest re-derivation → policy → atomic ledger commit → ceremony). Self-transfer
makes the authorization harmless even if it leaks and settles (funds move from the EOA to
itself; JPYC/FiatToken-lineage `transferWithAuthorization` permits self-transfer). Add an
explicit constraint: **no raw-digest or "test mode" signing affordance may be added** for
recovery. Note the check consumes a nonce + a ledger entry by design (it should — that's
what makes it a real liveness proof). Alternative: a dedicated "canary token" registry entry
— more moving parts, rejected.
**Done definition** — §4.7 specifies the exact liveness intent shape and the full-path
requirement; §3 (or §4.7) carries the no-raw-digest-affordance prohibition; §6's test list
includes the liveness-intent shape in the e2e test.

**Claude Code prompt**
````
In kawasekit/docs/rfc/b5-share-backup-recovery.md, close H2: rewrite §4.7 step 3 to pin
the liveness artifact: a minimal self-transfer intent (from == to == group EOA, value 0 or
minimal unit, short validBefore) through the FULL production path (A3 → A4 → policy →
ledger → ceremony); state it intentionally consumes a nonce + ledger entry. Add an explicit
prohibition (constraint or §4.7 note): no raw-digest / "test-mode" signing affordance may
be introduced for recovery — that would be the A4 bypass (M6-1 T4). Reflect the intent
shape in §6 test 2. Do not commit — leave the diff for PR review.
````

### M1. crypto-core dependency delta understated; wasm nonce-RNG path should be pinned

**Problem** — §4.2 says "New dependency: RustCrypto `hkdf` (+`sha2`, already in the DKLs
tree)". Verified against `crypto-core/Cargo.toml`: crypto-core has **none** of
`chacha20poly1305`, `hkdf`, `sha2`, `serde_json` as direct deps (chacha20poly1305/sha2/
serde_json exist only in the **backend** crate). Implementing seal/open in crypto-core (the
RFC's own constraint 3) adds **four** direct deps to the wasm-compiled crate, not one. Also,
AEAD nonce sampling (`AeadCore::generate_nonce` → OsRng → getrandom) on wasm32 rides the
`wasm_js` backend — configured (verified in `.cargo/config.toml`) but the RFC should name it
as load-bearing (a broken host RNG ⇒ nonce reuse under a long-lived backup secret).
**Impact** — dependency-policy honesty (repo rule: new deps justified explicitly) and a
missing security note on the one RNG the backup path adds.
**Fix approach** — enumerate the full delta in §4.2 (all four crates, wasm32-safe, audited
RustCrypto lineage for three; serde_json already trusted in the backend), and add one
sentence tying nonce RNG to the existing `wasm_js`/T12 discipline.
**Done definition** — §4.2 lists every new crypto-core dependency; the wasm RNG note exists;
§10 decision 3 reflects the real delta.

**Claude Code prompt**
````
In kawasekit/docs/rfc/b5-share-backup-recovery.md §4.2 (and §10 item 3), replace the
"hkdf (+sha2 already in tree)" claim with the verified dependency delta for crypto-core:
chacha20poly1305 (currently backend-only), hkdf, sha2, serde_json — all new DIRECT deps of
the wasm-compiled crypto-core. Add a note: AEAD nonce sampling uses OsRng/getrandom; on
wasm32 this rides the already-pinned wasm_js backend (.cargo/config.toml) and is
security-load-bearing (M6-1 T12 discipline). Do not commit — leave the diff for PR review.
````

### M2. Optional `--expect-eoa` makes import verification vacuous against same-secret substitution

**Problem** — §4.4 step 4 compares the recomputed EOA to `header.group_eoa`, and to
`expected.group_eoa` only "when the caller supplies one". An adversary (or confused
operator) holding the *same backup secret* produces blobs whose header and payload are
self-consistent — recompute-vs-header always passes. Without a mandatory caller-supplied
expectation, the only non-vacuous check is optional, so a wrong-wallet/stale-wallet blob
imports cleanly and the error surfaces at liveness (availability loss at the worst time) —
or never, if the operator skips the runbook.
**Impact** — B-T3's "valid-seal-wrong-wallet substitution" defence quietly depends on an
optional flag.
**Fix approach** — make the expected identity **mandatory**: CLI `import` requires
`--expect-eoa` (no default); agent `openShareBackup` requires `expectEoa`. Export prints the
group EOA + blob SHA-256 fingerprint and the runbook mandates recording both out-of-band at
export time (that record is what recovery checks against).
**Done definition** — §4.4 marks the expectation required on both surfaces; §4.3 export
output + runbook record the EOA/fingerprint pair; §6 test 6 covers the missing-expectation
refusal.

**Claude Code prompt**
````
In kawasekit/docs/rfc/b5-share-backup-recovery.md, close M2: §4.4 — make expected.group_eoa
REQUIRED (CLI --expect-eoa mandatory, agent openShareBackup expectEoa mandatory; refusal
without it). §4.3 — export prints group EOA + SHA-256 blob fingerprint; runbook mandates
recording both out-of-band. §6 test 6 — add the missing-expectation refusal arm. Do not
commit — leave the diff for PR review.
````

### M3. "epoch from share metadata" — no share metadata exists today

**Problem** — §4.3 says the export header takes "epoch from share metadata" and §4.5 says
epoch lives "in the share-store metadata". Verified: `ShareStore` is `id → bytes` only
(`share_store.rs:24-27`), no metadata anywhere; `service.rs` doesn't even wire a
`ShareStore` (bins/tests construct stores directly). v1 has nowhere to read an epoch from.
**Impact** — the RFC describes reading state that does not exist — same claim-vs-code class
as H1, lower stakes (v1 epoch is constant anyway).
**Fix approach** — v1: epoch is the **constant 0 written at seal time**; no metadata layer
is built. B5.2 introduces epoch persistence *atomically with refresh* (that is exactly the
slice where it's needed). Also fix §4.3's "reads through the configured store" to say the
CLI constructs its store from its own config (the bins/tests pattern), since the service
doesn't own one.
**Done definition** — no RFC sentence implies a v1 metadata read; B5.2's epoch-persistence
obligation is stated in §9.

**Claude Code prompt**
````
In kawasekit/docs/rfc/b5-share-backup-recovery.md, close M3: §4.3/§4.5 — v1 epoch is a
constant 0 written at seal time (ShareStore is id→bytes only, verified share_store.rs:24;
no metadata layer exists or is built in v1); epoch persistence arrives in B5.2 atomically
with refresh (state this in §9). §4.3 — the share-backup CLI constructs its own store from
config (the existing bins/tests pattern); service.rs does not wire a ShareStore. Do not
commit — leave the diff for PR review.
````

### M4. Multi-share inventory: one un-backed-up share id = that wallet locked

**Problem** — the backend supports multi-session keying (multiple shares, one per
wallet/session). The RFC's export/import is per-`share_id`, but nothing enumerates the
inventory: an operator who backs up share A and forgets share B has wallet B silently
unprotected — and §4.3's backup-before-funding mandate has no mechanical support.
**Impact** — B-T9 (permanent lock) via inventory gap rather than double loss; the most
likely *real-world* path to the LOCKED rows.
**Fix approach** — add `share-backup list` (enumerate store ids + group EOAs + whether a
backup fingerprint is on record) and a runbook rule: the backup cadence covers **every**
listed id; funding any EOA requires its id to have a verified backup.
**Done definition** — CLI surface includes `list`; §4.3/§4.6 carry the inventory rule; §8
DoD names the subcommand.

**Claude Code prompt**
````
In kawasekit/docs/rfc/b5-share-backup-recovery.md, close M4: add `list` to the share-backup
CLI (§4.3, §8): enumerate share ids + group EOAs from the configured store. Add the
inventory rule to §4.3 cadence + §4.6 custody rules: backup cadence covers EVERY listed id;
no EOA is funded before its share id has a verified backup. Do not commit — leave the diff
for PR review.
````

### L1. Role↔party_index mapping convention unpinned

**Problem** — header carries both `role` and `party_index` but the RFC never pins which DKG
index is the agent vs the owner; §4.4 step 5 checks "match the importing side" without
saying where the importer's expected values come from after total loss.
**Fix approach** — one sentence: the role↔index assignment is fixed at DKG/provisioning
time and recorded alongside the EOA/fingerprint record (§4.3/M2); import checks against
that record, not against the header itself.
**Done definition** — the provenance of the importer's expected role/index is stated.

**Claude Code prompt**
````
In kawasekit/docs/rfc/b5-share-backup-recovery.md §4.2/§4.4, add: role↔party_index is
fixed at DKG provisioning and recorded in the operator's out-of-band record (with EOA +
fingerprint, M2); import verifies header fields against that record (the header is data,
not authority). Do not commit — leave the diff for PR review.
````

### L2. Atomic writes + permissions unspecified

**Problem** — blob/file writes (CLI export, `FileShareStore::save` via `fs::write`,
`share_store.rs:71-74`) are non-atomic and permission-default. A crash mid-write corrupts;
group/world-readable backup files on a shared host leak sealed material.
**Fix approach** — spec tmp-file + fsync + rename and `0600` for every secret-bearing file
the B5 code writes (note `FileShareStore`'s existing behavior as a pre-existing gap to fix
in passing or leave noted).
**Done definition** — §8 DoD includes atomic-write + 0600 for CLI outputs.

**Claude Code prompt**
````
In kawasekit/docs/rfc/b5-share-backup-recovery.md, add to §4.3/§8: all secret-bearing files
written by B5 code use tmp+fsync+rename and 0600 permissions; note FileShareStore::save
(share_store.rs:71) as a pre-existing non-atomic write to align while in the area. Do not
commit — leave the diff for PR review.
````

### L3. Agent-side JS string non-zeroizability — name the known limitation

**Problem** — §5 B-T6 claims `Zeroizing` end-to-end, but the agent surface passes share hex
and the backup secret as **JS strings** (immutable, GC-copied, non-zeroizable). This is the
status quo for `CoSignSigner::new(shareHex)` — inherited, not new — but the threat-model row
overclaims as written.
**Fix approach** — one caveat sentence in B-T6: Rust-side buffers are `Zeroizing`; JS-side
strings cannot be wiped (inherited limitation, same as the live agent share path).
**Done definition** — B-T6 no longer overclaims.

**Claude Code prompt**
````
In kawasekit/docs/rfc/b5-share-backup-recovery.md §5 B-T6, add the caveat: zeroization
covers Rust-side buffers; agent-side JS strings (share hex / backup secret) cannot be wiped
— an inherited limitation shared with CoSignSigner::new(shareHex). Do not commit — leave
the diff for PR review.
````

---

## §4. Recommended work sequence

- **Sprint 1 (RFC gate, before implementation):** H1 + H2 — both pure RFC-text, same file,
  do in one pass. Then M1–M4 (also same file; M2/M4 alter the spec'd CLI/API surface, so
  they must land before code is written to that spec). L1–L3 fold into the same editing
  pass — there is no reason to leave them for later given they're sentences.
- **Sprint 2 (implementation, B5.1):** implement to the corrected RFC (Track B / B2). All
  findings are design-doc findings; none require new review rounds, but the §6 test list
  (now including the M2 refusal arm and the H2 liveness-intent shape) is the PR bar.

All nine findings touch one file and are independent; a single editing pass closing all of
them is the efficient route.

## §5. PR review criteria

- [ ] PR description names H1, H2, M1–M4, L1–L3 as closed; this review file is linked.
- [ ] No threat-model row cites a B5.2+ mechanism as a v1 mitigation without the label (H1).
- [ ] §4.7 names the exact liveness intent shape + the no-raw-digest prohibition (H2).
- [ ] §4.2's dependency list matches `crypto-core/Cargo.toml` *after* implementation (M1).
- [ ] `--expect-eoa`/`expectEoa` are required parameters in the spec (M2).
- [ ] No sentence implies v1 share metadata (M3); `list` subcommand spec'd (M4).
- [ ] RFC Status header bumped to Draft v2 with this pass recorded.

## Appendix — Empirical spot-check

| Claim location | Verification method | Result |
|---|---|---|
| RFC §2.1 — `ShareStore` trait / `FileShareStore` / `EncryptedShareStore` / `Zeroizing` at `share_store.rs:24/56/95/22/141` | Read `src/share_store.rs` | ✅ all lines as cited |
| RFC §4.1 — backup payload = `KeyShare::to_bytes`, same bytes agent holds as hex | `crypto-core/src/lib.rs:302-313` + `agent-wasm/src/lib.rs:86-90` ("hex of `KeyShare::to_bytes`") | ✅ byte-compatible |
| RFC §4.4 — bounded deserialization exists (M2 discipline) | `crypto-core/src/transport.rs:21` `MAX_FRAME_BYTES` + `lib.rs:1026` `from_bytes_rejects_oversized_frame` | ✅ |
| RFC §4.4 — group-EOA recompute + party_index available for import checks | `crypto-core/src/lib.rs:322` (`eth_address`), `:326` (`party_index`) | ✅ |
| RFC §6.3 — kill-one negative control exists to re-assert | `crypto-core/src/lib.rs:957` `a_single_share_cannot_sign_alone` | ✅ |
| RFC Appendix — fork carries the refresh protocol | `DKLs23/dkls23-core/src/protocols/refresh.rs` exists | ✅ |
| RFC §4.2 implied — wasm RNG backend configured for nonce sampling | `.cargo/config.toml` `getrandom_backend="wasm_js"` rustflags | ✅ |
| RFC §4.2 — "hkdf (+sha2, already in the DKLs tree)" as the dep delta | `cat crypto-core/Cargo.toml` — no chacha20poly1305/hkdf/sha2/serde_json; backend Cargo.toml has chacha20poly1305+sha2+serde_json | ❌ understated → **M1** |
| RFC §4.3/§4.5 — "epoch from share metadata" | `ShareStore` = id→bytes only; `grep ShareStore src/service.rs` → not wired; stores constructed by bins/tests | ❌ no metadata exists → **M3** |
| RFC §5 B-T2 — refresh bounds stolen backups | RFC §9 stages refresh to B5.2 (un-built) | ❌ self-consistency → **H1** |
| RFC §3 constraint 2 — wire protocol unchanged | No backup frames proposed; local-only surfaces | ✅ structural |
| RFC §5 B-T6 — `Zeroizing` end-to-end | Rust side ✅ (`to_bytes` returns `Zeroizing`, store loads `Zeroizing`); agent JS strings not wipeable | ⚠️ overclaim on JS side → **L3** |
