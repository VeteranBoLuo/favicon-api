# Security Policy

## Supported versions

Security fixes are applied to the latest release on the `main` branch.

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting feature instead of opening a public issue. Include reproduction steps, the affected URL-handling path, and the expected security boundary.

Do not test against infrastructure you do not own or have permission to access. Please allow reasonable time for investigation before public disclosure.

## Deployment note

The built-in SSRF checks are one layer of defense. Internet-facing production deployments should also restrict outbound network access and block private, metadata, and internal address ranges at the network layer.
