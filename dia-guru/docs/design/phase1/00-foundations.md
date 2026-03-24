# 00 Foundations

This page defines all visual tokens and system rules for Phase 1.

## Frame Baseline

- Base artboard: `390x844` (iPhone 13/14/15 logical size)
- Content safe area:
  - Top inset token: `safe.top = 16` + device inset
  - Bottom inset token: `safe.bottom = 16` + device inset
- Default canvas color: `Neutral/SurfaceCanvas`

## Color Tokens

### Primary (Blue DNA)

- `Primary/50 = #EFF6FF`
- `Primary/100 = #DBEAFE`
- `Primary/200 = #BFDBFE`
- `Primary/300 = #93C5FD`
- `Primary/400 = #60A5FA`
- `Primary/500 = #3B82F6`
- `Primary/600 = #2563EB`
- `Primary/700 = #1D4ED8`
- `Primary/800 = #1E40AF`
- `Primary/900 = #1E3A8A`

### Neutral

- `Neutral/0 = #FFFFFF`
- `Neutral/50 = #F9FAFB`
- `Neutral/100 = #F3F4F6`
- `Neutral/200 = #E5E7EB`
- `Neutral/300 = #D1D5DB`
- `Neutral/400 = #9CA3AF`
- `Neutral/500 = #6B7280`
- `Neutral/600 = #4B5563`
- `Neutral/700 = #374151`
- `Neutral/800 = #1F2937`
- `Neutral/900 = #111827`

### Semantic

- `Success/50 = #ECFDF5`
- `Success/600 = #059669`
- `Warning/50 = #FEF3C7`
- `Warning/700 = #B45309`
- `Error/50 = #FEE2E2`
- `Error/700 = #B91C1C`
- `Info/50 = #EEF2FF`
- `Info/700 = #4338CA`

### Semantic Usage Tokens

- `BG/Canvas = Neutral/100`
- `BG/Surface = Neutral/0`
- `BG/Muted = Neutral/50`
- `Text/Primary = Neutral/900`
- `Text/Secondary = Neutral/600`
- `Text/Muted = Neutral/500`
- `Text/OnPrimary = Neutral/0`
- `Border/Subtle = Neutral/200`
- `Border/Strong = Neutral/300`
- `Action/Primary = Primary/600`
- `Action/PrimaryPressed = Primary/700`
- `Action/SecondaryText = Primary/600`
- `Status/ErrorBG = Error/50`
- `Status/ErrorText = Error/700`
- `Status/WarningBG = Warning/50`
- `Status/WarningText = Warning/700`

## Typography

Font families:
- Heading font: `Sora`
- Body/UI font: `Source Sans 3`

Type scale:
- `Type/Display`: Sora 700, 32/38
- `Type/H1`: Sora 700, 28/34
- `Type/H2`: Sora 700, 24/30
- `Type/H3`: Sora 600, 20/26
- `Type/Section`: Source Sans 3 700, 20/26
- `Type/CardTitle`: Source Sans 3 600, 16/22
- `Type/Body`: Source Sans 3 400, 16/24
- `Type/BodyStrong`: Source Sans 3 600, 16/24
- `Type/Meta`: Source Sans 3 400, 14/20
- `Type/Caption`: Source Sans 3 400, 12/16
- `Type/Button`: Source Sans 3 700, 16/20
- `Type/Chip`: Source Sans 3 600, 14/18

## Spacing (4pt Grid)

- `Space/0 = 0`
- `Space/1 = 4`
- `Space/2 = 8`
- `Space/3 = 12`
- `Space/4 = 16`
- `Space/5 = 20`
- `Space/6 = 24`
- `Space/8 = 32`
- `Space/10 = 40`

Layout defaults:
- Screen horizontal padding: `16`
- Card internal padding: `16`
- Vertical section gap: `24`
- In-card content gap: `12`

## Radius

- `Radius/XS = 8`
- `Radius/SM = 10`
- `Radius/MD = 12`
- `Radius/LG = 16`
- `Radius/XL = 20`
- `Radius/Pill = 999`

## Border + Elevation

- `Border/Hairline = 1`
- `Shadow/01`: y=1 blur=2 alpha=0.08
- `Shadow/02`: y=4 blur=12 alpha=0.10
- `Shadow/03`: y=8 blur=20 alpha=0.12

Usage:
- Cards: `Shadow/01`
- Modal sheets: `Shadow/03`
- Floating quick-add button: `Shadow/02`

## Motion

Timing:
- `Motion/Fast = 160ms`
- `Motion/Base = 220ms`
- `Motion/Slow = 320ms`

Easing:
- Standard: `ease-out`
- Emphasized entry: `cubic-bezier(0.2, 0.8, 0.2, 1)`

Applied interactions:
- Bottom-sheet in/out
- Modal fade + content lift
- Quick-add expansion
- Live progress indicator updates

## Iconography

- Primary icon style: rounded line icons matching Material semantics already used in app
- Tab icon size: `24`
- Inline icon size: `16`
- Badge icon size: `12`

## Accessibility Baseline (WCAG AA)

- Normal text contrast >= 4.5:1
- Large text contrast >= 3:1
- Minimum interactive target: `44x44`
- Do not rely on color-only status messaging
- All status banners include title + body + action
- Preserve layout integrity at larger text scaling

## Figma Variable Collections

Create these collections:
- `Color`
- `Typography`
- `Spacing`
- `Radius`
- `Elevation`
- `Motion`

Bind tokens to components before building screens.

