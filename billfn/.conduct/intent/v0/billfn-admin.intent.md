
- Plans management
- Payments management
- Configuration management
- Invoicing
- Dashboard and revenue analytics
- Credits and coupons

- Should use `@superfunctions/http` for exposing API endpoints like other super functions. This will be used by the Admin client app to interact with the admin billfn server.
- Should use `@superfunctions/db` for storing data like other super functions and `@billfn/server` for storing billfn data.


# Plans management
- Create, edit, delete plans and pricing
- Corresponding plans in payment providers will be updated on updates here in admin SDK or from admin UI
  - Ex: Dodo payments provider - plans in billfn will correspond to products in Dodo payments


# v0 Scope
- Plans management