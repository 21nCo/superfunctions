# Glossary

- Plan
  - Add-on
- Customer
- Subscription
- Quota
- Feature
- Usage
- Payment
  - Invoice
  - Line item
- Environment
  - Sandbox
  - Production

## Plan
- A Plan is a configuration against which a customer can subscribe to.
- It contains the pricing and features of the plan.
- It can have different billing cycle options like monthly, yearly, etc.
- It can optionally have add-ons associated with it.


## Customer
- A Customer is an entity that can subscribe to a plan.
- It contains the customer details like name, email, etc.
- It can have different payment methods associated with it.

## Subscription
- A Subscription is an entity that represents a customer's subscription to a plan.
- It contains the subscription details like start date, end date, status, etc.
- It will be associated with corresponding payments made by the customer.



--------------------
# Methods
# billfn.plans, billfn.addons

## .list(), .get()
- client apps via server SDK exposed API endpoint
- server SDK method
- admin apps via admin SDK exposed API endpoint
- admin SDK method

## .create(), .update()
- admin apps via admin SDK exposed API endpoint
- admin SDK method


# billfn.subscriptions
  - .create
  - .get
  - .update
  - .cancel
  - .resume
  - .list


## .getByCustomerId()
- Retrieves subscriptions for a customer by customer id

### Access
- client apps via server SDK exposed API endpoint
- server SDK method
- admin apps via admin SDK exposed API endpoint
- admin SDK method

## .create(), .update()



# billfn.quotas
  - .check
  - .record
  - .get


# billfn.features
  - .has
  - .get

# billfn.usage
  - .get
  - .record
  - .list

# billfn.invoices
  - .create
  - .get
  - .list
  - .update
  - .cancel
  - .resume
  - .list