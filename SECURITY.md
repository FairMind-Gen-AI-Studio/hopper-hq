# Security policy

## Reporting a vulnerability

Please do not open a public issue for a security problem. Report it privately through GitHub: on the repository's **Security** tab, choose **Report a vulnerability**.

Say what you found, how to reproduce it, and what it lets someone do. We will acknowledge your report, keep you informed while we look into it, and credit you in the fix if you wish.

## What to expect from scranton-hq

scranton-hq runs a daemon on your machine. By design:

- it listens on 127.0.0.1 only;
- the CLI and the mod authenticate with a token in `~/.scranton-hq/token`, readable by you only;
- a browser signs in with a one-time link and receives a signed, HttpOnly cookie;
- the page loads nothing from the network, under a strict content security policy;
- there is no telemetry. Nothing leaves your machine unless you turn on summaries, which send one session's notes to the provider you chose.

The README's [Privacy and security](README.md#privacy-and-security) and [Signing in](README.md#signing-in) sections describe this in full, including a known risk: browsers do not keep cookies apart by port.

Problems we want to hear about include a way to reach the daemon from another machine, to sign in without a link or a token, to send hook events or stop the daemon from a browser, to read or write files outside the data directory, or to make the page load something from the network.

## Supported versions

scranton-hq is early. Fixes go into the latest release only.
