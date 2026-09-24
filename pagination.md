
Yes — if you have already tried pagination/filtering several times and **Branch Return, Branch Discount, Production Return, and Production Discount still do not apply**, the next prompt should **not ask the agent to “add pagination again.”** It should force the coding agent to find why the existing implementation is being ignored or bypassed.

Use this prompt:

# Agentic Debug + Fix Prompt — Return & Discount Pagination/Filter Not Applying

```text
TASK:
The pagination and filtering implementation for the following pages is NOT actually working:

BRANCH:
- Return Items / Branch Returns
- Discount

PRODUCTION:
- Production Returns
- Production Discount

I have already attempted pagination and filtering multiple times, but the UI still behaves as if the pagination/filter logic is not connected to the actual data source.

DO NOT simply add another pagination component.
DO NOT create another API.
DO NOT create duplicate hooks.
DO NOT create duplicate Supabase queries.

This task is a ROOT-CAUSE DEBUGGING AND FIX task.

The objective is to find exactly why pagination/filter state is not reaching the real data query and fix the existing architecture.
```

## 1. STOP REIMPLEMENTING — TRACE THE REAL DATA FLOW

For EACH affected page, trace the complete flow:

```text
Page UI
 ↓
Filter component
 ↓
React state
 ↓
URL/query params
 ↓
Hook
 ↓
Service/API
 ↓
Server route
 ↓
RPC / Supabase query
 ↓
Database
 ↓
Response
 ↓
Table
 ↓
Pagination
```

Inspect the actual code.

Do not assume the page uses the same architecture as other pages.

Create an internal debugging map:

```text
Branch Return
    UI:
    State:
    Hook:
    API:
    Server:
    Query/RPC:
    Database table:
    Pagination source:
    Filter source:

Branch Discount
    UI:
    State:
    Hook:
    API:
    Server:
    Query/RPC:
    Database table:
    Pagination source:
    Filter source:

Production Return
    UI:
    State:
    Hook:
    API:
    Server:
    Query/RPC:
    Database table:
    Pagination source:
    Filter source:

Production Discount
    UI:
    State:
    Hook:
    API:
    Server:
    Query/RPC:
    Database table:
    Pagination source:
    Filter source:
```

---

# 2. FIND THE ACTUAL REASON IT FAILS

Investigate these possibilities instead of guessing.

### A. Pagination state exists but is unused

Find code like:

```text
page
limit
currentPage
pageSize
```

that changes correctly in React but is never sent to the API.

Example problem:

```text
setPage(2)
```

but API still executes:

```text
GET /returns
```

instead of:

```text
GET /returns?page=2&limit=20
```

Fix the connection.

---

### B. API ignores pagination parameters

Check whether the frontend sends:

```text
page
limit
```

but server ignores them.

Example:

```text
req.query.page
req.query.limit
```

may exist but never be used in the Supabase query.

Fix the server implementation.

---

### C. Supabase query downloads everything

Look for:

```text
supabase
  .from(...)
  .select('*')
```

without pagination.

Fix it using the existing project architecture.

The database must return only the required records.

---

### D. React performs pagination after fetching everything

Find:

```text
data.slice(...)
```

or:

```text
filteredData.slice(...)
```

after the entire database dataset has already been downloaded.

This is NOT acceptable for these pages.

Pagination must happen before the data reaches the client.

---

# 3. FILTER MAY BE CONNECTED TO THE WRONG DATASET

This is especially important for Return and Discount.

Determine exactly where the records originate.

For example:

```text
Branch Return
```

may be generated from:

```text
sales
sale_items
returns
return_items
stock_movements
```

Do NOT assume the correct table.

Likewise Discount may be stored in:

```text
sales
sale_items
discounts
sale_adjustments
```

or another existing structure.

Production Return may use:

```text
production_orders
production_order_items
production_returns
stock_movements
```

The agent must inspect the existing schema and determine the authoritative source.

---

# 4. DO NOT FILTER AFTER PAGINATION

This is a common reason the feature appears broken.

WRONG:

```text
Database
 ↓
LIMIT 20
 ↓
React
 ↓
filter status/date/product
```

This produces incorrect pages.

Correct:

```text
Database
 ↓
Authorization
 ↓
Branch/Production scope
 ↓
Date filter
 ↓
Status filter
 ↓
Product filter
 ↓
Search
 ↓
Sorting
 ↓
COUNT
 ↓
LIMIT/OFFSET or cursor
 ↓
React
```

---

# 5. BRANCH RETURN PAGE

Fix pagination and filtering for Branch Returns.

Required filters should be based on existing functionality, such as:

```text
Search
Return ID
Sale ID
Product
Date
Business Date
Status
Reason
```

If applicable:

```text
Customer
```

Pagination:

```text
20
50
100
```

The selected filter must actually change the database query.

Example:

```text
Return ID = RET-00125
```

must result in the server querying for that return.

It must NOT:

```text
download all returns
filter in React
```

---

# 6. BRANCH DISCOUNT PAGE

Inspect exactly how discounts are stored.

Determine whether discount information belongs to:

```text
sale
sale item
discount record
transaction
```

Then implement filtering against the authoritative source.

Required filters where applicable:

```text
Search
Sale ID
Product
Customer
Date
Business Date
Branch
Discount Type
Discount Amount
```

Pagination:

```text
20
50
100
```

Important:

If the discount is a property of a sale rather than a separate table, do NOT invent a `discounts` table just to make pagination easier.

Query the existing source correctly.

---

# 7. PRODUCTION RETURN PAGE

Inspect the actual Production Return schema and workflow.

Do not confuse:

```text
Branch Return
```

with:

```text
Production Return
```

Production Return filters should use the existing production return data.

Possible filters:

```text
Return ID
Production Order ID
Branch
Product
Date
Business Date
Status
Reason
```

Pagination must be server-side.

Production must only see records permitted by its role/RLS.

---

# 8. PRODUCTION DISCOUNT PAGE

First determine whether Production Discount is:

```text
a real database entity
```

or:

```text
a calculated value from Production Orders
```

If it is calculated:

DO NOT create a fake discount table.

Implement the filter/pagination against the actual production-order/adjustment source.

If it is an existing table:

use that existing table.

The agent must prove which data source is being used before modifying code.

---

# 9. CHECK FOR MOCK / STATIC DATA

Search the four pages for:

```text
mock
dummy
sample
static
hardcoded
const data =
initialData =
```

Also inspect:

```text
JSON files
utils
fixtures
demo data
```

If the table is rendering static/mock data while the filter API is connected to Supabase, pagination will appear broken.

Replace the data source with the existing real API/data source.

Do not introduce new mock data.

---

# 10. CHECK FOR MULTIPLE DATA SOURCES

This is a critical investigation.

A page may have:

```text
Table A
```

rendering from:

```text
filteredItems
```

while pagination operates on:

```text
items
```

or:

```text
paginatedData
```

Find these mismatches.

There must be one clear pipeline:

```text
server response
      ↓
current page data
      ↓
table
```

---

# 11. CHECK FILTER STATE

Verify every filter has:

```text
state
onChange
API parameter
server parameter
database condition
```

Example:

```text
status
```

must flow:

```text
Status Dropdown
 ↓
status state
 ↓
URL/API params
 ↓
server
 ↓
Supabase WHERE
 ↓
filtered response
```

If one link is missing, fix it.

---

# 12. CHECK PAGE RESET

When a filter changes:

```text
page = 1
```

must happen.

Example:

```text
Page 8
 ↓
Select Product = Cream Puff
 ↓
Page automatically becomes 1
 ↓
New filtered query
```

Otherwise the user may see:

```text
No records
```

and think filtering is broken.

---

# 13. CHECK URL PARAMETER NAMES

Make sure frontend and backend use the SAME names.

For example, do not have:

```text
Frontend:
pageSize

Backend:
limit
```

unless there is an explicit mapping.

Likewise:

```text
Frontend:
fromDate

Backend:
start_date
```

must be correctly mapped.

Create one canonical query-parameter contract.

Example:

```text
page
limit
search
status
product_id
branch_id
from
to
sort
order
```

Use the existing project naming convention if already established.

---

# 14. CHECK API REQUESTS IN BROWSER

Use browser/dev tools or the project's API logging to verify:

When user clicks:

```text
Next
```

the network request actually changes:

```text
page=2
```

When user selects:

```text
Status = Returned
```

the request actually contains:

```text
status=returned
```

When user searches:

```text
RET-00125
```

the request contains:

```text
search=RET-00125
```

If the network request does not change, the bug is frontend state/query wiring.

If the request changes but response does not, the bug is server/query handling.

If the response is correct but table does not change, the bug is rendering/state management.

---

# 15. CHECK SERVER QUERY

For every affected endpoint, verify:

```text
authorization
branch scope
filters
search
sorting
count
pagination
```

Correct conceptual query:

```text
SELECT ...
FROM ...
WHERE authorized_scope
AND filters
AND search
ORDER BY ...
LIMIT ...
OFFSET ...
```

Do not perform:

```text
SELECT *
```

and then paginate in JavaScript.

---

# 16. CHECK COUNT QUERY

Pagination needs an accurate total.

The server should return something like:

```text
data
total
page
limit
totalPages
hasNext
hasPrevious
```

Example:

```text
{
  data: [...],
  pagination: {
    page: 2,
    limit: 20,
    total: 137,
    totalPages: 7,
    hasNext: true,
    hasPrevious: true
  }
}
```

The `total` must represent the FILTERED dataset.

Not the complete table.

---

# 17. CRITICAL COUNT BUG TO AVOID

Wrong:

```text
total = all returns
data = filtered returns
```

Correct:

```text
total = filtered returns
data = filtered page
```

For example:

```text
All returns = 5,000

Filter:
Branch A
Status Returned

Matching = 84

Pagination:
20/page
```

must show:

```text
Showing 21–40 of 84
```

not:

```text
Showing 21–40 of 5,000
```

---

# 18. FILTER + PAGINATION + SEARCH MUST WORK TOGETHER

Test combinations, not only individual features.

Examples:

```text
Branch Return:
Product + Date + Search + Page 2

Branch Discount:
Status + Date + Product + Page 3

Production Return:
Branch + Status + Search + Page 2

Production Discount:
Date + Product + Search + Page 2
```

Every combination must be applied to the same server query.

---

# 19. DO NOT BREAK BUSINESS LOGIC

Do NOT change:

```text
Return calculations
Stock calculations
Discount calculations
Sale totals
Production stock
Production order amounts
Branch stock
Business date
```

The task is only to correctly expose existing data through:

```text
filter
search
sort
pagination
```

---

# 20. DO NOT CREATE DUPLICATE API/RPC

Before creating anything, search for existing endpoints such as:

```text
/api/returns
/api/discounts
/api/production/returns
/api/production/discounts
```

and existing RPCs/services.

If an existing endpoint is being used elsewhere, fix it rather than creating:

```text
/api/returns-v2
/api/discounts-new
```

etc.

---

# 21. SUPABASE RLS

Verify:

### Branch

```text
Branch user
→ only own branch returns/discounts
```

### Production

```text
Production
→ authorized production records
```

### Admin

```text
Admin
→ authorized cross-branch access
```

Pagination/filtering must never bypass RLS.

---

# 22. DATABASE INDEXES

After identifying the real queries, inspect indexes.

For frequent filters consider appropriate indexes on existing columns such as:

```text
branch_id
business_date
created_at
status
product_id
sale_id
production_order_id
return_id
```

Do NOT blindly create indexes.

Only add indexes where query patterns justify them.

---

# 23. REMOVE CLIENT-SIDE DUPLICATION

Look for code like:

```text
const filtered = data.filter(...)
const sorted = filtered.sort(...)
const paginated = sorted.slice(...)
```

If `data` is a complete database dataset, remove this approach.

The server should perform:

```text
filter
sort
pagination
```

The React component should primarily render the returned page.

Client-side filtering can remain only for tiny static/reference data where it is intentionally appropriate.

---

# 24. GLOBAL PAGINATION COMPONENT

Reuse the project's global pagination component.

Do not create:

```text
BranchReturnPagination
BranchDiscountPagination
ProductionReturnPagination
ProductionDiscountPagination
```

Use:

```text
Pagination
```

with the same API.

---

# 25. GLOBAL FILTER COMPONENT

Likewise reuse:

```text
SearchInput
DateFilter
StatusFilter
ProductFilter
BranchFilter
FilterBar
MobileFilterDrawer
```

where appropriate.

Do not duplicate filter implementations.

---

# 26. IMPORTANT — VERIFY TABLE IS USING PAGINATED DATA

This is one of the most likely causes of your problem.

Inspect the actual table:

```text
<Table data={...}>
```

Determine exactly what is passed into `data`.

It MUST be the server-returned current page.

For example:

```text
<Table data={result.data} />
```

not:

```text
<Table data={allReturns} />
```

while pagination operates on another variable.

---

# 27. REMOVE OLD CONFLICTING PAGINATION

If there are multiple pagination systems:

```text
API pagination
React pagination
Table-library pagination
manual slice pagination
```

they can conflict.

Choose ONE authoritative pagination layer.

Recommended:

```text
Database/server = pagination authority
UI component = navigation authority
```

Remove or disable conflicting client-side pagination.

---

# 28. DATA FETCH TRIGGER

Changing any of these must trigger the query:

```text
page
limit
search
filter
sort
date
branch
status
product
```

But changing multiple filters together should result in a controlled request, not a request storm.

Use the project's existing query library if available.

---

# 29. RACE CONDITION

Test:

```text
Page 1
 ↓
Page 2
 ↓
Page 3
```

quickly.

Also:

```text
Search A
 ↓
Search AB
 ↓
Search ABC
```

quickly.

Old responses must not replace newer responses.

Use the existing:

```text
AbortController
query cancellation
request ID
```

architecture.

---

# 30. FINAL TEST MATRIX

Do not finish until all four pages pass:

### Branch Return

```text
✓ Default page
✓ Next
✓ Previous
✓ Page number
✓ 20/50/100
✓ Search
✓ Date
✓ Product
✓ Status
✓ Combined filters
✓ Filter + pagination
✓ Reset
✓ URL state
✓ Correct total
```

### Branch Discount

```text
✓ Default page
✓ Next
✓ Previous
✓ Page number
✓ 20/50/100
✓ Search
✓ Date
✓ Product
✓ Status/type
✓ Combined filters
✓ Filter + pagination
✓ Reset
✓ Correct total
```

### Production Return

```text
✓ Default page
✓ Next
✓ Previous
✓ Page number
✓ 20/50/100
✓ Search
✓ Branch
✓ Date
✓ Product
✓ Status
✓ Combined filters
✓ Filter + pagination
✓ Reset
✓ Correct total
```

### Production Discount

```text
✓ Default page
✓ Next
✓ Previous
✓ Page number
✓ 20/50/100
✓ Search
✓ Branch
✓ Date
✓ Product
✓ Status/type
✓ Combined filters
✓ Filter + pagination
✓ Reset
✓ Correct total
```

---

# 31. DEBUGGING ACCEPTANCE CRITERIA

Do not report:

```text
"Pagination implemented"
```

simply because a pagination button exists.

The feature is complete only when:

```text
Click Next
→ network request changes
→ server receives page
→ database query applies page
→ response contains correct records
→ table displays those records
→ total is correct
```

And:

```text
Apply Filter
→ network request changes
→ server receives filter
→ database WHERE applies filter
→ count applies same filter
→ page resets to 1
→ table displays filtered records
→ pagination reflects filtered total
```

---

# 32. FINAL DEBUG REPORT

After fixing, provide a technical report:

```text
PAGE:
Branch Return
ROOT CAUSE:
...

FIX:
...

API:
...

DATABASE QUERY:
...

PAGINATION:
...

FILTERS:
...

PAGE:
Branch Discount
ROOT CAUSE:
...

FIX:
...

PAGE:
Production Return
ROOT CAUSE:
...

FIX:
...

PAGE:
Production Discount
ROOT CAUSE:
...

FIX:
...
```

Also report:

```text
Files changed
APIs changed
RPCs changed
Database indexes changed
Components reused
Hooks changed
RLS changes
Tests performed
```

IMPORTANT:

Do not claim success without testing the actual four pages.

If pagination/filtering still fails after the first fix, continue tracing the data flow until the actual cause is found.

The priority is NOT writing more pagination code.

The priority is:

FIND WHY THE EXISTING PAGINATION/FILTER IS NOT CONNECTED TO THE REAL DATA SOURCE AND FIX THAT CONNECTION.

```

### The key difference

Your previous attempts likely focused on **adding pagination/filter UI**. This prompt tells the coding agent to prove the complete chain:

**Filter button → state → API request → server → Supabase query → filtered count → paginated data → table.**

If one link is broken, simply adding another pagination component will never fix the page.
```
