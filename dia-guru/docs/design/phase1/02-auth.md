# 02 Auth

Route source:
- `/(auth)/sign-in`

## Screen Set

1. `AUTH-01 Sign In` (default)
2. `AUTH-02 Sign In Loading`
3. `AUTH-03 Sign In Error`
4. `AUTH-04 Sign Up` (same shell, alternate CTA emphasis)
5. `AUTH-05 Email Verification Notice`
6. `AUTH-06 Auth Gate Loading`

## Layout

- Header block:
  - App mark
  - Title: "Plan your day before it plans you"
  - Subtitle: capture + auto-schedule value statement for students
- Form block:
  - Email field
  - Password field
  - Primary action: `Sign in`
  - Secondary action: `Create account`
- Footer helper:
  - "By continuing you agree to ..."

## States

### Default

- Empty fields
- Primary button enabled only when both fields have text

### Loading

- Primary button `loading`
- Inputs disabled

### Error

- Inline error banner above actions
- Field-level errors when available

### Email Verification

- Info state card:
  - Title: "Check your inbox"
  - Body: verification reminder
  - Action: `I verified, continue`

## Prototype Links

- `AUTH-01 Sign In` -> success -> `HOME-01`
- `AUTH-01` -> `Create account` -> `AUTH-04`
- `AUTH-04` -> success without session -> `AUTH-05`
- `AUTH-05` -> continue -> `HOME-01`

## Copy Baseline

- Email placeholder: `email@address.com`
- Password placeholder: `Password`
- Sign in CTA: `Sign in`
- Sign up CTA: `Sign up`

