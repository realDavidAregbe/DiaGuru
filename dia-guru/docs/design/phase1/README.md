# DiaGuru Phase 1 Design Package (iOS-First)

This package implements the "Phase 1 Figma Plan: DiaGuru iOS-First UI Redesign" as a decision-complete, Figma-ready specification.

Scope status:
- Full app coverage: `Auth`, `Home`, `Calendar`, `Profile`, `Settings`
- New UX additions in design scope: `Global quick-add`, `Live Activity`, `Widgets`
- Platform priority: iPhone first (`390x844`)
- Accessibility target: WCAG AA baseline
- Brand direction: evolved blue identity (not full rebrand)

Important limitation:
- This environment does not have direct Figma account/API access, so the output is delivered as a complete build package you can apply 1:1 inside Figma.

## Directory Layout

- `00-foundations.md`: tokens, typography, spacing, radius, elevation, motion, accessibility rules
- `01-components.md`: component library spec and variants
- `02-auth.md`: auth flows and states
- `03-home.md`: home information architecture, all states, and interaction rules
- `04-calendar.md`: event list UX states
- `05-profile.md`: account and Google calendar connection states
- `06-settings.md`: assistant mode, notifications, dev tools
- `07-live-activity-widgets.md`: Lock Screen/Dynamic Island and widget design specs
- `08-prototypes.md`: clickable prototype wiring map
- `09-handoff-specs.md`: engineering handoff, contracts, and phase 2 native notes
- `figma.variables.json`: machine-readable token payload
- `frame-manifest.csv`: full frame inventory with route/state mapping
- `qa-checklist.md`: design QA and implementation QA scenarios

## Build Order in Figma

1. Create pages in this exact order:
   - `00 Foundations`
   - `01 Components`
   - `02 Auth`
   - `03 Home`
   - `04 Calendar`
   - `05 Profile`
   - `06 Settings`
   - `07 Live Activity + Widgets`
   - `08 Prototypes`
   - `09 Handoff Specs`
2. Import tokens from `figma.variables.json` (or create variables manually from `00-foundations.md`).
3. Build components and variants from `01-components.md`.
4. Build screen frames from `frame-manifest.csv` and per-page specs.
5. Wire clickable flows from `08-prototypes.md`.
6. Run checks in `qa-checklist.md`.

## Route Mapping

Current app route mapping used by this package:
- `/(auth)/sign-in` -> Auth page
- `/(tabs)/index` -> Home page
- `/(tabs)/calendar` -> Calendar page
- `/(tabs)/profile` -> Profile page
- `/(tabs)/settings` -> Settings page

## Design Defaults Locked

- One polished direction (no multiple concept exploration in this phase)
- Balanced information density
- Existing 4-tab navigation retained
- Global quick-add available from all tabs
- Live Activity model is current-task progress
- Widget default action opens quick capture sheet

