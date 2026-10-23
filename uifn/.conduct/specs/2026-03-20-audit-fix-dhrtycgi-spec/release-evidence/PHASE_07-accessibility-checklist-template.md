# PHASE_07 Manual Accessibility Checklist Template

Use this checklist for release-candidate manual verification.

## Metadata

- Date (UTC):
- Verifier:
- Environment:
  - Browser:
  - OS:
  - Assistive tech:
- Build under test:

## Keyboard-Only Verification

| Family | Scenario | Expected Result | Pass/Fail | Notes |
| --- | --- | --- | --- | --- |
| Dialog / AlertDialog | Open from trigger, cycle focus, close with `Escape` | Focus enters dialog, remains trapped while open, returns to trigger on close |  |  |
| Select | Open, arrow navigation, select item, close | Highlight and selection move predictably; selected value is announced/rendered |  |  |
| Combobox | Type to filter, arrow to highlight, enter to select, escape to dismiss | Filter + highlight + selection flow is deterministic |  |  |
| Toast / Status | Trigger toast, navigate action/close controls by keyboard | Interactive controls are reachable and operable by keyboard |  |  |
| Collection (Accordion/Tabs) | Arrow/Home/End navigation | Focus and active state follow documented keyboard contract |  |  |
| Menu (Dropdown/MenuBar/ContextMenu) | Open menu, arrow navigation, escape close | Menu focus/navigation follows ARIA menu patterns |  |  |

## Screen-Reader Verification

| Family | Scenario | Expected Announcement/Behavior | Pass/Fail | Notes |
| --- | --- | --- | --- | --- |
| Dialog / AlertDialog | Open modal dialog | Dialog role, title, and description are announced; focus context is clear |  |  |
| Select | Open list and move highlighted option | Current option/value is announced with state and grouping context |  |  |
| Combobox | Type/filter and move highlight | Input + popup relationship and highlighted option are announced |  |  |
| Toast / Status | Show toast and action controls | Status update and available actions are announced appropriately |  |  |

## Sign-off

- Keyboard gate: PASS / FAIL
- Screen-reader gate: PASS / FAIL
- Overall manual accessibility gate: PASS / FAIL
- Follow-up actions (if any):
