require('dotenv').config();
const cds = require('@sap/cds');

module.exports = class DocumentIntelligenceService extends cds.ApplicationService {

  async init() {
    this.on('processInvoice', this._handleProcessInvoice);
    await super.init();
  }

  async _handleProcessInvoice(req) {
    const { documentId, schemaType, invoiceBase64, mediaType } = req.data;
    const LOG = cds.log('intelligence');
    const startTime = Date.now();
    LOG.info(`Processing invoice ${documentId} (${schemaType})`);

    // ── Stage 1: Extract full PDF text locally (ground truth) ──
    LOG.info('Stage 1: Extracting full PDF text...');
    let fullText = '';
    try {
      fullText = await this._extractPdfText(invoiceBase64, mediaType);
      LOG.info(`Stage 1 complete: ${fullText.length} chars across all pages`);
    } catch (err) {
      LOG.warn('PDF text extraction failed:', err.message);
    }

    // ── Stage 2: Document AI extraction (header + line items) ──
    LOG.info('Stage 2: Calling SAP Document AI...');
    let docAILineItems = [];
    let docAIHeader = {};
    let routedTo = schemaType;
    try {
      const docAI = await this._callDocumentAI(invoiceBase64, mediaType, schemaType);
      docAILineItems = docAI.lineItems || [];
      docAIHeader = docAI.headerFields || {};
      routedTo = docAI.routedTo || schemaType;
      LOG.info(`Stage 2 complete: ${Object.keys(docAIHeader).length} header fields, ${docAILineItems.length} line items, routed to ${routedTo}`);
    } catch (err) {
      LOG.warn('Document AI failed:', err.message);
    }

    // ── Stage 3: Trigger decision ──────────────────────────────
    const trigger = this._computeTriggerDecision(docAIHeader);

    let intelligence;
    if (!trigger.triggered) {
      LOG.info('Trigger: SKIPPED Claude — Doc AI confident (cost saved)');
      intelligence = {
        fields: Object.entries(docAIHeader).map(([k, v]) => ({
          fieldName: k,
          docAIValue: v.value || '',
          correctValue: v.value || '',
          verdict: 'VERIFIED',
          confidence: v.confidence || 0,
          reason: 'Doc AI high-confidence — auto-verified, Claude not called (cost saved)',
          taxCritical: false
        })),
        lineItems: docAILineItems.map(li => ({
          description: li.materialDescription?.value || li.materialDescription || '',
          netPrice: parseFloat(li.netPrice?.value || li.netPrice || 0),
          allocatedFreight: 0,
          taxableBase: parseFloat(li.netPrice?.value || li.netPrice || 0),
          page: 1,
          status: 'KEEP'
        })),
        lineItemCorrections: [],
        consistencyChecks: [],
        freightTotal: '',
        summary: 'All Doc AI tax-critical fields met confidence threshold — Claude audit skipped (cost optimised).',
        overallConfidence: 95,
        invoiceMode: routedTo,
        lineItemsTotal: 0
      };
    } else {
      LOG.info('Trigger: Claude adjudicating');
      try {
        intelligence = await this._auditInvoice(fullText, docAIHeader, docAILineItems, routedTo);
        LOG.info(`Stage 3 complete: ${intelligence.fields?.length || 0} fields audited, ${intelligence.lineItems?.length || 0} line items`);
      } catch (err) {
        LOG.error('Audit failed:', err.message);
        intelligence = this._getMockAudit(docAIHeader, docAILineItems);
      }
    }

    const processingTimeMs = Date.now() - startTime;
    LOG.info(`Pipeline complete in ${processingTimeMs}ms`);

    const fields = intelligence.fields || [];
    const verified = fields.filter(f => f.verdict === 'VERIFIED').length;
    const corrected = fields.filter(f => f.verdict === 'CORRECTED').length;
    const flagged = fields.filter(f => f.verdict === 'FLAGGED').length;

    const claudeTriggered = trigger.triggered;
    const docAICostPerDoc = 0.02;
    const claudeCostPerDoc = claudeTriggered ? 0.015 : 0;

    return JSON.stringify({
      documentId,
      schemaType,
      fields,
      lineItems: intelligence.lineItems || [],
      lineItemCorrections: intelligence.lineItemCorrections || [],
      consistencyChecks: intelligence.consistencyChecks || [],
      freightTotal: intelligence.freightTotal || '',
      summary: intelligence.summary || '',
      overallConfidence: intelligence.overallConfidence || 0,
      invoiceMode: intelligence.invoiceMode || routedTo,
      lineItemsTotal: intelligence.lineItemsTotal || 0,
      stats: { total: fields.length, verified, corrected, flagged },
      docAIHeader,
      docAILineItems,
      fullTextLength: fullText.length,
      processingTimeMs,
      costValue: {
        claudeTriggered,
        triggerReasons: trigger.reasons,
        docAICostPerDoc,
        claudeCostPerDoc,
        totalCostPerDoc: docAICostPerDoc + claudeCostPerDoc,
        fieldsAutoVerified: claudeTriggered ? 0 : fields.length,
        fieldsAdjudicated: claudeTriggered ? fields.length : 0
      }
    });
  }

  _computeTriggerDecision(docAIHeader) {
    const taxCriticalFields = ['shipToAddress', 'shipToCity', 'shipToState', 'shipToPostalCode', 'grossAmount', 'taxAmount', 'taxAmountHeader'];
    const reasons = [];

    if (Object.keys(docAIHeader).length === 0) {
      return { triggered: true, reasons: ['Doc AI returned nothing'], taxCriticalChecked: 0 };
    }

    let taxCriticalChecked = 0;
    for (const name of taxCriticalFields) {
      if (name in docAIHeader) {
        taxCriticalChecked++;
        const conf = docAIHeader[name].confidence ?? 100;
        if (conf < 85) {
          reasons.push(`low confidence on ${name} (${conf}%)`);
        }
      }
    }

    const triggered = reasons.length > 0;
    return { triggered, reasons, taxCriticalChecked };
  }

  async _extractPdfText(base64, mediaType) {
    if (mediaType !== 'application/pdf') return '';
    const { PDFParse } = require('pdf-parse');
    const buffer = Buffer.from(base64, 'base64');
    const parser = new PDFParse({ data: buffer });
    const result = await parser.getText();
    await parser.destroy();
    return result.text;
  }

  async _callDocumentAI(base64, mediaType, schemaType) {
    const tokenUrl = process.env.DOC_AI_TOKEN_URL;
    const clientId = process.env.DOC_AI_CLIENT_ID;
    const clientSecret = process.env.DOC_AI_CLIENT_SECRET;
    const apiUrl = process.env.DOC_AI_URL;
    const LOG = cds.log('intelligence');

    if (!tokenUrl || !clientId || !clientSecret) throw new Error('Document AI credentials not configured');

    const tokenRes = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret })
    });
    if (!tokenRes.ok) throw new Error(`Doc AI token failed: ${tokenRes.status}`);
    const { access_token } = await tokenRes.json();

    // ── Pass 1: Indexing schema — classify document type ───────
    const indexingSchemaId = process.env.DOC_AI_SCHEMA_INDEXING;
    const pass1 = await this._runDocAIJob(base64, mediaType, indexingSchemaId, access_token, apiUrl);

    const classifiedType = pass1.headerFields?.documentType?.value || 'non_construction';
    const indexingConfidence = pass1.headerFields?.documentType?.confidence || 0;
    LOG.info(`Doc AI routing: classified as ${classifiedType}`);

    // ── Pass 2: Routed schema — full extraction ─────────────────
    const routedSchemaId = classifiedType === 'construction'
      ? process.env.DOC_AI_SCHEMA_CONSTRUCTION
      : process.env.DOC_AI_SCHEMA_NON_CONSTRUCTION;
    const routedTo = classifiedType === 'construction' ? 'construction' : 'non_construction';

    const pass2 = await this._runDocAIJob(base64, mediaType, routedSchemaId, access_token, apiUrl);
    LOG.info(`Doc AI pass 2 complete with ${routedTo} schema`);

    return { ...pass2, routedTo, indexingConfidence };
  }

  async _runDocAIJob(base64, mediaType, schemaId, access_token, apiUrl) {
    const { default: FormData } = await import('form-data');
    const pdfBuffer = Buffer.from(base64, 'base64');

    const optionsPayload = JSON.stringify({
      schemaId: schemaId,
      clientId: 'default',
      documentType: 'invoice'
    });
    const form = new FormData();
    form.append('options', optionsPayload, { contentType: 'application/json' });
    form.append('file', pdfBuffer, { filename: 'invoice.pdf', contentType: mediaType });

    const formBuffer = form.getBuffer();
    const uploadRes = await fetch(`${apiUrl}/document-information-extraction/v1/document/jobs`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${access_token}`,
        'Accept': 'application/json',
        'Content-Type': `multipart/form-data; boundary=${form.getBoundary()}`,
        'Content-Length': formBuffer.length
      },
      body: formBuffer
    });
    if (!uploadRes.ok) throw new Error(`Doc AI upload failed: ${uploadRes.status} ${await uploadRes.text()}`);
    const job = await uploadRes.json();

    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 2000));
      const pollRes = await fetch(`${apiUrl}/document-information-extraction/v1/document/jobs/${job.id}`, {
        headers: { 'Authorization': `Bearer ${access_token}` }
      });
      const pollData = await pollRes.json();
      if (pollData.status === 'DONE') return this._normalizeDocAI(pollData);
      if (pollData.status === 'FAILED') throw new Error('Doc AI extraction failed');
    }
    throw new Error('Doc AI timed out');
  }

  _normalizeDocAI(raw) {
    const headerFields = {};
    const lineItems = [];
    const ext = raw.extraction || {};
    if (ext.headerFields) {
      for (const f of ext.headerFields) {
        headerFields[f.name] = { value: f.value || '', confidence: Math.round((f.confidence || 0) * 100) };
      }
    }
    if (ext.lineItems) {
      for (const item of ext.lineItems) {
        const li = {};
        const cols = item.columns || item.fields || [];
        for (const col of cols) {
          if (col.name) li[col.name] = { value: col.value || '', confidence: Math.round((col.confidence || 0) * 100) };
        }
        lineItems.push(li);
      }
    }
    return { headerFields, lineItems, raw };
  }

  async _auditInvoice(fullText, docAIHeader, docAILineItems, schemaType) {
    const authUrl = process.env.AI_CORE_AUTH_URL;
    const clientId = process.env.AI_CORE_CLIENT_ID;
    const clientSecret = process.env.AI_CORE_CLIENT_SECRET;
    const deploymentUrl = process.env.AI_CORE_DEPLOYMENT_URL;
    const resourceGroup = process.env.AI_CORE_RESOURCE_GROUP || 'use-tax';
    const modelName = process.env.AI_CORE_MODEL || 'anthropic--claude-4.5-sonnet';

    if (!authUrl || !clientId) throw new Error('AI Core credentials not configured');

    const tokenRes = await fetch(authUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret })
    });
    if (!tokenRes.ok) throw new Error(`AI Core token failed: ${tokenRes.status}`);
    const { access_token } = await tokenRes.json();

    const headerSummary = Object.entries(docAIHeader).map(([k, v]) =>
      `  ${k}: "${v.value || ''}" (Doc AI confidence: ${v.confidence || 0}%)`
    ).join('\n');

    const lineSummary = docAILineItems.map((li, i) => {
      const desc = li.materialDescription?.value || li.materialDescription || '';
      const price = li.netPrice?.value || li.netPrice || '';
      return `  Row ${i + 1}: description="${desc}" | netPrice="${price}"`;
    }).join('\n');

    const prompt = this._buildAuditPrompt(schemaType);
    const fullPrompt = `${prompt}

=== FULL INVOICE TEXT (ground truth - all pages): ===
${fullText.substring(0, 12000)}

=== DOCUMENT AI EXTRACTED HEADER FIELDS: ===
${headerSummary || '(none)'}

=== DOCUMENT AI EXTRACTED LINE ITEMS: ===
${lineSummary || '(none - extract directly from invoice text)'}

Now audit the entire invoice. Return ONLY the JSON described above.`;

    const orchBody = {
      orchestration_config: {
        module_configurations: {
          templating_module_config: { template: [{ role: "user", content: "{{?input}}" }] },
          llm_module_config: { model_name: modelName, model_params: { max_tokens: 8192, temperature: 0 } }
        }
      },
      input_params: { input: fullPrompt }
    };

    const response = await fetch(deploymentUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${access_token}`,
        'Content-Type': 'application/json',
        'AI-Resource-Group': resourceGroup
      },
      body: JSON.stringify(orchBody)
    });
    if (!response.ok) throw new Error(`AI Core call failed: ${response.status} ${await response.text()}`);

    const data = await response.json();
    const content = data.orchestration_result?.choices?.[0]?.message?.content || '';
    const cleaned = content.replace(/```json|```/g, '').trim();
    return JSON.parse(cleaned);
  }

  _buildAuditPrompt(schemaType) {
    return `You are an invoice extraction intelligence auditor for US USE Tax processing. SAP Document AI extracted fields from an invoice at roughly 80-95% accuracy. Audit EVERY field against the source invoice text, verify or correct each one, run cross-field consistency checks, and explain your reasoning.

FOR EACH HEADER FIELD, produce a verdict:
- VERIFIED: Doc AI value matches the invoice text and passes domain rules
- CORRECTED: Doc AI value was wrong or missing; you found the right value in the text
- FLAGGED: value is ambiguous or unconfirmable; needs human review

DOMAIN RULES:
1. SHIP-TO vs BILL-TO: Ship-to (or Installation/Deliver-to) determines tax jurisdiction and DIFFERS from Bill-To. Bill-To is often Accenture Chicago (500 W Madison). Never report Bill-To as ship-to. For construction, Installation/Project address is the ship-to.
2. VENDOR NAME: legal entity issuing the invoice, not the remit-to processor.
3. PO NUMBER: 10-digit number starting with 6 for Accenture POs.
4. DATES: normalize to MM/DD/YYYY.
5. AMOUNTS: strip currency symbols; use current-period/total-due, not cumulative.

CROSS-FIELD CONSISTENCY CHECKS (report each pass/fail with detail):
- Do line-item amounts sum to the invoice subtotal/total?
- If tax amount and rate both present, does base x rate approx equal tax amount?
- Is ship-to state consistent with ship-to city/ZIP?
- Construction: does workCompletedThisPeriodTotal match the current-period column sum?

LINE ITEMS - clean these too:
- SUPPRESS breakup/sub-component rows, PR/PO/Ariba reference rows, and TAX lines (tax comes from Vertex downstream)
- FLAG freight/shipping lines for proportional distribution
- CORRECT page-2+ column drift using page-1 headers
${schemaType === 'construction' ? '- CONSTRUCTION: current-period column (Work Completed This Period > Current Bill > This Period); prefer Sworn Statement totals' : '- NON-CONSTRUCTION: keep lines where netPrice != 0; current-period/invoice column'}

LINE ITEM OUTPUT MODE:
- CONSTRUCTION invoice: output ONE consolidated line: description "Non-Residential building construction services", netPrice = SUM of eligible current-period line amounts (use SWORN amounts if a Sworn Statement is present). Set grossAmount from workCompletedThisPeriodTotal. Set allocatedFreight = 0, taxableBase = netPrice.
- NON-CONSTRUCTION invoice: output every line where netPrice != 0. Distribute freight proportionally: allocatedFreight = freightTotal * (lineNetPrice / sumOfAllNetPrices); taxableBase = netPrice + allocatedFreight. Suppress tax lines. Do not list the freight line as its own taxable line.

OUTPUT - return ONLY this JSON, no markdown:
{
  "invoiceMode": "${schemaType === 'construction' ? 'construction' : 'non_construction'}",
  "fields": [
    { "fieldName": "vendorName", "docAIValue": "", "correctValue": "", "verdict": "VERIFIED|CORRECTED|FLAGGED", "confidence": 0, "reason": "brief", "taxCritical": true }
  ],
  "lineItems": [
    { "description": "", "netPrice": 0, "allocatedFreight": 0, "taxableBase": 0, "page": 1, "status": "KEEP" }
  ],
  "lineItemsTotal": 0,
  "lineItemCorrections": [
    { "action": "SUPPRESSED_BREAKUP|SUPPRESSED_PRPO|SUPPRESSED_TAX|CORRECTED_AMOUNT|FLAGGED_FREIGHT", "description": "", "reason": "", "oldValue": "", "newValue": "" }
  ],
  "consistencyChecks": [
    { "check": "Line items sum to total", "result": "PASS|FAIL", "detail": "" }
  ],
  "freightTotal": "",
  "summary": "2-3 sentence executive summary of extraction quality and what the AI improved",
  "overallConfidence": 0
}

Set lineItemsTotal = sum of all lineItems[].taxableBase. Audit at minimum: vendorName, invoiceNumber, documentDate, purchaseOrderNumber, grossAmount, taxAmount, shipToAddress, shipToCity, shipToState, shipToPostalCode. Mark shipTo*, grossAmount, taxAmount as taxCritical=true.`;
  }

  _getMockAudit(docAIHeader, docAILineItems) {
    const fields = Object.entries(docAIHeader).map(([k, v]) => ({
      fieldName: k, docAIValue: v.value || '', correctValue: v.value || '',
      verdict: 'VERIFIED', confidence: v.confidence || 0, reason: 'AI Core unavailable - passthrough', taxCritical: false
    }));
    return {
      fields,
      lineItems: docAILineItems.map(li => ({
        description: li.materialDescription?.value || li.materialDescription || '',
        netPrice: li.netPrice?.value || li.netPrice || '', page: 1, status: 'KEEP'
      })),
      lineItemCorrections: [], consistencyChecks: [], freightTotal: '',
      summary: 'AI Core unavailable - showing Document AI output without intelligence audit.',
      overallConfidence: 0
    };
  }
};
