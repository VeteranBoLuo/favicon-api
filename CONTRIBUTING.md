# Contributing

Thanks for helping make `favicon-api` more reliable.

## Before opening an issue

- Confirm the target is a public HTTP or HTTPS website.
- Include the domain, expected favicon URL, actual response, and reproduction command.
- Do not include private URLs, credentials, or internal network details.

## Development

This project requires Node.js 18 or newer and has no runtime dependencies.

```bash
npm start
npm test
npm run check
```

## Pull requests

1. Keep changes focused and dependency-free unless a dependency has a clear security or reliability benefit.
2. Add or update tests for behavior changes and edge cases.
3. Update every affected README translation when API behavior changes.
4. Run `npm run check` before submitting the pull request.

Security vulnerabilities should be reported privately as described in [SECURITY.md](SECURITY.md).
