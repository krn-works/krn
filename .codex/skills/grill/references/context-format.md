# CONTEXT.md Format

Use `CONTEXT.md` for domain language only.

## Single Context

```md
# <Context Name>

<One or two sentences describing what this context is and why it exists.>

## Language

**Order**:
<One or two sentences defining the term.>
_Avoid_: Purchase, transaction

**Customer**:
<One or two sentences defining the term.>
_Avoid_: Client, account

## Flagged Ambiguities

**Account**:
Resolved as **User** when discussing authentication and **Customer** when discussing billing.

## Example Dialogue

Dev: "Can a Customer have multiple Orders?"
Domain expert: "Yes. A Customer can place many Orders, but each Order has exactly one Customer."
```

## Multi-Context

When multiple bounded contexts exist, create a root `CONTEXT-MAP.md`:

```md
# Context Map

## Contexts

- [Ordering](./src/ordering/CONTEXT.md) - receives and tracks customer orders
- [Billing](./src/billing/CONTEXT.md) - generates invoices and payments

## Relationships

- **Ordering -> Billing**: Ordering emits `OrderPlaced`; Billing consumes it to generate invoices.
```

## Rules

- Pick one canonical term and list aliases to avoid.
- Keep definitions short.
- Define what the concept is, not how code implements it.
- Include relationships and cardinality when it clarifies the term.
- Add implementation details to specs or ADRs, not to `CONTEXT.md`.
