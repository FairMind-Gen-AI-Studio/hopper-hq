# Hook payload fixtures

These files are the payloads the scranton-hq mod (`mod/hooks/register.tsx`) posts to `POST /api/hooks`. `batch.json` is one flush as the mod posts it.

They use the field names of Claude Code's settings hooks, so a single mapper reads them. The field sets were checked against Claude Code 2.1.296.

A change to what the mod sends must change these fixtures, the mapper tests and the mod's own tests together.
