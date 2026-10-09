# MOUNTAIN BAKES — ANDROID + iPHONE RESPONSIVE FIX

You are a senior frontend engineer and mobile web compatibility specialist.

The existing **Mountain Bakes web application works properly on Android mobile devices but does not work correctly on Apple iPhone/iOS mobile devices**.

Your task is to inspect the existing project, identify the actual cause, and make the web application fully responsive and functional on:

* Android phones
* iPhone / iOS Safari
* iPad
* Android tablets
* Desktop browsers

The existing Android functionality must NOT be broken while fixing iPhone compatibility.

---

## 1. FIRST — INSPECT THE EXISTING PROJECT

Do NOT immediately rewrite the frontend.

First inspect:

```text
package.json
src/
app/
components/
pages/
public/
styles/
globals.css
tailwind configuration
next.config.*
middleware
authentication
API client
PWA configuration
manifest
service worker
viewport configuration
responsive CSS
```

Also identify:

```text
React / Next.js version
Browser APIs being used
Authentication implementation
LocalStorage usage
Session storage
Cookies
IndexedDB
Service workers
PWA code
Touch handlers
Navigation
Modal components
Dropdown components
Tables
Forms
Date/time controls
File upload
Image handling
Print functionality
```

Create:

```text
docs/ios-compatibility-audit.md
```

Document:

1. Why Android works.
2. Why iPhone currently fails.
3. Which components are affected.
4. Which browser APIs are incompatible.
5. Which CSS causes problems.
6. Which JavaScript causes problems.
7. Which authentication/session behavior causes problems.
8. Which PWA/service-worker behavior causes problems.
9. Which fixes are required.

Do not guess the cause.

---

# 2. iPHONE / SAFARI COMPATIBILITY

Test specifically against modern iOS Safari behavior.

Check for problems involving:

```text
Safari
WebKit
iOS viewport
Safe areas
100vh
100svh
100dvh
position: fixed
position: sticky
overflow
touch scrolling
keyboard
input focus
select controls
date inputs
file inputs
backdrop-filter
CSS transforms
z-index
stacking contexts
hover-only interactions
pointer events
touch events
```

Do not use desktop-browser assumptions.

---

# 3. VIEWPORT — CRITICAL

Make sure the application has a correct viewport configuration.

Verify:

```html
<meta
  name="viewport"
  content="width=device-width, initial-scale=1, viewport-fit=cover"
/>
```

Use the correct implementation for the existing Next.js version.

Do not add duplicate viewport declarations.

Check that users cannot accidentally receive:

```text
desktop-width page scaled down on iPhone
horizontal page overflow
incorrect zoom
tiny UI
clipped content
```

---

# 4. SAFE AREA SUPPORT

iPhones can have:

* notch
* Dynamic Island
* home indicator
* rounded screen corners

The application must support safe areas.

Use CSS such as:

```css
env(safe-area-inset-top)
env(safe-area-inset-right)
env(safe-area-inset-bottom)
env(safe-area-inset-left)
```

Where appropriate.

Especially check:

```text
top header
bottom navigation
drawer
modal
login screen
fixed buttons
sticky elements
mobile action bars
```

Nothing should be hidden behind the iPhone home indicator or Dynamic Island.

---

# 5. HEIGHT FIXES

Search the entire project for problematic patterns such as:

```css
height: 100vh;
min-height: 100vh;
height: 100%;
```

Do not blindly replace all of them.

For mobile layouts, evaluate:

```css
100svh
100lvh
100dvh
```

Use the appropriate viewport unit for each situation.

Avoid the classic iOS Safari problem where:

```text
100vh
```

does not represent the visible viewport correctly when the Safari address bar expands/collapses.

The app must remain usable while scrolling on iPhone.

---

# 6. HORIZONTAL OVERFLOW

This is critical.

Check every major page for:

```text
horizontal scrolling
content wider than viewport
tables wider than screen
cards wider than screen
buttons extending outside screen
modal wider than screen
navigation wider than screen
forms wider than screen
```

Test at minimum:

```text
320px
360px
375px
390px
393px
414px
430px
768px
1024px
```

The page should never unexpectedly create horizontal page scrolling.

Do not solve everything with:

```css
overflow-x: hidden;
```

because that can hide real layout bugs.

Fix the underlying width problem.

---

# 7. RESPONSIVE BREAKPOINTS

Review all breakpoints.

Make sure they support:

```text
Small iPhone
Normal iPhone
Large iPhone
Android phone
Tablet
Desktop
Large desktop
```

Do not design only around one Android screen size.

Use responsive layouts rather than fixed widths.

The existing project requirement is to support small Android phones, large Android phones, tablets, iPhones and iPads.

---

# 8. TOUCH INTERACTION

iPhone must not depend on mouse hover.

Find interactions such as:

```text
:hover
mouseenter
mouseleave
mouseover
```

Ensure important functionality also works with touch.

Verify:

```text
buttons
dropdowns
menus
tabs
cards
table actions
edit buttons
delete buttons
view buttons
search
filters
date selectors
modals
drawer
navigation
```

Touch targets should generally be comfortable for finger interaction.

Avoid tiny clickable controls.

---

# 9. iOS INPUTS AND FORMS

Test every form on iPhone.

Especially:

```text
text input
number input
password input
search input
date input
time input
select
textarea
file upload
```

Fix:

```text
input zoom
keyboard covering fields
incorrect input types
cursor problems
text clipping
buttons hidden by keyboard
modal scrolling problems
```

Important:

When an input receives focus, the user must be able to see the field above the iOS keyboard.

Do not allow the keyboard to cover:

```text
Submit
Save
Login
Confirm
Cancel
```

buttons.

---

# 10. FONT SIZE / iOS AUTO-ZOOM

Check for iPhone Safari automatic input zoom.

Avoid situations where form controls unexpectedly zoom the page.

Use an appropriate minimum font size for inputs where necessary.

Do not make text unnecessarily huge just to prevent zoom.

Maintain the Mountain Bakes visual design.

---

# 11. MODALS

Audit every modal.

iOS Safari commonly exposes issues with:

```text
position: fixed
height: 100vh
overflow: hidden
keyboard
touch scrolling
z-index
```

Make modals work correctly on iPhone.

Requirements:

```text
modal fits viewport
modal content scrolls
background does not unexpectedly scroll
keyboard does not hide inputs
close button remains accessible
safe-area padding works
```

Test:

```text
Login modal
Sale modal
Order modal
Expense modal
Stock modal
Product modal
Production modal
Help Desk modal
Query modal
Print preview
Confirmation dialogs
```

---

# 12. DRAWER / SIDE MENU

Verify the mobile drawer.

It must:

```text
open with touch
close with touch
support swipe where implemented
not extend beyond screen
not become wider than viewport
respect safe areas
scroll correctly
not lock the page permanently
```

Check:

```text
Admin
Branch
Production
Finance
```

navigation separately.

---

# 13. BOTTOM NAVIGATION

If the web application has mobile bottom navigation, make it iPhone safe-area aware.

Use appropriate bottom padding such as:

```css
padding-bottom: env(safe-area-inset-bottom);
```

The last navigation item must not be hidden behind the iPhone home indicator.

Verify:

```text
Home
Orders
Sales
Stock
More
```

and other role-specific navigation.

---

# 14. TABLES

The Mountain Bakes application contains many business tables.

Do NOT simply shrink desktop tables until they become unreadable.

For mobile use:

```text
responsive cards
horizontal scrolling where appropriate
expandable rows
compact rows
detail screens
```

The existing mobile specification also requires mobile-friendly cards/expandable rows/horizontal scrolling rather than blindly copying desktop tables.

Check:

```text
Admin tables
Branch tables
Production tables
Finance tables
Sales
Stock
Expenses
Orders
Products
Reports
```

---

# 15. PWA / INSTALLATION

If Mountain Bakes is configured as a PWA, inspect:

```text
manifest
service worker
icons
display mode
start_url
scope
theme_color
background_color
```

Ensure the application does not behave differently or break when opened from:

```text
Safari
Home Screen
PWA standalone mode
```

Do not assume Android PWA behavior automatically works on iOS.

If an iOS-specific limitation exists, implement an appropriate fallback.

---

# 16. LOCAL STORAGE / COOKIES / SESSION

Audit authentication and persistence.

Check:

```text
localStorage
sessionStorage
cookies
Secure
SameSite
HttpOnly
credentials
token refresh
session restoration
```

Make sure login/session behavior works correctly in iOS Safari.

Test:

```text
fresh iPhone browser
logged-in session
page refresh
browser restart
Home Screen/PWA launch
expired session
logout
login again
```

Do not weaken authentication/security just to make iPhone work.

---

# 17. API / CORS

Verify that iPhone Safari can successfully communicate with the existing API.

Check:

```text
HTTPS
CORS
cookies
credentials
authorization headers
preflight requests
redirects
mixed content
```

Do not modify CORS broadly with insecure settings.

The existing Mountain Bakes backend must remain authoritative. The mobile architecture specification requires clients to use the existing server/business logic rather than duplicating backend logic.

---

# 18. DATE / TIME

Check every date/time feature on iPhone.

Do not assume Android and iOS parse arbitrary date strings identically.

Search for:

```javascript
new Date("...")
Date.parse(...)
```

and other fragile date parsing.

Use explicit, reliable date handling.

Test:

```text
sales
orders
expenses
production
reports
filters
business date
timestamps
```

Preserve the existing Mountain Bakes business-date rules.

Do not change business logic.

---

# 19. FILE UPLOAD / CAMERA

If the web application supports:

```text
image upload
camera
document upload
product image
profile image
```

test them on iPhone Safari.

Verify:

```text
file picker opens
camera option works where supported
image preview works
upload succeeds
large images are handled
```

Do not break Android upload behavior.

---

# 20. PRINTING

Audit print functionality.

iPhone Safari handles printing differently from desktop.

Make sure:

```text
print preview
invoice
production print
customer copy
company copy
```

remain usable.

If direct browser printing is limited by iOS, provide a graceful share/print workflow instead of breaking the page.

Do not remove existing print functionality.

---

# 21. CSS COMPATIBILITY AUDIT

Search the project for potentially problematic CSS.

Review:

```text
-webkit-
backdrop-filter
appearance
user-select
touch-action
overscroll-behavior
position: fixed
position: sticky
100vh
calc()
transform
translate
overflow
z-index
```

Do not remove modern CSS unnecessarily.

Only change CSS where there is a real compatibility/layout issue.

---

# 22. SAFARI-SPECIFIC BUGS

Search for code that assumes:

```text
Chrome only
Android only
mouse only
hover only
desktop viewport
Android WebView
```

Remove those assumptions.

The application should behave consistently across:

```text
Chrome Android
Safari iPhone
Safari iPad
Chrome desktop
Safari macOS
```

---

# 23. PERFORMANCE

Do not solve responsiveness by adding excessive JavaScript.

Keep the app fast.

The existing Mountain Bakes architecture emphasizes fast startup, smooth scrolling, responsive forms, quick product search, minimal unnecessary renders and efficient data loading.

Check:

```text
initial load
login
dashboard
navigation
tables
search
modals
forms
images
charts
API requests
```

Avoid unnecessary rerenders.

---

# 24. NO SCREEN FLASH / FLICKER

Fix:

```text
white flash
layout flash
authentication flash
desktop-to-mobile flash
theme flash
loading flicker
navigation flicker
```

Especially on iPhone.

The user should not see:

```text
Desktop UI
↓
Mobile UI
```

during initial rendering.

Determine responsive layout correctly as early as possible.

---

# 25. AUTHENTICATION FLASH

The application must not briefly display the wrong role/page.

Correct flow:

```text
Application starts
      ↓
Restore session
      ↓
Determine authentication
      ↓
Determine role
      ↓
Load correct responsive shell
      ↓
Show application
```

Do not render:

```text
Admin
```

briefly for a Branch user.

---

# 26. MOBILE RESPONSIVE DESIGN RULE

Every existing page must be reviewed individually.

Do not say:

> "The CSS is already responsive."

Actually inspect and test:

```text
Login
Dashboard
Users
Products
Categories
Vendors
Orders
Sales
Stock
Expenses
Reports
Settings
Production
Finance
Help Desk
Support Center
Queries
Print Preview
Forms
Modals
```

---

# 27. TEST MATRIX

Test the application using this matrix:

| Device         | Browser                        |
| -------------- | ------------------------------ |
| Android phone  | Chrome                         |
| Android phone  | Samsung Internet if applicable |
| iPhone         | Safari                         |
| iPhone         | Chrome iOS                     |
| iPad           | Safari                         |
| Android tablet | Chrome                         |
| Desktop        | Chrome                         |
| Desktop        | Safari                         |
| Desktop        | Edge                           |

Pay particular attention to:

```text
iPhone Safari
iPad Safari
```

because the current reported problem is Apple mobile compatibility.

---

# 28. SCREEN-SIZE TESTING

At minimum test:

```text
320 × 568
375 × 667
390 × 844
393 × 852
414 × 896
430 × 932
768 × 1024
1024 × 1366
1280 × 720
1440 × 900
```

Check:

```text
No horizontal overflow
No clipped text
No clipped buttons
No hidden navigation
No modal overflow
No keyboard obstruction
No unsafe bottom navigation
No broken charts
No broken tables
```

---

# 29. DO NOT BREAK EXISTING BUSINESS LOGIC

Do NOT modify:

```text
products
prices
price history
sales
stock
expenses
orders
production
reports
branches
roles
permissions
authentication
```

unless a change is specifically required for browser compatibility.

The project architecture explicitly requires preserving existing backend behavior and data integrity.

If a backend issue is discovered, document it separately instead of creating a frontend workaround that corrupts business behavior.

---

# 30. IMPLEMENTATION PROCESS

Follow this exact sequence:

```text
1. Inspect
2. Reproduce iPhone problem
3. Identify root cause
4. Document root cause
5. Fix smallest correct layer
6. Test Android
7. Test iPhone
8. Test iPad
9. Test desktop
10. Check authentication
11. Check API
12. Check PWA
13. Check forms
14. Check navigation
15. Check tables
16. Check modals
17. Check printing
18. Check performance
19. Run production build
20. Final regression test
```

Do not rewrite the entire application.

---

# 31. IMPORTANT — DO NOT USE A FAKE FIX

Do NOT simply add:

```css
overflow-x: hidden;
```

or:

```css
-webkit-overflow-scrolling: touch;
```

and declare the problem fixed.

Find the actual problem.

Do not add random Safari hacks without understanding their effect.

---

# 32. FINAL ACCEPTANCE CRITERIA

The task is complete only when:

```text
[ ] Android still works
[ ] iPhone Safari works
[ ] iPhone Chrome works
[ ] iPad Safari works
[ ] Android tablet works
[ ] Desktop Chrome works
[ ] Desktop Safari works
[ ] Desktop Edge works

[ ] Login works
[ ] Logout works
[ ] Session persistence works
[ ] Role detection works
[ ] Dashboard works
[ ] Navigation works
[ ] Drawer works
[ ] Bottom navigation works
[ ] Forms work
[ ] Keyboard does not hide controls
[ ] Modals work
[ ] Tables work
[ ] Search works
[ ] Filters work
[ ] Date/time controls work
[ ] API requests work
[ ] Authentication works
[ ] PWA works if enabled
[ ] File upload works where supported
[ ] Printing/share works where supported
[ ] No horizontal overflow
[ ] No screen flicker
[ ] No layout flash
[ ] Safe areas work
[ ] Notch/Dynamic Island works
[ ] Home indicator does not cover controls
[ ] Dark mode works
[ ] Loading states work
[ ] Error states work
[ ] Empty states work
```

---

# 33. FINAL REPORT

At completion create:

```text
docs/ios-compatibility-fix-report.md
```

Include:

```text
1. Original iPhone problem
2. Root cause
3. Files changed
4. CSS changes
5. JavaScript changes
6. Authentication changes
7. PWA changes
8. Safari-specific fixes
9. Responsive improvements
10. Android regression testing
11. iPhone testing
12. iPad testing
13. Remaining limitations
```

For every modified file:

```text
File:
Change:
Reason:
iOS issue solved:
Android regression risk:
```

Do not claim iPhone compatibility without actually testing the relevant code paths.

## FINAL GOAL

The Mountain Bakes web application must provide the same business functionality on Android and Apple mobile devices.

The final experience should be:

```text
             MOUNTAIN BAKES WEB
                    │
        ┌───────────┴───────────┐
        │                       │
        ↓                       ↓
   ANDROID MOBILE          APPLE iPHONE
        │                       │
      Chrome                  Safari
        │                       │
        └───────────┬───────────┘
                    ↓
          SAME RESPONSIVE UI
                    ↓
          SAME MOUNTAIN BAKES
           BUSINESS LOGIC
```

Do not create a separate Apple version.

Make the existing Mountain Bakes web application genuinely cross-platform responsive and compatible with iOS Safari.
