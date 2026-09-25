# Pre-release compliance checklist (run before EVERY build/release)

No em dashes, per project rule. Every box must be ticked before a release ships.
This exists so a new feature cannot quietly break the privacy posture.

## Data-flow review
- [ ] No captured content is transmitted off the user's machine by default.
- [ ] The capture server still binds localhost only.
- [ ] Conversion of browsing content to memory is local/keyless by default; any
      cloud conversion is explicit, informed opt-in.

## Capture scope
- [ ] Typed input / form fields / passwords are still excluded from capture.
- [ ] The sensitive-site exclusion list still blocks banking, payments, webmail,
      health, government, and password managers (extension AND server).
- [ ] PII scrub (cards via Luhn, national IDs) still runs before storage.
- [ ] Capture is still gated on user consent (no capture before acceptance).

## Consent and disclosure
- [ ] The install-time consent gate still appears and blocks capture until accepted.
- [ ] PRIVACY.md / PRIVACY.html and ACCEPTABLE-USE.md are current and shipped.
- [ ] Any material change to data handling re-prompts the user for consent.

## Storage and vault
- [ ] Vault files are still encrypted at rest and written read-only.
- [ ] Tampered vault files are detected, not served.
- [ ] The vault password is never written to disk or logs.

## Permissions and store policy
- [ ] Manifest requests only the permissions actually used; all-sites stays opt-in.
- [ ] No API keys or secrets in the repo, code, or logs.
- [ ] Store listings (Chrome/Edge/Firefox) match the actual data practices.

## Framing
- [ ] Website and GitHub framing lead with personal use and this being the local
      version that keeps data on the user's computer. Describe local behaviour in
      the present tense; do NOT promise "always local" or "never any cloud". A
      separate cloud plan for collaboration may come later, and it must be
      described as a distinct, opt-in add-on that does not change the local
      version, so early adopters are not misled.
- [ ] The tool is never presented as a surveillance or data-extraction product.

## Sign-off
- [ ] Security audit run (see TODO security section).
- [ ] For a public release: privacy/data-protection lawyer has reviewed the
      ingest path, the third-party-personal-data question, and all documents.
