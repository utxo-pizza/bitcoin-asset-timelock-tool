# Documentation

This is the documentation for the UTXO Pizza fork of Bitcoin Asset Time Lock. The [live application](https://timelock-tool.utxo.pizza/) and [README](../README.md) describe this fork, not the upstream deployment.

This fork adds fixed-date CLTV alongside separate CSV workspaces, Chain MTP date handling, and public backups that restore lock references from a transaction, JSON file or inscription. The [changelog](CHANGELOG.md) tracks those additions and the Fractal recovery verification fixes.

## If you want to use it

Start with the [CSV/CLTV comparison and operating steps](../README.md#choose-the-right-lock), then read [validation evidence](VALIDATION.md). A visible record is not proof of confirmation, and a future UTC date is not the same as the chain's MTP. Keep local records and network information before moving between sites.

To preserve or recover a lock, follow [public backup and recovery](PUBLIC-BACKUP.md). Import, Verify and Review are separate actions; the guide explains [why the review button can remain disabled](PUBLIC-BACKUP.md#if-review-recovered-unlock-is-disabled) and how to recheck an existing reference after an update.

## If you want to contribute or integrate

[Development](DEVELOPMENT.md) explains how to run the tests without real funds. [BATL](BATL-PROTOCOL.md) is the wire-format and output-derivation contract; [public backup and recovery](PUBLIC-BACKUP.md) describes the implemented workflow and its limits. [Contributing](../CONTRIBUTING.md) explains review and compatibility requirements. Use [private security reporting](../SECURITY.md) for sensitive findings.

## If you want to host a copy

[Deployment](DEPLOYMENT.md) covers static output, base paths, headers, provider configuration and origin-bound browser records. A clone is not automatically connected to UTXO Pizza's Cloudflare account or production site.

## Understand the architecture

[Architecture and recovery boundaries](ARCHITECTURE.md) explains how the browser, wallet, chain and indexers divide responsibility. Historical counts, deployment checks and maintainer-reported tests belong in [validation evidence](VALIDATION.md); they are not certification of the whole product.
