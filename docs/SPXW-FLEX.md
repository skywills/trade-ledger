# SPXW cash-settlement evidence

SPXW is cash settled. A zero-cash assignment/exercise row can close the option
quantity while leaving the cash payment outside the Trades export. TradeLedger
retains broker realized P&L but withholds reconstruction in that case.

## Activity Flex Query fields

Keep the existing **Trades** export at **Executions** level. Include Account ID,
Currency, Asset Class, Symbol, Conid, Underlying Symbol, Trade ID, IB Execution ID,
IB Order ID, Trade Date, Date/Time, Settle Date Target, Quantity, Multiplier,
Strike, Expiry, Put/Call, Transaction Type, Open/Close Indicator, Notes/Codes,
Trade Price, Proceeds, Net Cash, IB Commission, Taxes, Cost Basis and Realized PNL.
Use explicit Multiplier values; zero-price event rows cannot establish them by
themselves. See [IBKR Trades fields](https://www.ibkrguides.com/reportingreference/reportguide/tradesfq.htm).

Export a **separate companion query** with these evidence sections:

| Section | Fields to select | Purpose |
| --- | --- | --- |
| Statement of Funds | Account ID, Currency, Date, Settle Date, Activity Code, Activity Description, Amount, Debit, Credit, Transaction ID, Trade ID, Trade Quantity, Asset Class, Symbol, Description, Conid, Underlying Conid, Underlying Symbol, Level of Detail | Signed cash payment and identifiers to associate it with an option event. |
| Options, Exercises, Assignments and Expirations | Account ID, Currency, Asset Class, Symbol, Description, Conid, Underlying Conid, Underlying Symbol, Date, Transaction Type, Quantity, Trade Price, Proceeds, Comm/Tax, Basis, Realized P/L, Trade ID | Contract and event evidence, including index-option cash settlement activity. |

IBKR documents option cash settlements under Statement of Funds activity code
`ADJ`. That code also covers other adjustments: require the description and
contract/event identifiers before treating an adjustment as option settlement.
[Statement of Funds reference](https://www.ibkrguides.com/reportingreference/reportguide/statement%20of%20fundsfq.htm).
The exercises section also covers cash settlement for index options.
[Exercises reference](https://www.ibkrguides.com/reportingreference/reportguide/options_exercises_expirations_fq.htm).

Cash Transactions can provide supporting Account ID, Currency, Symbol, Conid,
Date/Time, Amount, Type, Description, Trade ID and Code if the payment appears
there; do not assume that section contains every option settlement.
[Cash Transactions reference](https://www.ibkrguides.com/reportingreference/reportguide/cash%20transactionsfq.htm).

Include the following settlement business days when exporting an expiration
near a reporting-period boundary. Keep all identifiers available in each section.
`Close Price`, `MTM PNL`, a settlement date, or broker P&L alone does not establish
a recorded cash payment. There is no single additional Trades column verified
here that automatically supplies the missing settlement cash.

## Current import limitation

The current parser and lifecycle resolver do **not** ingest and match these
companion cash records. Retain them separately for investigation; uploading a
multi-section query is not currently a supported way to clear the warning.
Cash-settlement support needs section-aware parsing, event matching, duplicate
cash protection and conservation checks before it can reconstruct SPXW P&L.

The warning-detail UI changes do not alter cashflow, broker P&L, estimated
allocations or reconstruction availability.
