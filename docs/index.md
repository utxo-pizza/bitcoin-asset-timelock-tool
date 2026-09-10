# Documentation

This is the documentation for the UTXO Pizza fork of Bitcoin Asset Time Lock. The [live application](https://timelock-tool.utxo.pizza/) and [README](../README.md) describe this fork, not the upstream deployment.

## If you want to use it

Start with the [CSV/CLTV comparison and operating steps](../README.md#choose-the-right-lock), then read [validation evidence](VALIDATION.md). A visible record is not proof of confirmation, and a future UTC date is not the same as the chain's MTP. Keep local records and network information before moving between sites.

## If you want to contribute or integrate

[Development](DEVELOPMENT.md) explains how to run the existing tests without real funds. [BATL](BATL-PROTOCOL.md) is the wire-format and output-derivation contract for compatible tooling; it does not promise an existing recovery screen. [Contributing](../CONTRIBUTING.md) explains review and compatibility requirements. Use [private security reporting](../SECURITY.md) for sensitive findings.

## If you want to host a copy

[Deployment](DEPLOYMENT.md) covers static output, base paths, headers, provider configuration and origin-bound browser records. A clone is not automatically connected to UTXO Pizza's Cloudflare account or production site.

## Understand the architecture

[Architecture and recovery boundaries](ARCHITECTURE.md) explains how the browser, wallet, chain and indexers divide responsibility. Historical counts, deployment checks and maintainer-reported tests belong in [validation evidence](VALIDATION.md); they are not certification of the whole product.
