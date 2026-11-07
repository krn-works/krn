# Merge response fixtures

Receiver examples copied verbatim as JSON values from GitHub documentation,
[Merge a pull request](https://docs.github.com/en/rest/pulls/pulls#merge-a-pull-request),
and its [OpenAPI source](https://github.com/github/rest-api-description/blob/main/descriptions/api.github.com/api.github.com.json),
`paths./repos/{owner}/{repo}/pulls/{pull_number}/merge.put.responses`.
The 200 example resolves `components.examples.pull-request-merge-result-response-if-merge-was-successful`;
405 and 409 use their inline response examples. Only whitespace is formatted.

The fake receiver substitutes a real fixture commit SHA for the example SHA
in successful integration responses. Transport errors and other HTTP statuses
are synthetic scenarios, not documented receiver samples.
The lead owns live receiver proof with the first real merge after installation.
