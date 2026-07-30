# Security policy

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting feature for security
issues that could expose API keys, selected text, local files, or user data.
Do not publish sensitive details in a public issue.

For ordinary bugs that do not involve sensitive information, open a regular
GitHub issue with the Obsidian version, plugin version, provider, and steps to
reproduce. Never include an API key or private note content.

## Data boundary

The plugin sends only the current selection to the configured translation
provider. It does not read or upload entire notes, filenames, vault paths, or
vault contents. It contains no telemetry.
