# Security Policy

kawasekit handles cryptographic keys and on-chain value flows. We take
security seriously and appreciate responsible disclosure.

## Reporting a Vulnerability

**Do not open a public GitHub issue for security vulnerabilities.**

Instead, email **security@k0yote.dev** with:

- A description of the vulnerability and its potential impact
- Steps to reproduce (proof-of-concept code if possible)
- Affected version(s) and environment

You can expect an initial acknowledgement within **72 hours**. We will keep
you informed as we investigate and work toward a fix, and will credit you in
the release notes unless you prefer to remain anonymous.

Please give us a reasonable window to address the issue before any public
disclosure.

## Supported Versions

kawasekit is **pre-alpha** software. Until the `0.1.0` release, only the
latest `main` branch receives security fixes. Milestone tags
(`v0.0.0-mN`) are checkpoints — they do **not** receive backported fixes.

| Version | Supported |
| ------- | --------- |
| `main` (pre-alpha) | ✅ |
| `v0.0.0-m1`, `v0.0.0-m2`, … (milestone tags) | ❌ (snapshots only) |

## Scope

This policy covers the kawasekit SDK in this repository. Smart contracts live
in the separate `kawasekit-contracts` repository and are covered by its own
security policy.
