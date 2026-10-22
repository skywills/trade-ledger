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

TradeLedger accepts **Trades only**, or **Trades plus Statement of Funds** in one
CSV. A separate Statement of Funds companion CSV is also supported. Ordinary
BUY/SELL cash movements are retained as evidence and never counted as additional
executions or cash. Only explicit, uniquely matched option settlement adjustments
are applied to the corresponding option close.

Select these fields when exporting supporting evidence:

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

## Matching and incomplete evidence

Statement of Funds cash settlement requires Account ID, **Currency**, Date,
Activity Code `ADJ`, an Activity Description naming Assignment/Exercise and the
exact option contract, and a signed Amount or Debit/Credit. Date is the event
date; Settle Date may follow it. Contract identifiers and Trade Quantity, when
provided, must agree with the event. Matching cannot use broker P&L or marks to
invent cash. The original rows remain available through source links.

Currency is required on the **cash section itself**. A currency in the Trades
section does not establish the currency of a separate payment. Missing currency,
conflicting evidence, duplicate payments, or multiple matching events remain
warnings; recorded broker P&L stays available and reconstruction remains null
for events without established settlement treatment. Malformed cash evidence
does not quarantine otherwise valid trades.

Repeated cash evidence from different files is corroborated only when its
Transaction ID and financial details agree. Repeated identical files remain
idempotent. Overlapping cash reports without payment IDs remain ambiguous; exclude
the redundant import instead of assuming two rows are one payment. Likewise,
replacing an existing combined trade report may require excluding the old report
when option events lack strong execution identities. A cash-only companion avoids
duplicating those weak trade rows.

Other cash activities and the Options/Exercises section are supporting exports
for investigation; they are not an alternative settlement ingestion format in
this implementation. After updating an older installation, run a **full rebuild**
so retained Statement of Funds rows are reclassified and matched.

Broker P&L and option quantities are not changed by settlement matching. Explicit
payment cash is included once in normalized cashflow and its source is attached
to the option event. A payment already present on the close is corroborated
without adding it again; a different existing cash value requires review.
