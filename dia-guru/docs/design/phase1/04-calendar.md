# 04 Calendar

Route source:
- `/(tabs)/calendar`

## Screen Set

1. `CAL-01 Upcoming List`
2. `CAL-02 Loading`
3. `CAL-03 Empty`
4. `CAL-04 Error`

## Layout

- Section card shell with title and helper text
- Event list container
- Footer action link: `Calendar tips and actions`

## Event Card

Fields:
- Title
- Start/end time
- Optional `DG` badge when event is DiaGuru-created
- Secondary line: `DiaGuru scheduled` when DG

Variants:
- `source:diaguru`
- `source:external`

## States

### List

- Show up to available events from function response.
- Mix DG and external event cards in one list.

### Empty

- Message: `Nothing scheduled in the next few days.`
- Keep footer action visible.

### Error

- Inline error text inside section card.
- Keep retry path via pull-to-refresh.

### Loading

- Activity indicator in event list area.

## Pull To Refresh

Frame: `CAL-05 Refresh`

- Show refresh indicator.
- Existing list remains visible during refresh where possible.

