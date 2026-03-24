# 05 Profile

Route source:
- `/(tabs)/profile`

## Screen Set

1. `PROF-01 Default`
2. `PROF-02 Loading`
3. `PROF-03 Update Saving`
4. `PROF-04 Google Unlinked`
5. `PROF-05 Google Linking`
6. `PROF-06 Google Linked`
7. `PROF-07 Google Status Error`

## Layout

Sections:
1. Account fields
   - Email (read-only)
   - Username
   - Website
   - `Update` action
2. Google Calendar connection card
   - status text
   - primary connect button (when unlinked)
   - refresh connection secondary action
   - error text when needed
3. Session action
   - `Sign Out`

## Google Connection States

### Unlinked

- Primary CTA: `Connect Google Calendar`
- Status line: `Google Calendar: Not linked`

### Checking

- CTA disabled with progress label: `Checking status...`

### Linking

- CTA loading: `Opening browser...`

### Linked

- Outline/success style button label: `Google Calendar Connected`
- Status line: `Google Calendar: Linked`

### Error

- Inline error text under status
- Retry/refresh remains available

## Notes

- Keep this screen practical and low-friction.
- Emphasize link state clearly because Home scheduling depends on this.

