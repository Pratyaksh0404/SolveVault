# Security Policy

SolveVault's entire trust model depends on the code doing exactly what the README says it does, and nothing more. If you find a case where that's not true, please report it.

## Reporting a vulnerability

Please **do not** open a public GitHub issue for security vulnerabilities.

Instead, use GitHub's private reporting feature:

1. Go to the **Security** tab of this repository
2. Click **Report a vulnerability**
3. Describe the issue, how to reproduce it, and its impact

This opens a private advisory visible only to maintainers until a fix is ready.

## Scope

In scope:
- Anything that causes the extension to contact a destination other than `api.github.com`, `leetcode.com`, or `geeksforgeeks.org`
- Anything that causes the GitHub token to be sent, logged, or exposed anywhere other than a direct request to `api.github.com`
- Anything that grants access beyond what the user's configured token permissions allow

Out of scope:
- Vulnerabilities in Chrome, GitHub, LeetCode, or GeeksforGeeks themselves — report those to the respective vendor
- Risks from installing a modified or unofficial fork of this extension

## Response

This is an independently maintained open-source project without a dedicated security team. Reports will be acknowledged and investigated on a best-effort basis.
