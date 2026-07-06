# USE Tax Extraction Intelligence Layer

An AI-powered extraction intelligence layer over **SAP Document AI**, using **Claude (via SAP AI Core Generative AI Hub)** to verify, correct, and explain extracted invoice fields - raising accuracy on the invoices that matter most, at controlled cost.

Built as an enhancement to the *Agentic AI: US USE Tax Validation and Reconciliation* process.

## The problem

SAP Document AI extracts invoice fields at roughly 75-85% accuracy. The remaining 15-25% - wrong ship-to addresses, mis-read amounts, leaked PO/tax lines, multi-page column drift - is where cost lives: a wrong ship-to jurisdiction drives a wrong USE-tax calculation and audit exposure. This layer targets that slice without paying a premium engine to redo what Doc AI already gets right.

## Architecture - best of both worlds

Document AI is the workhorse (100% of invoices, fast cheap OCR). A confidence gate sends only the risky ~20% to Claude for verification. You spend the premium engine exactly where error is expensive.

Invoice -> Doc AI indexing (auto-classify) -> Doc AI routed extraction (with confidence) -> confidence gate (tax-critical field < 85%?) -> if NO: auto-verify, Doc AI cost only; if YES: Claude verifies/corrects/explains -> audit-ready extraction -> Vertex tax -> reconciliation.

## Cost model

SAP Document AI runs on 100% of invoices (~0.01-0.03/page). Claude runs on ~15-25% triggered only (~0.015/invoice). Because ~75-80% never trigger Claude, added spend at 25,000 invoices/year is a few hundred dollars - negligible against analyst time saved and audit risk retired.

## CAPM line-item logic

Construction: consolidate to one line 'Non-Residential building construction services'; amount = sum of eligible current-period items (SWORN where present); gross = workCompletedThisPeriodTotal.

Non-construction: list items where netPrice != 0; distribute freight proportionally (taxableBase = netPrice + allocatedFreight); suppress tax lines.

## Setup

1. npm install
2. Copy .env.example to .env and fill in SAP AI Core + Document AI credentials and schema IDs.
3. cds watch
4. Open http://localhost:4004/intelligence/index.html

Tech: SAP CAP (Node.js), SAP AI Core Generative AI Hub (Claude), SAP Document Information Extraction, pdf-parse, form-data.
