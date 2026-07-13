require('dotenv').config();
const cds = require('@sap/cds');
const fs = require('fs');
const path = require('path');
const assetData = require('./data/asset-report.json');

const INVOICE_FOLDER = process.env.INVOICE_FOLDER || 'C:/Users/abhishek.hs.kumar/Accenture/Agentic AI US Use Tax - Internal team - Merged';
let scnMapping = {};
try { scnMapping = require('./data/scn-mapping.json'); } catch (e) { console.log('scn-mapping.json not present'); }

const TAX_CRITICAL_FIELDS = new Set([
  'shipToAddress','shipToCity','shipToState','shipToPostalCode',
  'grossAmount','taxAmount','taxAmountHeader'
]);

const SCHEMA_FIELDS = {
  common_header: [
    'vendorName','invoiceNumber','documentDate',
    'shipToAddress','shipToCity','shipToState','shipToCounty','shipToPostalCode',
    'grossAmount','taxPercentage','purchaseOrderNumber',
    'totalTaxableAmount','nonTaxableAmount','subTotal','shippingCostHeader',
    'contractDetails','contractDetailsPostalcode',
    'projectAddress','projectAddressPostalCode',
    'workCompletedThisPeriodTotal'
  ],
  taxField: { indexing: 'taxAmountHeader', non_construction: 'taxAmount', construction: 'taxAmount' },
  non_construction_extra: [
    'accentureAddress','accentureAddressCity','accentureAddressState',
    'accentureAddressPostalCode','accentureAddressCounty',
    'projectAddressCity','projectAddressState','projectAddressCounty',
    'contractDetailsCity'
  ],
  construction_extra: ['projectAddressCity','projectAddressState','projectAddressCounty','contractDetailsCity'],
  indexing_extra: ['senderAddress','amountDueCurrent','documentType','currentPaymentDue','thisPaymentAmountDetected'],
  lineItem: {
    indexing:          ['materialDescription','lineType','netPrice','taxability','amount'],
    non_construction:  ['materialDescription','taxAmount','netPrice','taxability','Amount','lineAction'],
    construction:      ['materialDescription','taxAmount','netPrice','taxability','pageType']
  }
};

function schemaHeaderFields(mode) {
  const m = String(mode || 'non_construction');
  const seen = new Set(), result = [];
  const push = k => { if (!seen.has(k)) { seen.add(k); result.push(k); } };
  SCHEMA_FIELDS.common_header.forEach(push);
  if      (m === 'construction') SCHEMA_FIELDS.construction_extra.forEach(push);
  else if (m === 'indexing')     SCHEMA_FIELDS.indexing_extra.forEach(push);
  else                            SCHEMA_FIELDS.non_construction_extra.forEach(push);
  push(SCHEMA_FIELDS.taxField[m] || SCHEMA_FIELDS.taxField.non_construction);
  return result;
}

module.exports = class DocumentIntelligenceService extends cds.ApplicationService {

  async init() {
    this.on('extractDocAI', this._handleExtractDocAI);
    this.on('processInvoice', this._handleProcessInvoice);
    this.on('auditWithVision', this._handleAuditWithVision);
    this.on('listInvoices', this._handleListInvoices);
    this.on('getInvoiceFile', this._handleGetInvoiceFile);
    await super.init();
  }

  async _handleExtractDocAI(req) {
    const { documentId, schemaType, invoiceBase64, mediaType } = req.data;
    const LOG = cds.log('intelligence');
    const startTime = Date.now();
    LOG.info(`extractDocAI: ${documentId} (${schemaType})`);

    let fullText = '';
    try {
      fullText = await this._extractPdfText(invoiceBase64, mediaType);
      LOG.info(`extractDocAI: text extracted, ${fullText.length} chars`);
    } catch (err) {
      LOG.warn('extractDocAI: PDF text extraction failed:', err.message);
    }

    let keepLines = [], suppressedLines = [], docAIHeader = {}, routedTo = schemaType;
    let docAIFreightTotal = 0, docAIInvoiceNetTotal = 0, docAIVendorTax = null;
    try {
      const docAI = await this._callDocumentAI(invoiceBase64, mediaType, schemaType);
      keepLines = docAI.keepLines || [];
      suppressedLines = docAI.suppressedLines || [];
      docAIHeader = docAI.headerFields || {};
      routedTo = docAI.routedTo || schemaType;
      docAIFreightTotal = docAI.invoiceFreightTotal || 0;
      docAIInvoiceNetTotal = docAI.invoiceNetTotal || 0;
      docAIVendorTax = docAI.vendorTaxAmount ?? null;
    } catch (err) {
      LOG.warn('extractDocAI: Doc AI failed:', err.message);
    }

    const schemaFields = schemaHeaderFields(routedTo);
    const schemaSet = new Set(schemaFields);
    const mkField = (k, v) => ({
      fieldName: k,
      docAIValue: v ? (v.value || '') : '',
      confidence: v ? (v.confidence || 0) : 0,
      taxCritical: TAX_CRITICAL_FIELDS.has(k),
      page: v ? (v.page || 1) : 1,
      boundingBox: v ? (v.coordinates || null) : null,
      provenance: 'extracted'
    });
    const fields = [
      ...schemaFields.map(k => mkField(k, docAIHeader[k])),
      ...Object.entries(docAIHeader).filter(([k]) => !schemaSet.has(k)).map(([k, v]) => mkField(k, v))
    ];
    console.log('BBOX SAMPLE:', JSON.stringify(fields.slice(0, 3).map(f => ({ name: f.fieldName, bbox: f.boundingBox, page: f.page }))));

    let lineItems, pageTypeUsed = null, grossAmount = null;
    if (routedTo === 'construction') {
      const consolidated = this._consolidateConstruction(keepLines, docAIFreightTotal, docAIHeader);
      lineItems = [consolidated];
      pageTypeUsed = consolidated.pageTypeUsed;
      grossAmount = consolidated.grossAmount;
    } else {
      lineItems = keepLines.map(function(li) {
        return {
          unspsc: li.unspsc || '',
          description: li.description || '',
          amount: li.amount,
          netAmount: li.amount,
          itemAmount: li.itemAmount != null ? li.itemAmount : (li.amount || 0),
          freightAmount: li.freightAmount || 0,
          lineAction: li.lineAction || 'KEEP',
          lineType: li.lineType || null,
          page: li.page || 1,
          provenance: 'extracted',
          freightProvenance: docAIFreightTotal > 0 ? 'inferred' : 'extracted',
          freightProvenanceDetail: docAIFreightTotal > 0 ? 'distributed: freightTotal × (lineNet / sumKeepNet)' : undefined,
          itemAmountProvenance: (li.freightAmount || 0) > 0 ? 'inferred' : 'extracted',
          itemAmountProvenanceDetail: (li.freightAmount || 0) > 0 ? 'derived: netAmount + distributedFreight' : undefined
        };
      });
    }

    const invoiceNetTotal = routedTo === 'construction'
      ? (lineItems[0] ? lineItems[0].itemAmount : 0)
      : (docAIInvoiceNetTotal || +(lineItems.reduce(function(s, li){ return s + (li.itemAmount || 0); }, 0)).toFixed(2));
    const vendorTaxAmount = docAIVendorTax;
    const invoiceGrossTotal = vendorTaxAmount != null
      ? +(invoiceNetTotal + vendorTaxAmount).toFixed(2) : invoiceNetTotal;
    const _netProv = (routedTo === 'construction' || docAIInvoiceNetTotal)
      ? { provenance: 'extracted' }
      : { provenance: 'inferred', provenanceDetail: 'sum of line item amounts' };
    const _grossProv = vendorTaxAmount != null
      ? { provenance: 'inferred', provenanceDetail: 'derived: invoiceNetTotal + vendorTaxAmount' }
      : _netProv;

    console.log('EXTRACT DOCAI LINE ITEMS:', JSON.stringify(lineItems, null, 2));

    const asset = this._lookupAssetReport(documentId);
    const getH = k => (docAIHeader[k]?.value || '').trim();
    const resolved = this._resolveShipTo(getH, routedTo);
    const inv = {
      vendorName: getH('vendorName'),
      shipToAddress: resolved.shipToAddress,
      documentDate: getH('documentDate'), purchaseOrderNumber: getH('purchaseOrderNumber'),
      invoiceNetTotal, shipToPostalCode: resolved.shipToPostalCode,
      shipToCity: resolved.shipToCity, shipToState: resolved.shipToState, country: getH('country'),
      resolvedFromCaption: resolved.resolvedFromCaption, resolvedFromNote: resolved.resolvedFromNote
    };
    const generalInfo = this._buildGeneralInfo(inv, asset);

    const apcEnd = asset && asset.record && asset.record.apcEndValue != null ? parseFloat(String(asset.record.apcEndValue).replace(/[^0-9.\-]/g,'')) : null;
    const apcLineSum = invoiceNetTotal;
    const apcGross   = invoiceGrossTotal;
    const apcWithin = (a, b) => a != null && b != null && Math.abs(a - b) <= 1.0;
    let apcReconciliation;
    if (apcEnd == null) {
      apcReconciliation = { status: 'no-apc', label: 'APC End not in Asset Report', match: null };
    } else if (apcWithin(apcGross, apcEnd) && apcWithin(apcLineSum, apcGross)) {
      apcReconciliation = { status: 'all-good', label: 'All Good — line items, gross, and APC End match', match: true, apcEnd, gross: apcGross, lineSum: apcLineSum };
    } else if (apcWithin(apcGross, apcEnd)) {
      apcReconciliation = { status: 'gross-apc-match', label: 'Gross matches APC End', match: true, apcEnd, gross: apcGross, lineSum: apcLineSum };
    } else {
      apcReconciliation = { status: 'mismatch', label: 'Amounts do not reconcile with APC End', match: false, apcEnd, gross: apcGross, lineSum: apcLineSum, diff: +(apcGross - apcEnd).toFixed(2) };
    }

    const consistencyChecks = this._runConsistencyChecks({
      lineItems, rawLineItems: keepLines, invoiceNetTotal, vendorTaxAmount: vendorTaxAmount ?? null,
      invoiceGrossTotal, invoiceFreightTotal: docAIFreightTotal,
      purchaseOrderNumber: inv.purchaseOrderNumber,
      shipToCity: resolved.shipToCity, shipToPostalCode: resolved.shipToPostalCode,
      documentId
    });
    const manualAction = this._determineManualAction(
      { documentId, shipToCity: resolved.shipToCity, shipToPostalCode: resolved.shipToPostalCode, lineItems },
      consistencyChecks, fields
    );

    return JSON.stringify({
      stage: 'docai', documentId, invoiceMode: routedTo,
      fields, lineItems, suppressedLines: suppressedLines.map(function(li){ return Object.assign({}, li, { suppressedBy: 'docai' }); }),
      invoiceNetTotal, invoiceFreightTotal: docAIFreightTotal,
      vendorTaxAmount: vendorTaxAmount ?? null,
      invoiceGrossTotal, invoiceTotalAmount: invoiceGrossTotal,
      taxHandledBy: 'tax-layer',
      pageTypeUsed, grossAmount,
      resolvedFrom: resolved.resolvedFrom,
      resolvedFromCaption: resolved.resolvedFromCaption,
      apcReconciliation,
      consistencyChecks, manualAction,
      fieldComparison: this._buildFieldComparison({ invoiceMode: routedTo, fields, visionFields: null, docaiLines: lineItems, claudeLines: null, visionLines: null, claudeRan: false, visionRan: false }),
      generalInfo, docAIHeader, keepLines, fullText,
      _provenance: {
        invoiceNetTotal: _netProv,
        vendorTaxAmount: { provenance: vendorTaxAmount != null ? 'extracted' : null },
        invoiceGrossTotal: _grossProv,
        invoiceFreightTotal: { provenance: 'extracted' },
        shipToResolution: { provenance: 'inferred', provenanceDetail: resolved.resolvedFromCaption || 'priority-ordered address block selection' }
      },
      processingTimeMs: Date.now() - startTime
    });
  }

  async _handleProcessInvoice(req) {
    const { documentId, docAIResult: docAIResultStr } = req.data;
    const LOG = cds.log('intelligence');
    const startTime = Date.now();

    // ── Parse Doc AI result passed from client (Doc AI already ran in extractDocAI) ──
    let docAIParsed;
    try {
      docAIParsed = JSON.parse(docAIResultStr);
    } catch (err) {
      return req.error(400, 'docAIResult is missing or invalid JSON');
    }
    const keepLines          = docAIParsed.keepLines || [];
    const docAISuppressedLines = docAIParsed.suppressedLines || [];
    const docAIHeader        = docAIParsed.docAIHeader || {};
    const routedTo           = docAIParsed.invoiceMode || 'non_construction';
    const docAIFreightTotal  = docAIParsed.invoiceFreightTotal || 0;
    const docAIVendorTax     = docAIParsed.vendorTaxAmount ?? null;
    const fullText           = docAIParsed.fullText || '';
    LOG.info(`Processing invoice ${documentId} (${routedTo}) — ${Object.keys(docAIHeader).length} header fields, ${keepLines.length} keep lines from client-supplied Doc AI result`);

    const docAILineItems = keepLines; // Claude audits billable lines only

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
          taxCritical: false,
          page: v.page || 1,
          boundingBox: v.coordinates || null,
          provenance: 'extracted'
        })),
        lineItems: routedTo === 'construction'
          ? [Object.assign(this._consolidateConstruction(keepLines, docAIFreightTotal, docAIHeader), {
              lineVerdict: 'VERIFIED', lineReason: 'Auto-verified — Doc AI confident', lineConfidence: 95
            })]
          : keepLines.map(li => ({
              unspsc: '', description: li.description || '',
              amount: li.amount, netAmount: li.amount,
              itemAmount: li.itemAmount != null ? li.itemAmount : (li.amount || 0),
              freightAmount: li.freightAmount || 0,
              lineVerdict: 'VERIFIED', lineReason: 'Auto-verified — Doc AI confident',
              lineConfidence: 95, lineAction: li.lineAction || 'KEEP',
              lineType: li.lineType || null, page: li.page || 1,
              provenance: 'extracted', freightProvenance: 'extracted'
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

    // Re-distribute Doc AI's freight total across Claude's (possibly corrected) KEEP amounts only.
    // Must filter out isFreight and SUPPRESSED lines BEFORE distributing so the denominator
    // reflects only billable lines and each KEEP line gets its correct proportional share.
    const rawClaudeItems = intelligence.lineItems || [];
    const claudeKeepItems = rawClaudeItems.filter(function(li){ return !li.isFreight && li.lineVerdict !== 'SUPPRESSED'; });
    const claudeSuppressedItems = rawClaudeItems
      .filter(function(li){ return li.isFreight || li.lineVerdict === 'SUPPRESSED'; })
      .map(function(li){ return Object.assign({}, li, { suppressedBy: 'claude' }); });
    const sumKeepNet = claudeKeepItems.reduce(function(s, li){ return s + (parseFloat(li.amount) || 0); }, 0);
    let freightAlloc = 0, lgIdx = 0, lgAmt = -Infinity;
    const claudeLineItems = claudeKeepItems.map(function(li, idx) {
      const net = parseFloat(li.amount) || 0;
      if (net > lgAmt) { lgAmt = net; lgIdx = idx; }
      const rawF = sumKeepNet > 0 ? docAIFreightTotal * (net / sumKeepNet) : 0;
      const freight = +rawF.toFixed(2);
      freightAlloc += freight;
      return Object.assign({}, li, {
        freightAmount: freight,
        itemAmount: +(net + freight).toFixed(2),
        freightProvenance: docAIFreightTotal > 0 ? 'inferred' : 'extracted',
        freightProvenanceDetail: docAIFreightTotal > 0 ? 'distributed: freightTotal × (lineNet / sumKeepNet)' : undefined,
        itemAmountProvenance: freight > 0 ? 'inferred' : (li.provenance || 'extracted'),
        itemAmountProvenanceDetail: freight > 0 ? 'derived: netAmount + distributedFreight' : undefined
      });
    });
    const freightRem = +(docAIFreightTotal - freightAlloc).toFixed(2);
    if (freightRem !== 0 && claudeLineItems.length > 0) {
      const lg = claudeLineItems[lgIdx];
      lg.freightAmount = +(lg.freightAmount + freightRem).toFixed(2);
      lg.itemAmount = +((parseFloat(lg.amount) || 0) + lg.freightAmount).toFixed(2);
    }
    console.log('FREIGHT CALC:', JSON.stringify({
      keepNets: claudeLineItems.map(function(l){ return parseFloat(l.amount)||0; }),
      freightTotal: docAIFreightTotal,
      sumKeepNet,
      perLineFreight: claudeLineItems.map(function(l){ return l.freightAmount; }),
      sumFreight: +(claudeLineItems.reduce(function(s,l){ return s+l.freightAmount; }, 0)).toFixed(2)
    }));
    const invoiceNetTotal = +(claudeLineItems.reduce(function(s, li){ return s + li.itemAmount; }, 0)).toFixed(2);
    const invoiceFreightTotal = docAIFreightTotal;

    const vendorTaxAmount = intelligence.vendorTaxAmount != null
      ? parseFloat(String(intelligence.vendorTaxAmount).replace(/[^0-9.\-]/g,''))
      : (docAIVendorTax != null ? docAIVendorTax : null);
    const invoiceGrossTotal = vendorTaxAmount != null
      ? +(invoiceNetTotal + vendorTaxAmount).toFixed(2) : invoiceNetTotal;
    const reconciliation = {
      invoiceTaxRate: intelligence.invoiceTaxRate || null,
      invoiceTaxRateProvenance: intelligence.invoiceTaxRate ? 'inferred' : null,
      invoiceTaxRateProvenanceDetail: intelligence.invoiceTaxRate ? 'derived: vendorTaxAmount / invoiceNetTotal' : null,
      vendorTaxAmount,
      vendorTaxAmountProvenance: vendorTaxAmount != null ? 'extracted' : null,
      vertexTaxRate: null, vertexTaxAmount: null,
      taxRateDifference: null, taxAmountDifference: null,
      taxabilityStatus: 'Pending tax layer', chargeabilityStatus: 'Pending tax layer', acceptanceStatus: ''
    };

    const schemaFields = schemaHeaderFields(routedTo);
    const schemaSet = new Set(schemaFields);
    const claudeMap = new Map((intelligence.fields || []).map(f => [f.fieldName, f]));
    const fields = [];
    schemaFields.forEach(k => {
      const cf = claudeMap.get(k);
      const docH = docAIHeader[k];
      if (cf) {
        const prov = cf.verdict === 'CORRECTED'
          ? { provenance: 'inferred', provenanceDetail: 'value corrected by Claude during audit' }
          : { provenance: 'extracted' };
        fields.push(Object.assign({}, cf, {
          boundingBox: (docH && docH.coordinates) || cf.boundingBox || null,
          page: (docH && docH.page) || cf.page || 1
        }, prov));
      } else {
        const dv = docH ? (docH.value || '') : '';
        fields.push({
          fieldName: k, docAIValue: dv, correctValue: dv,
          confidence: docH ? (docH.confidence || 0) : 0,
          verdict: 'VERIFIED',
          reason: docH ? 'Not escalated to Claude — Doc AI value accepted' : 'Not extracted by Doc AI',
          taxCritical: TAX_CRITICAL_FIELDS.has(k), routedTo: 'docai',
          boundingBox: docH ? (docH.coordinates || null) : null,
          page: docH ? (docH.page || 1) : 1,
          provenance: 'extracted'
        });
      }
    });
    (intelligence.fields || []).forEach(f => {
      if (!schemaSet.has(f.fieldName)) {
        const docH = docAIHeader[f.fieldName];
        const prov = f.verdict === 'CORRECTED'
          ? { provenance: 'inferred', provenanceDetail: 'value corrected by Claude during audit' }
          : { provenance: 'extracted' };
        fields.push(Object.assign({}, f, {
          boundingBox: (docH && docH.coordinates) || f.boundingBox || null,
          page: (docH && docH.page) || f.page || 1
        }, prov));
      }
    });
    const verified = fields.filter(f => f.verdict === 'VERIFIED').length;
    const corrected = fields.filter(f => f.verdict === 'CORRECTED').length;
    const flagged = fields.filter(f => f.verdict === 'FLAGGED').length;

    const allLineItems = [...claudeLineItems, ...docAISuppressedLines];
    const lineCorrected = allLineItems.filter(li => li.lineVerdict === 'CORRECTED').length;
    const lineFlagged   = allLineItems.filter(li => li.lineVerdict === 'FLAGGED').length;

    const asset = this._lookupAssetReport(documentId);
    const getF = k => { const f = (intelligence.fields || []).find(x => x.fieldName === k); return (f?.correctValue || f?.docAIValue || '').trim(); };
    const resolved = this._resolveShipTo(getF, routedTo);
    const inv = {
      vendorName: getF('vendorName'),
      shipToAddress: resolved.shipToAddress,
      documentDate: getF('documentDate'),
      purchaseOrderNumber: getF('purchaseOrderNumber'),
      invoiceNetTotal,
      shipToPostalCode: resolved.shipToPostalCode,
      shipToCity: resolved.shipToCity,
      shipToState: resolved.shipToState,
      country: getF('country'),
      resolvedFromCaption: resolved.resolvedFromCaption,
      resolvedFromNote: resolved.resolvedFromNote
    };
    const generalInfo = this._buildGeneralInfo(inv, asset);

    const pageTypeUsed = claudeLineItems[0]?.pageTypeUsed || null;
    const rawGrossStr = (docAIHeader.workCompletedThisPeriodTotal?.value || '').trim();
    const grossAmount = rawGrossStr ? (parseFloat(rawGrossStr.replace(/[^0-9.\-]/g,'')) || null) : null;

    const apcEnd = asset && asset.record && asset.record.apcEndValue != null ? parseFloat(String(asset.record.apcEndValue).replace(/[^0-9.\-]/g,'')) : null;
    const apcLineSum = invoiceNetTotal;
    const apcGross   = invoiceGrossTotal;
    const apcWithin = (a, b) => a != null && b != null && Math.abs(a - b) <= 1.0;
    let apcReconciliation;
    if (apcEnd == null) {
      apcReconciliation = { status: 'no-apc', label: 'APC End not in Asset Report', match: null };
    } else if (apcWithin(apcGross, apcEnd) && apcWithin(apcLineSum, apcGross)) {
      apcReconciliation = { status: 'all-good', label: 'All Good — line items, gross, and APC End match', match: true, apcEnd, gross: apcGross, lineSum: apcLineSum };
    } else if (apcWithin(apcGross, apcEnd)) {
      apcReconciliation = { status: 'gross-apc-match', label: 'Gross matches APC End', match: true, apcEnd, gross: apcGross, lineSum: apcLineSum };
    } else {
      apcReconciliation = { status: 'mismatch', label: 'Amounts do not reconcile with APC End', match: false, apcEnd, gross: apcGross, lineSum: apcLineSum, diff: +(apcGross - apcEnd).toFixed(2) };
    }

    const claudeTriggered = trigger.triggered;
    const docAICostPerDoc = 0.02;
    const claudeCostPerDoc = claudeTriggered ? 0.015 : 0;

    const consistencyChecks = this._runConsistencyChecks({
      lineItems: claudeLineItems, rawLineItems: claudeLineItems, invoiceNetTotal, vendorTaxAmount: vendorTaxAmount ?? null,
      invoiceGrossTotal, invoiceFreightTotal,
      purchaseOrderNumber: inv.purchaseOrderNumber,
      shipToCity: resolved.shipToCity, shipToPostalCode: resolved.shipToPostalCode,
      documentId
    });
    const manualAction = this._determineManualAction(
      { documentId, shipToCity: resolved.shipToCity, shipToPostalCode: resolved.shipToPostalCode, lineItems: claudeLineItems },
      consistencyChecks, fields
    );

    return JSON.stringify({
      documentId,
      schemaType: routedTo,
      fields,
      lineItems: claudeLineItems,
      suppressedLines: [...(docAISuppressedLines || []), ...claudeSuppressedItems],
      lineItemCorrections: intelligence.lineItemCorrections || [],
      consistencyChecks,
      manualAction,
      fieldComparison: this._buildFieldComparison({ invoiceMode: routedTo, fields, visionFields: null, docaiLines: keepLines, claudeLines: claudeLineItems, visionLines: null, claudeRan: true, visionRan: false }),
      freightTotal: intelligence.freightTotal || 0,
      summary: intelligence.summary || '',
      overallConfidence: intelligence.overallConfidence || 0,
      invoiceMode: intelligence.invoiceMode || routedTo,
      lineItemsTotal: intelligence.lineItemsTotal || 0,
      reconciliation,
      invoiceNetTotal,
      vendorTaxAmount: vendorTaxAmount ?? null,
      invoiceGrossTotal,
      invoiceTotalAmount: invoiceGrossTotal,
      invoiceFreightTotal,
      taxHandledBy: 'tax-layer',
      pageTypeUsed, grossAmount,
      resolvedFrom: resolved.resolvedFrom,
      resolvedFromCaption: resolved.resolvedFromCaption,
      apcReconciliation,
      generalInfo,
      vertexTaxTotal: null,
      stats: { total: fields.length, verified, corrected: corrected + lineCorrected, flagged: flagged + lineFlagged },
      docAIHeader,
      docAILineItems: keepLines,
      fullTextLength: fullText.length,
      _provenance: {
        invoiceNetTotal: { provenance: 'inferred', provenanceDetail: 'sum of line item amounts (including distributed freight)' },
        vendorTaxAmount: { provenance: vendorTaxAmount != null ? 'extracted' : null },
        invoiceGrossTotal: { provenance: 'inferred', provenanceDetail: vendorTaxAmount != null ? 'derived: invoiceNetTotal + vendorTaxAmount' : 'same as invoiceNetTotal (no vendor tax)' },
        invoiceFreightTotal: { provenance: 'extracted' },
        invoiceTaxRate: { provenance: intelligence.invoiceTaxRate ? 'inferred' : null, provenanceDetail: intelligence.invoiceTaxRate ? 'derived: vendorTaxAmount / invoiceNetTotal' : null },
        shipToResolution: { provenance: 'inferred', provenanceDetail: resolved.resolvedFromCaption || 'priority-ordered address block selection' }
      },
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

  async _handleAuditWithVision(req) {
    const { documentId, imageBase64, docAIResult: docAIResultStr } = req.data;
    const prevResult   = docAIResultStr ? (() => { try { return JSON.parse(docAIResultStr); } catch(e) { return null; } })() : null;
    const docaiLines   = prevResult ? (prevResult.keepLines || prevResult.lineItems || []) : [];
    const claudeFields = prevResult ? (prevResult.fields  || []) : [];
    const claudeLines  = prevResult ? (prevResult.lineItems || []) : [];
    const LOG = cds.log('intelligence');
    if (!imageBase64) return req.error(400, 'imageBase64 is required');
    LOG.info(`Vision audit requested: ${documentId}`);

    const startTime = Date.now();
    let intelligence;
    try {
      intelligence = await this._callVisionAudit(imageBase64);
    } catch (err) {
      LOG.error('Vision audit failed:', err.message);
      return req.error(500, `Vision audit failed: ${err.message}`);
    }

    const mode = intelligence.invoiceMode || (prevResult && prevResult.invoiceMode) || 'non_construction';
    const schemaFields = schemaHeaderFields(mode);
    const schemaSet = new Set(schemaFields);

    // Build a lookup map for Vision-returned fields and for previous-layer values
    const visionFieldMap = new Map((intelligence.fields || []).map(f => [f.fieldName, f]));
    const prevFieldMap   = new Map((claudeFields || []).map(f => [f.fieldName, f]));

    const rawVisionFields = intelligence.fields || [];
    const returned = rawVisionFields.map(f => f.fieldName);
    const missing  = schemaFields.filter(k => !returned.includes(k));
    const extra    = returned.filter(r => !schemaSet.has(r));
    console.log('VISION FIELD RECONCILE:', JSON.stringify({
      mode,
      expectedCount: schemaFields.length,
      returnedCount: returned.length,
      verified:  rawVisionFields.filter(f => f.verdict === 'VERIFIED').length,
      corrected: rawVisionFields.filter(f => f.verdict === 'CORRECTED').length,
      flagged:   rawVisionFields.filter(f => f.verdict === 'FLAGGED').length,
      missing,
      extra
    }));
    const missingFromVision = missing;

    const fields = [];
    // 1. Ensure every schema field is represented
    schemaFields.forEach(function(k) {
      const vf = visionFieldMap.get(k);
      if (vf) {
        fields.push(Object.assign({}, vf, { routedTo: 'claude-vision', provenance: 'extracted' }));
      } else {
        const prevF = prevFieldMap.get(k);
        const docAIVal = prevF ? (prevF.correctValue || prevF.docAIValue || '') : '';
        fields.push({
          fieldName: k, docAIValue: docAIVal, correctValue: '',
          confidence: 0, verdict: 'FLAGGED',
          reason: 'not returned by Vision / not legible in image',
          taxCritical: TAX_CRITICAL_FIELDS.has(k),
          routedTo: 'claude-vision', provenance: 'extracted',
          boundingBox: prevF ? (prevF.boundingBox || null) : null,
          page: prevF ? (prevF.page || 1) : 1
        });
      }
    });
    // 2. Append any extra fields Vision returned that are outside the schema
    (intelligence.fields || []).forEach(function(f) {
      if (!schemaSet.has(f.fieldName)) {
        fields.push(Object.assign({}, f, { routedTo: 'claude-vision', provenance: 'extracted' }));
      }
    });

    const verified  = fields.filter(function(f){ return f.verdict === 'VERIFIED';  }).length;
    const corrected = fields.filter(function(f){ return f.verdict === 'CORRECTED'; }).length;
    const flagged   = fields.filter(function(f){ return f.verdict === 'FLAGGED';   }).length;
    LOG.info(`Vision fields: schema=${schemaFields.length} returned=${(intelligence.fields||[]).length} padded=${missingFromVision.length} total=${fields.length} (V=${verified} C=${corrected} F=${flagged})`);

    const vendorTaxAmount = intelligence.vendorTaxAmount != null
      ? parseFloat(String(intelligence.vendorTaxAmount).replace(/[^0-9.\-]/g, ''))
      : null;

    // Apply the same suppress rules as Doc AI / Claude text: freight, SUPPRESSED verdict, zero amount
    const visionSuppressedLines = [];
    const visionKeepLines = [];
    (intelligence.lineItems || []).forEach(function(li) {
      const amt = parseFloat(li.amount) || 0;
      if (li.isFreight || li.lineVerdict === 'SUPPRESSED') {
        visionSuppressedLines.push(Object.assign({}, li, {
          suppressReason: li.isFreight
            ? 'Freight/shipping — distributed across line items'
            : (li.lineReason || 'suppressed by Vision'),
          provenance: 'extracted', suppressedBy: 'vision'
        }));
      } else if (amt === 0) {
        visionSuppressedLines.push(Object.assign({}, li, {
          suppressReason: 'zero amount — not billable',
          lineVerdict: 'SUPPRESSED',
          provenance: 'extracted', suppressedBy: 'vision'
        }));
      } else {
        visionKeepLines.push(li);
      }
    });

    // Merge prior-layer suppressions (docai + claude) with vision's, de-duping by description.
    // Each unique line gets suppressedBy as an array of every layer that caught it.
    const prevSuppressedLines = (prevResult && prevResult.suppressedLines) || [];
    const suppMap = new Map();
    prevSuppressedLines.forEach(function(li) {
      const key = (li.description || '').toLowerCase().trim();
      if (!suppMap.has(key)) suppMap.set(key, Object.assign({}, li, { suppressedBy: [] }));
      const entry = suppMap.get(key);
      const layers = Array.isArray(li.suppressedBy) ? li.suppressedBy : (li.suppressedBy ? [li.suppressedBy] : []);
      layers.forEach(function(layer) { if (!entry.suppressedBy.includes(layer)) entry.suppressedBy.push(layer); });
    });
    visionSuppressedLines.forEach(function(li) {
      const key = (li.description || '').toLowerCase().trim();
      if (!suppMap.has(key)) {
        suppMap.set(key, Object.assign({}, li, { suppressedBy: ['vision'] }));
      } else {
        const entry = suppMap.get(key);
        if (!entry.suppressedBy.includes('vision')) entry.suppressedBy.push('vision');
      }
    });
    const mergedSuppressedLines = Array.from(suppMap.values());

    const lineItems = visionKeepLines.map(function(li) {
      return Object.assign({}, li, { freightAmount: 0, itemAmount: li.amount || 0, netAmount: li.amount || 0, vertexTaxAmount: null, freightTaxAmount: null, provenance: 'extracted', freightProvenance: 'extracted' });
    });
    const invoiceNetTotal = +(lineItems.reduce(function(s, li){ return s + (parseFloat(li.amount) || 0); }, 0)).toFixed(2) || null;
    const invoiceGrossTotal = vendorTaxAmount != null && invoiceNetTotal != null
      ? +(invoiceNetTotal + vendorTaxAmount).toFixed(2) : invoiceNetTotal;

    const lineItemTally = (docaiLines && docaiLines.length)
      ? this._tallyLineItemsDocAIvsVision(docaiLines, lineItems)
      : null;

    LOG.info(`Vision audit complete in ${Date.now() - startTime}ms — ${fields.length} fields, ${lineItems.length} lines${lineItemTally ? ', tally: '+lineItemTally.agreeCount+'/'+lineItemTally.totalLines+' agree' : ''}`);
    LOG.info('VISION_HANDLER_RETURN stats=%j fields=%d lineItems=%d', { total: fields.length, verified, corrected, flagged }, fields.length, lineItems.length);

    return JSON.stringify({
      documentId,
      schemaType: mode,
      invoiceMode: mode,
      fields,
      lineItems,
      suppressedLines: mergedSuppressedLines,
      lineItemCorrections: [],
      consistencyChecks: intelligence.consistencyChecks || [],
      lineItemTally,
      fieldComparison: this._buildFieldComparison({ invoiceMode: mode, fields: claudeFields || [], visionFields: fields, docaiLines: docaiLines || [], claudeLines: claudeLines || [], visionLines: lineItems, claudeRan: Array.isArray(claudeFields) && claudeFields.length > 0, visionRan: true }),
      summary: intelligence.summary || '',
      overallConfidence: intelligence.overallConfidence || 0,
      invoiceNetTotal,
      vendorTaxAmount,
      invoiceGrossTotal,
      invoiceTotalAmount: invoiceGrossTotal,
      invoiceFreightTotal: 0,
      apcReconciliation: null,
      generalInfo: [],
      reconciliation: { vendorTaxAmount, vertexTaxRate: null, vertexTaxAmount: null, taxabilityStatus: 'Pending Vertex', chargeabilityStatus: 'Pending Vertex' },
      stats: { total: fields.length, verified, corrected, flagged },
      _provenance: {
        invoiceNetTotal: { provenance: 'inferred', provenanceDetail: 'sum of line item amounts from vision extraction' },
        vendorTaxAmount: { provenance: vendorTaxAmount != null ? 'extracted' : null },
        invoiceGrossTotal: { provenance: 'inferred', provenanceDetail: vendorTaxAmount != null ? 'derived: invoiceNetTotal + vendorTaxAmount' : 'same as invoiceNetTotal' },
        invoiceFreightTotal: { provenance: 'extracted' }
      },
      processingTimeMs: Date.now() - startTime,
      visionAudit: true,
      costValue: { claudeTriggered: true, docAICostPerDoc: 0, claudeCostPerDoc: 0.02, totalCostPerDoc: 0.02 }
    });
  }

  async _handleListInvoices(req) {
    const bySCN = (assetData && assetData.bySCN) ? assetData.bySCN : assetData;
    let files;
    try {
      files = fs.readdirSync(INVOICE_FOLDER);
    } catch (err) {
      return req.error(500, `Cannot read invoice folder: ${err.message}`);
    }
    const results = files
      .filter(function(f) { return path.extname(f).toLowerCase() === '.pdf'; })
      .map(function(f) {
        const scnid = path.basename(f, '.pdf');
        const assetRecords = bySCN[scnid];
        const supplierName = (assetRecords && assetRecords[0] && assetRecords[0].supplierName) || '';
        return { scnid, fileName: f, supplierName, hasAssetData: !!assetRecords };
      })
      .sort(function(a, b) { return a.scnid.localeCompare(b.scnid); });
    return JSON.stringify(results);
  }

  async _handleGetInvoiceFile(req) {
    const { fileName } = req.data;
    if (!fileName) return req.error(400, 'fileName is required');
    // Security: reject any path separators or traversal sequences
    if (/[/\\]/.test(fileName) || fileName.includes('..')) {
      return req.error(400, 'Invalid fileName');
    }
    const filePath = path.join(INVOICE_FOLDER, fileName);
    // Confirm the resolved path is still inside INVOICE_FOLDER
    const resolvedFolder = path.resolve(INVOICE_FOLDER);
    const resolvedFile  = path.resolve(filePath);
    if (!resolvedFile.startsWith(resolvedFolder + path.sep) && resolvedFile !== resolvedFolder) {
      return req.error(400, 'Invalid fileName');
    }
    if (!fs.existsSync(resolvedFile)) {
      return req.error(404, `File not found: ${fileName}`);
    }
    const buf = fs.readFileSync(resolvedFile);
    return buf.toString('base64');
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

    const indexDocumentType = pass1.headerFields?.documentType?.value ?? null;
    const indexingConfidence = pass1.headerFields?.documentType?.confidence || 0;
    console.log('RAW documentType value:', JSON.stringify(pass1.headerFields?.documentType));
    const _dt = String(indexDocumentType || '').toLowerCase();
    const invoiceMode = (_dt.includes('construction') && !_dt.includes('non')) ? 'construction' : 'non_construction';
    console.log('CLASSIFICATION from index documentType:', indexDocumentType, '-> mode:', invoiceMode);
    LOG.info(`Doc AI routing: classified as ${invoiceMode} (raw documentType: "${indexDocumentType}")`);

    // ── Pass 2: Routed schema — full extraction ─────────────────
    const routedSchemaId = invoiceMode === 'construction'
      ? process.env.DOC_AI_SCHEMA_CONSTRUCTION
      : process.env.DOC_AI_SCHEMA_NON_CONSTRUCTION;
    const routedTo = invoiceMode;

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
      if (pollData.status === 'DONE') {
        console.log('DOC AI RAW RESULT:', JSON.stringify(pollData, null, 2));
        return this._normalizeDocAI(pollData);
      }
      if (pollData.status === 'FAILED') throw new Error('Doc AI extraction failed');
    }
    throw new Error('Doc AI timed out');
  }

  _normalizeDocAI(raw) {
    const headerFields = {};
    const ext = raw.extraction || {};
    if (ext.headerFields) {
      for (const f of ext.headerFields) {
        headerFields[f.name] = {
          value: f.value || '',
          confidence: Math.round((f.confidence || 0) * 100),
          page: f.page || 1,
          coordinates: f.coordinates || null
        };
      }
    }

    const allLines = (ext.lineItems || []).map(function(fieldArray) {
      console.log('LINE FIELDS:', JSON.stringify(fieldArray.map(f=>({name:f.name,value:f.value}))));
      const get = function(fieldName) {
        const f = (fieldArray || []).find(function(x){ return x.name === fieldName; });
        if (!f) return null;
        const v = (f.value === 'None' || f.value === '' || f.value == null) ? null : f.value;
        return v;
      };
      const desc = get('materialDescription');
      const rawAmount = get('netPrice') || get('Amount');
      const amount = rawAmount && rawAmount !== 'None' ? parseFloat(String(rawAmount).replace(/[^0-9.\-]/g,'')) : null;
      const safeAmount = (amount != null && !isNaN(amount)) ? amount : null;
      const rawLineType = get('lineType');
      const lineType = rawLineType ? rawLineType.toLowerCase() : null;
      const rawPageType = get('pageType');
      const pageType = rawPageType ? rawPageType.toLowerCase() : 'cont';
      const lineAction = (get('lineAction') || 'KEEP').toUpperCase();
      const isFreight = lineAction !== 'KEEP' && (
        /shipping|freight/i.test(lineType || '') ||
        /shipping|freight|delivery|estimated travel|travel and shipping|handling/i.test(desc || '')
      );
      console.log('CLASSIFIED AS:', {lineAction, lineType, isFreight});
      return {
        description: desc,
        amount: safeAmount,
        netAmount: safeAmount,
        netPrice: safeAmount,
        docAITaxAmount: get('taxAmount'),
        taxability: get('taxability'),
        lineAction,
        lineType,
        pageType,
        page: (fieldArray[0] && fieldArray[0].page) || 1
      };
    }).filter(function(li){ return li.description || li.amount != null; });

    // ── Header-level freight (e.g. shippingCostHeader field) ──
    const rawHdrFreight = (headerFields.shippingCostHeader?.value || '').trim();
    const headerFreightAmt = rawHdrFreight && rawHdrFreight !== 'None'
      ? (parseFloat(rawHdrFreight.replace(/[^0-9.\-]/g,'')) || 0) : 0;

    // ── Split on lineAction ────────────────────────────────────
    const keepLinesRaw = allLines.filter(function(li){ return li.lineAction === 'KEEP'; });
    const suppressedLines = allLines
      .filter(function(li){ return li.lineAction !== 'KEEP'; })
      .map(function(li){
        const d = li.description || '';
        const lt = li.lineType || '';
        const isShipping = /shipping|freight/i.test(lt) ||
          /shipping|freight|delivery|estimated travel|travel and shipping|handling/i.test(d);
        const isTax = !isShipping && (
          /tax|vat|gst/i.test(lt) ||
          /sales\s*tax|tax|vat|gst/i.test(d)
        );
        const isFreight = isShipping;
        const suppressReason = isShipping
          ? 'Freight/shipping — distributed across line items'
          : isTax
            ? 'Tax line — excluded (handled in tax layer)'
            : 'PO/PR/reference — not billable';
        return Object.assign({}, li, { suppressReason, isFreight, isTax });
      });

    // ── Vendor tax: header taxAmount field first, else sum of suppressed tax lines ──
    const rawHdrTax = (headerFields.taxAmount?.value || headerFields.taxAmountHeader?.value || '').trim();
    const hdrTaxAmt = rawHdrTax && rawHdrTax !== 'None'
      ? (parseFloat(rawHdrTax.replace(/[^0-9.\-]/g,'')) || null) : null;
    const lineTaxSum = suppressedLines
      .filter(function(li){ return li.isTax && li.amount != null; })
      .reduce(function(s, li){ return s + li.amount; }, 0);
    const vendorTaxAmount = hdrTaxAmt != null ? hdrTaxAmt : (lineTaxSum > 0 ? +lineTaxSum.toFixed(2) : null);

    // ── Freight total = suppressed line freight + header freight field ──
    const lineFreightTotal = +(suppressedLines
      .filter(function(li){ return li.isFreight && li.amount != null; })
      .reduce(function(s, li){ return s + li.amount; }, 0)).toFixed(2);
    const freightTotal = +(lineFreightTotal + headerFreightAmt).toFixed(2);

    const sumKeepNet = keepLinesRaw.reduce(function(s, li){ return s + (li.amount || 0); }, 0);

    let freightAllocated = 0, largestIdx = 0, largestAmt = -Infinity;
    const keepLines = keepLinesRaw.map(function(li, idx) {
      const net = li.amount || 0;
      if (net > largestAmt) { largestAmt = net; largestIdx = idx; }
      const rawFreight = sumKeepNet > 0 ? freightTotal * (net / sumKeepNet) : 0;
      const freight = +rawFreight.toFixed(2);
      freightAllocated += freight;
      return Object.assign({}, li, { freightAmount: freight, itemAmount: +(net + freight).toFixed(2) });
    });

    // Rounding remainder goes to the largest line
    const remainder = +(freightTotal - freightAllocated).toFixed(2);
    if (remainder !== 0 && keepLines.length > 0) {
      const lg = keepLines[largestIdx];
      lg.freightAmount = +(lg.freightAmount + remainder).toFixed(2);
      lg.itemAmount = +((lg.amount || 0) + lg.freightAmount).toFixed(2);
    }

    const invoiceNetTotal  = +(keepLines.reduce(function(s, li){ return s + li.itemAmount; }, 0)).toFixed(2);
    const invoiceFreightTotal = freightTotal;

    console.log('NORMALIZE: headerFreight=%d lineFreight=%d freightTotal=%d lineTax=%d vendorTax=%s net=%d',
      headerFreightAmt, lineFreightTotal, freightTotal, lineTaxSum, vendorTaxAmount, invoiceNetTotal);

    return { headerFields, keepLines, suppressedLines, invoiceNetTotal, invoiceFreightTotal, vendorTaxAmount, raw };
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
      return `  Row ${i + 1}: description="${li.description || ''}" | netPrice="${li.netPrice != null ? li.netPrice : ''}" | taxability="${li.taxability || ''}" | lineAction="${li.lineAction || 'KEEP'}"`;
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

  async _callVisionAudit(imageBase64) {
    const authUrl       = process.env.AI_CORE_AUTH_URL;
    const clientId      = process.env.AI_CORE_CLIENT_ID;
    const clientSecret  = process.env.AI_CORE_CLIENT_SECRET;
    const deploymentUrl = process.env.AI_CORE_DEPLOYMENT_URL;
    const resourceGroup = process.env.AI_CORE_RESOURCE_GROUP || 'use-tax';
    const modelName     = process.env.AI_CORE_MODEL || 'anthropic--claude-4.5-sonnet';

    if (!authUrl || !clientId) throw new Error('AI Core credentials not configured');

    const tokenRes = await fetch(authUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret })
    });
    if (!tokenRes.ok) throw new Error(`AI Core token failed: ${tokenRes.status}`);
    const { access_token } = await tokenRes.json();

    const orchBody = {
      orchestration_config: {
        module_configurations: {
          templating_module_config: { template: [{ role: 'user', content: '{{?instruction}}' }] },
          llm_module_config: { model_name: modelName, model_params: { max_tokens: 8192 } }
        }
      },
      input_params: { instruction: 'Analyze the invoice image provided and return the structured field audit as JSON.' },
      messages_history: [
        {
          role: 'user',
          content: [
            { type: 'text', text: this._buildVisionPrompt() },
            { type: 'image_url', image_url: { url: `data:image/png;base64,${imageBase64}` } }
          ]
        }
      ]
    };

    console.log('VISION_DIAG calling model=%s image_b64_len=%d url=%s', modelName, imageBase64 ? imageBase64.length : 0, deploymentUrl);
    let rawResponseText;
    try {
      const response = await fetch(deploymentUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${access_token}`,
          'Content-Type': 'application/json',
          'AI-Resource-Group': resourceGroup
        },
        body: JSON.stringify(orchBody)
      });

      // Capture raw text before any parsing so we can log it unconditionally
      rawResponseText = await response.text();
      console.log('VISION_DIAG HTTP status=%d raw_body_len=%d', response.status, rawResponseText.length);
      console.log('VISION_DIAG RAW BODY (first 4000):', rawResponseText.substring(0, 4000));

      if (!response.ok) {
        throw new Error(`AI Core vision call failed: ${response.status} ${rawResponseText}`);
      }

      const data = JSON.parse(rawResponseText);
      const orchestrationResult = data.orchestration_result;
      const rawContent = orchestrationResult?.choices?.[0]?.message?.content;
      console.log('VISION_DIAG top_keys=%j', Object.keys(data));
      console.log('VISION_DIAG orch_present=%s choices=%d finish=%s', !!orchestrationResult, orchestrationResult?.choices?.length ?? 0, orchestrationResult?.choices?.[0]?.finish_reason ?? 'n/a');
      console.log('VISION_DIAG content_type=%s is_array=%s raw_len=%d', typeof rawContent, Array.isArray(rawContent), rawContent == null ? -1 : (typeof rawContent === 'string' ? rawContent.length : JSON.stringify(rawContent).length));

      // Claude via Orchestration may return content as an array of content blocks rather than a plain string
      let content;
      if (Array.isArray(rawContent)) {
        const textBlocks = rawContent.filter(b => b.type === 'text').map(b => b.text);
        content = textBlocks.join('');
        console.log('VISION_DIAG content was array: %d block(s), %d text block(s), joined_len=%d', rawContent.length, textBlocks.length, content.length);
      } else {
        content = rawContent || '';
      }
      // Log the exact string the model returned, before any cleaning or parsing
      console.log('VISION_DIAG MODEL RAW CONTENT len=%d first-char=%s last-char=%s', content.length, JSON.stringify(content[0]), JSON.stringify(content[content.length - 1]));
      console.log('VISION_DIAG MODEL RAW CONTENT (first 6000):\n', content.substring(0, 6000));
      if (content.length > 6000) console.log('VISION_DIAG MODEL RAW CONTENT (last 500):\n', content.substring(content.length - 500));

      const cleaned = content.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
      console.log('VISION_DIAG cleaned_len=%d preview=%s', cleaned.length, cleaned.substring(0, 200));
      let parsedFields;
      try {
        parsedFields = JSON.parse(cleaned);
      } catch (e) {
        console.log('VISION PARSE FAILED:', e.message, '| cleaned_len:', cleaned.length);
        console.log('VISION CLEANED CONTENT:', cleaned.substring(0, 3000));
        throw e;
      }
      console.log('VISION PARSED: fields=%d lineItems=%d corrections=%d', parsedFields.fields ? parsedFields.fields.length : 0, parsedFields.lineItems ? parsedFields.lineItems.length : 0, parsedFields.lineItemCorrections ? parsedFields.lineItemCorrections.length : 0);
      return parsedFields;
    } catch (err) {
      console.log('VISION_DIAG CAUGHT ERROR name=%s message=%s', err.name, err.message);
      console.log('VISION_DIAG CAUGHT ERROR stack=%s', err.stack || '(no stack)');
      if (rawResponseText !== undefined) {
        console.log('VISION_DIAG raw body at time of error (first 2000):', rawResponseText.substring(0, 2000));
      }
      throw err;
    }
  }

  _buildVisionPrompt() {
    return `You are auditing an invoice by reading its image directly. You are the primary extraction source — there is no prior OCR output to compare against. Extract and verify the COMPLETE field set from what you see in the image, matching the same coverage as a full Doc AI + Claude text audit.

For each field:
1. Extract the value you can read from the image. Set docAIValue = correctValue (you are the sole extractor).
2. verdict = VERIFIED if clearly legible; FLAGGED if partially obscured, ambiguous, or absent.
3. confidence (0-100): 95-100 = printed clearly and unambiguously; 75-90 = present but minor obstruction; 50-74 = partially legible or inferred; <50 = guessed or not visible.
4. routedTo = "claude-vision" on EVERY field without exception.
5. If a field is genuinely absent from the invoice, output it with correctValue = "" and verdict = FLAGGED.

ADDRESS PRIORITY (determines tax jurisdiction — critical):
CRITICAL — VENDOR ADDRESS EXCLUSION: The vendor's/supplier's own address is NEVER a valid ship-to, even if it is the only address on the invoice. The supplier address appears in the letterhead, logo block, "From:", "Remit to:", or sender section — this is where the VENDOR is located. For USE tax, ship-to is where ACCENTURE received or used the goods/services. If an address appears alongside or beneath the vendor company name (e.g. top-left letterhead, remit-to box), treat it as the VENDOR address and exclude it from ship-to selection. Detection: if the street/city in a candidate block matches the vendor's letterhead location, reject it.

EXPLICIT SHIP-TO BLOCK — READ DIRECTLY (no inference needed): If the invoice has a labeled "Ship-To:", "Deliver To:", or equivalent address block, extract shipToAddress, shipToCity, shipToState, shipToCounty, and shipToPostalCode directly from it. Mark each field VERIFIED. Do NOT override an explicit Ship-To with project or contract addresses — those are fallbacks only.

Use the priority chain below ONLY when no labeled Ship-To block is present:
- NON-CONSTRUCTION fallback: Project Address > Contract/Delivery Address > Accenture Bill-To (500 W Madison, Chicago — last resort only)
- CONSTRUCTION fallback: Project Address > Contract/Delivery Address > Accenture Bill-To (last resort only)

If NONE of the above blocks are present and only the vendor address exists: set shipToAddress/City/State/PostalCode each to "Manual Action Required — no valid delivery address found" and mark each FLAGGED.

Identify ALL address blocks visible on the invoice (Ship-to, Project, Contract, Bill-To/Accenture, Vendor/Sender) and extract each one separately. The tax-jurisdiction fields (shipToAddress/City/State/PostalCode) must come from the winning block per the priority above.

taxCritical = true for: shipToAddress, shipToCity, shipToState, shipToPostalCode, grossAmount, taxAmount, taxAmountHeader.
taxCritical = false for all other fields.

REQUIRED FIELDS — extract every one, in this order:

Core invoice header:
  vendorName              — legal entity issuing the invoice (not a remit-to processor)
  invoiceNumber           — invoice / document number
  documentDate            — invoice date, MM/DD/YYYY
  purchaseOrderNumber     — PO number (Accenture POs: 10-digit, start with 6)
  grossAmount             — total amount due on the invoice (strip currency symbols)
  netAmount               — subtotal before tax (strip currency symbols; empty string if not shown)
  subTotal                — line items subtotal if printed separately (empty string if not shown)
  taxAmount               — tax dollar amount from a header tax field; null if not present as a header
  taxAmountHeader         — same as taxAmount if printed as a header-level field; null if absent
  taxPercentage           — tax rate printed on the invoice as a percentage (e.g. "5.5"); null if absent
  totalTaxableAmount      — taxable base amount if explicitly printed; null if absent
  shippingCostHeader      — freight/shipping amount from a header field (not a line item); null if absent
  workCompletedThisPeriodTotal — for construction invoices: current-period total from sworn statement or application; null if not a construction invoice or not present

Winning tax-jurisdiction address (per priority rule above):
  shipToAddress           — street address of the winning block
  shipToCity              — city of the winning block
  shipToState             — two-letter state abbreviation
  shipToPostalCode        — ZIP code

Project address block (extract if visible — may be the winning block for construction):
  projectAddress          — street address
  projectAddressCity      — city
  projectAddressState     — state abbreviation
  projectAddressPostalCode — ZIP

Contract/delivery address block (extract if visible):
  contractDetails         — street address
  contractDetailsCity     — city
  contractDetailsPostalcode — ZIP (no state field for this block)

Bill-To / Accenture address block (extract if visible — for reference only, never the tax address):
  accentureAddress        — street address
  accentureAddressCity    — city
  accentureAddressState   — state
  accentureAddressPostalCode — ZIP

Other:
  country                 — country of the delivery/project address (e.g. "US")

LINE ITEMS — extract all visible rows:
- For each line: unspsc (if printed, else ""), description, amount (as printed on invoice), isFreight, lineVerdict, lineReason (what you saw), lineConfidence, page (page number the line appears on, default 1).
- Freight/shipping lines: isFreight=true if description matches (case-insensitive): "shipping", "freight", "delivery", "estimated travel and shipping", "travel and shipping", "handling", "shipping & handling". Set lineVerdict="SUPPRESSED", lineReason="Freight/shipping — distributed across line items".
- Tax lines: lineVerdict="SUPPRESSED", isFreight=false, lineReason="Tax line — handled in tax layer". Detect by description matching "sales tax", "tax", "VAT", "GST", or similar.
- Subtotal/total/aggregation rows: lineVerdict="SUPPRESSED", lineReason="Subtotal/total row — not a billable line item".
- PO/Ariba reference rows with no real billable amount: lineVerdict="SUPPRESSED", lineReason="PO/reference — not billable".
- Zero-amount lines (amount=0 or blank): lineVerdict="SUPPRESSED", lineReason="zero amount — not billable". This includes document/drawing/title rows, cover-sheet entries, and any line whose printed amount is $0.00.
- Real billable lines (non-zero amount, not freight, not tax, not PO/PR reference, not a total row): lineVerdict="VERIFIED" (or FLAGGED if unreadable).

CONSISTENCY CHECKS — report these:
- Do line item amounts sum to the invoice subtotal/gross?
- If tax rate and tax amount are both visible, does base × rate ≈ tax amount?
- Is ship-to state consistent with city and ZIP?

Return ONLY this JSON — no markdown fences, no prose before or after:
{
  "invoiceMode": "non_construction",
  "invoiceTaxRate": 0,
  "vendorTaxAmount": null,
  "fields": [
    { "fieldName": "vendorName", "docAIValue": "", "correctValue": "", "verdict": "VERIFIED", "confidence": 0, "reason": "read from invoice header top-left", "taxCritical": false, "routedTo": "claude-vision" }
  ],
  "lineItems": [
    { "unspsc": "", "description": "", "amount": 0, "isFreight": false, "lineVerdict": "VERIFIED", "lineReason": "", "lineConfidence": 80, "page": 1 }
  ],
  "lineItemCorrections": [],
  "consistencyChecks": [
    { "check": "Line items sum to gross", "result": "PASS|FAIL|UNKNOWN", "detail": "" }
  ],
  "summary": "2-3 sentence summary of image legibility, field coverage, and overall confidence.",
  "overallConfidence": 0
}`;
  }

  _buildAuditPrompt(schemaType) {
    return `You are an invoice extraction intelligence auditor for US USE Tax processing. SAP Document AI extracted fields from an invoice at roughly 80-95% accuracy. Your job is to audit EVERY field and EVERY line item INDEPENDENTLY against the raw invoice text, correct errors, and provide a specific per-field verdict with explicit evidence.

CORE INSTRUCTION — INDEPENDENT PER-FIELD AUDIT:
Process each header field one at a time, in isolation. For each field:
  1. Locate the relevant section(s) of the invoice text that contain that field's value.
  2. Compare Doc AI's extracted value against what is actually printed there.
  3. Assign a verdict (VERIFIED / CORRECTED / FLAGGED) based on that field's own evidence alone — do NOT let another field's verdict influence this one.
  4. Write a reason that is SPECIFIC to this field: name (a) what Doc AI produced, (b) which block/section of the invoice you found the value in, and (c) what the correct value is and why.
     Good example: "Doc AI read 'Chicago' from the Bill-To block; per non-construction address priority, the tax jurisdiction is the Ship-To block which shows 'Houston TX 77002'."
     Bad example: "Verified against invoice." — too vague, rejected.
  5. Set confidence (0-100) based on clarity: 95-100 = value printed unambiguously; 75-90 = clearly present but minor formatting variation; 50-74 = inferred or partially legible; <50 = guessed or contradictory.

FIELD VERDICTS:
- VERIFIED: Doc AI value is factually correct — matches the right source block and passes domain rules. Use VERIFIED even if the extracted text includes extra lines (name, attn, full address block) as long as the data itself is correct and from the right source.
- CORRECTED: Doc AI value is factually WRONG — wrong source block (e.g. Bill-To used instead of Ship-To), wrong city/state/amount, misread characters, or missing when clearly present in the invoice. The error must be a FACTUAL mistake, not a formatting or completeness preference.
- FLAGGED: value is ambiguous, contradictory, or unconfirmable; needs human review

WHAT IS NOT A CORRECTION — do NOT set verdict=CORRECTED for any of these:
- Formatting differences: Doc AI returned a multi-line address block (including name, Attn, street, city/state/zip) and the data is from the right source block. Stripping it to just the street line is a formatting preference, not a correction. Mark VERIFIED.
- Completeness preferences: Doc AI included more lines than the "minimum" needed. If the correct block was extracted, extra lines are not errors.
- Abbreviation style: "CA" vs "California", "$1,234.56" vs "1234.56" — these are not corrections if the value is factually the same.
- Date format normalization: if Doc AI returned a date in ISO format (e.g. "2025-01-15") or long form ("January 15, 2025") and it represents the SAME calendar date as MM/DD/YYYY ("01/15/2025"), set correctValue to MM/DD/YYYY and mark VERIFIED. Only mark CORRECTED if the actual day, month, or year is wrong.
- Rewording correct descriptions: changing the phrasing of an accurate description is a preference, not a fix.
Reserve CORRECTED strictly for: wrong source block, wrong jurisdiction, wrong/misread amount, factually incorrect data, wrong calendar date.

ROUTED-TO (include on every field — indicates which layer is responsible for the final value):
- "docai": Doc AI extracted it correctly; you confirmed it (verdict=VERIFIED, confidence>=85). No Claude change was needed.
- "claude-text": You verified it at low confidence (<85) OR you corrected or flagged it. Claude's text audit is authoritative for this field.
- "claude-vision": Reserved for the future vision layer — do NOT assign this value in your response.
Rule: if verdict=VERIFIED and confidence>=85 → routedTo="docai". All other cases → routedTo="claude-text".

DOMAIN RULES:
1. ADDRESS PRIORITY (determines tax jurisdiction — critical):
   CRITICAL — VENDOR ADDRESS EXCLUSION: The vendor's/supplier's own address is NEVER a valid ship-to. The vendor address appears in the letterhead, logo block, "From:", "Remit to:", or sender section at the top of the invoice — it is where the VENDOR is located, not where Accenture received or used the goods/services. If Doc AI placed a vendor/sender address into any ship-to field, that is a FACTUAL ERROR — mark CORRECTED. Detection: if the street/city in a Doc AI ship-to field matches the vendor's letterhead city or appears in the sender block, reject it.
   EXPLICIT SHIP-TO BLOCK — READ DIRECTLY (no inference needed): If the invoice has a labeled "Ship-To:", "Deliver To:", or equivalent address block, extract shipToAddress, shipToCity, shipToState, shipToCounty, and shipToPostalCode directly from it. Mark each field VERIFIED (provenance: extracted). Do NOT override an explicit Ship-To with a project or contract address — those are fallbacks only.
   Use the priority chain below ONLY when no labeled Ship-To block is present:
   - CONSTRUCTION: Project Address > Contract Address > Accenture Bill-To (last resort only)
   - NON-CONSTRUCTION: Project Address > Contract Address > Accenture Bill-To (last resort only)
   Once a fallback block wins, take all ship-to fields from that SAME block — never mix fields from different blocks. In the reason, state which block won and why Ship-To was absent. If Doc AI pulled fields from the vendor address or from the wrong block, CORRECT them.
   If NONE of the valid blocks are present (only the vendor address exists): set correctValue to "Manual Action Required — no valid delivery address found" and mark FLAGGED for all ship-to fields.
   ADDRESS COMPLETENESS: If Doc AI extracted the correct block but included the recipient name, Attn line, or full multi-line address text, that is NOT an error — mark VERIFIED. Only CORRECT if the data came from the wrong block, the vendor address, or if city/state/zip are factually wrong.
2. VENDOR NAME: legal entity issuing the invoice, not the remit-to processor.
3. PO NUMBER: 10-digit number starting with 6 for Accenture POs.
4. DATES: The app is US-based; expected display format is MM/DD/YYYY. If Doc AI returned the same date in a different format (ISO, long-form, etc.), set correctValue to MM/DD/YYYY and mark VERIFIED — format-only normalization is NOT a correction. Only mark CORRECTED if the actual calendar date (day, month, or year) is factually wrong.
5. AMOUNTS: strip currency symbols; use current-period/total-due, not cumulative.
6. TAX AMOUNT RECOVERY: If the docAIValue for taxAmount/vendorTaxAmount is blank or null, scan the provided line items for any suppressed tax rows (description matching "sales tax", "tax", "VAT", "GST", or similar). If one or more are found, the correct taxAmount is the sum of those line amounts. Set verdict=CORRECTED, reason="Recovered from suppressed tax line '[exact description]' = [amount]" (list each line if more than one), routedTo="claude-text". This is a legitimate correction — Doc AI captured tax as a line row rather than a header field; the intelligence layer surfaces it as the vendor tax amount.
   Conversely, if a header taxAmount field IS populated and it matches a suppressed tax line total, mark it VERIFIED (the header field and line agree).

CROSS-FIELD CONSISTENCY CHECKS (report each pass/fail with detail):
- Do line-item amounts sum to the invoice subtotal/total?
- If tax amount and rate both present, does base x rate approx equal tax amount?
- Is ship-to state consistent with ship-to city/ZIP?
- Construction: does workCompletedThisPeriodTotal match the current-period column sum?

LINE ITEMS - audit every line; classify freight; code does the math:
- CORRECT page-2+ column drift using page-1 headers.
- ${schemaType === 'construction' ? 'CONSTRUCTION: current-period column (Work Completed This Period > Current Bill > This Period); prefer Sworn Statement totals.' : 'NON-CONSTRUCTION: keep lines where amount != 0; use current-period/invoice column.'}
- For EACH line output: unspsc, description, amount (raw, exactly as extracted), isFreight, lineVerdict, lineReason, lineConfidence.
- isFreight=true if description matches (case-insensitive): "shipping", "freight", "delivery", "estimated travel and shipping", "travel and shipping", "handling", "shipping & handling". Otherwise false.
- Do NOT compute freightAmount, netAmount, or itemAmount — code handles freight distribution.

LINE ITEM VERDICT RULES (audit each line against the invoice text):
- "VERIFIED" — amount and description match the source document; this is a real billable line.
- "CORRECTED" — Doc AI misread the amount or description; output the corrected amount/description and explain in lineReason (e.g. "Doc AI read 3,930 as 39.30 — corrected to match invoice").
- "SUPPRESSED" — this row must NOT be a billable line: PO/Ariba reference rows, subtotal/total rows, breakdown sub-rows labeled "included in total above", tax lines, or freight/shipping lines (use isFreight=true for freight; still set lineVerdict="SUPPRESSED" on freight lines). Explain in lineReason.
- "SUPPRESSED" (REIMBURSABLE BACKUP RECEIPTS): Expense invoices sometimes list a named-expense or reimbursable-total SUMMARY line (e.g. "Sheehan, David — $114.00 Reimbursable Expenses") immediately followed by individual receipt/backup lines (e.g. "$2.90 subway fare", "transit ticket $3.50"). The backup lines document the summary — they are NOT additional billable items. Detection: (a) a summary/named-expense line exists AND (b) the backup line amounts sum to approximately the summary amount (within ±5%). When detected: keep the summary line as VERIFIED; set each backup receipt line to lineVerdict="SUPPRESSED", lineReason="Backup receipt for [summary description] — rolled up into summary total; suppressed to prevent double-counting". For each suppressed backup line emit a lineItemCorrections entry: action="SUPPRESSED_BREAKUP", description=[backup line description], reason="Backup receipt detail for [summary description] — amounts sum to [total]", oldValue=[backup amount as string], newValue="0". ONLY suppress when a matching summary line exists AND amounts approximately sum to it; if no clear summary exists, keep all lines as VERIFIED/FLAGGED.
- "FLAGGED" — ambiguous; needs human review.

LINE ITEM OUTPUT MODE:
- CONSTRUCTION invoice: output ONE consolidated line (isFreight=false, lineVerdict="VERIFIED"): description "Non-Residential building construction services", amount = SUM of eligible current-period amounts (use SWORN amounts if a Sworn Statement is present). Set grossAmount from workCompletedThisPeriodTotal.
- NON-CONSTRUCTION invoice: output ALL lines including freight (isFreight=true) and suppressed rows, each with their lineVerdict. Code will filter displayable lines.

OUTPUT - return ONLY this JSON, no markdown:
{
  "invoiceMode": "${schemaType === 'construction' ? 'construction' : 'non_construction'}",
  "invoiceTaxRate": 0,
  "vendorTaxAmount": null,
  "fields": [
    { "fieldName": "vendorName", "docAIValue": "", "correctValue": "", "verdict": "VERIFIED|CORRECTED|FLAGGED", "confidence": 0, "reason": "Specific evidence for THIS field only — e.g. 'Doc AI read X from the Y block; correct value per Z rule is W'", "taxCritical": true, "routedTo": "docai|claude-text" }
  ],
  "lineItems": [
    { "unspsc": "", "description": "", "amount": 0, "isFreight": false, "lineVerdict": "VERIFIED|CORRECTED|SUPPRESSED|FLAGGED", "lineReason": "", "lineConfidence": 95, "page": 1 }
  ],
  "lineItemsTotal": 0,
  "lineItemCorrections": [
    { "action": "SUPPRESSED_BREAKUP|SUPPRESSED_PRPO|SUPPRESSED_TAX|CORRECTED_AMOUNT", "description": "", "reason": "", "oldValue": "", "newValue": "" }
  ],
  "consistencyChecks": [
    { "check": "Line items sum to total", "result": "PASS|FAIL", "detail": "" }
  ],
  "summary": "2-3 sentence executive summary of extraction quality and what the AI improved",
  "overallConfidence": 0
}

Set lineItemsTotal = sum of all lineItems[].amount where lineVerdict != "SUPPRESSED". Set invoiceTaxRate to the tax rate printed on the invoice (0 if absent). Set vendorTaxAmount to the total tax dollar amount printed on the invoice (header tax total, or sum of line taxes if shown) — extract only what is printed, do NOT compute or estimate; set to null if the invoice shows no tax amount. Audit at minimum these fields, each with its own independent verdict, confidence, and specific evidence-based reason: vendorName, invoiceNumber, documentDate, purchaseOrderNumber, grossAmount, taxAmount, shipToAddress, shipToCity, shipToState, shipToPostalCode. Mark shipTo*, grossAmount, taxAmount as taxCritical=true. A reason of "Verified against invoice" or "Matches extracted value" is not acceptable — every reason must state what the text actually shows and where.`;
  }

  _getMockAudit(docAIHeader, docAILineItems) {
    const fields = Object.entries(docAIHeader).map(([k, v]) => {
      const conf = v.confidence || 0;
      return {
        fieldName: k, docAIValue: v.value || '', correctValue: v.value || '',
        verdict: 'VERIFIED', confidence: conf, reason: 'AI Core unavailable - passthrough', taxCritical: false,
        routedTo: conf >= 85 ? 'docai' : 'claude-text'
      };
    });
    return {
      fields,
      lineItems: docAILineItems.map(li => ({
        unspsc: '', description: li.description || '',
        amount: li.amount || 0, netAmount: li.amount || 0,
        itemAmount: li.itemAmount != null ? li.itemAmount : (li.amount || 0),
        freightAmount: li.freightAmount || 0,
        lineVerdict: 'VERIFIED', lineReason: 'AI Core unavailable — Doc AI passthrough',
        lineConfidence: 50, lineAction: li.lineAction || 'KEEP', page: li.page || 1
      })),
      lineItemCorrections: [], consistencyChecks: [], freightTotal: 0,
      summary: 'AI Core unavailable - showing Document AI output without intelligence audit.',
      overallConfidence: 0
    };
  }

  _mockJurisdictionTax(netBase, freightBase, invoiceCombinedRate) {
    const combined = (invoiceCombinedRate && invoiceCombinedRate > 0) ? invoiceCombinedRate : 8.875;
    const split = [
      { jurisdiction: 'STATE',    ratio: 0.451 },
      { jurisdiction: 'COUNTY',   ratio: 0.100 },
      { jurisdiction: 'CITY',     ratio: 0.408 },
      { jurisdiction: 'DISTRICT', ratio: 0.041 }
    ];
    let rows = [];
    let allocated = 0;
    split.forEach(function (s, i) {
      let rate = (i === split.length - 1)
        ? +(combined - allocated).toFixed(3)
        : +(combined * s.ratio).toFixed(3);
      allocated += rate;
      const lineTax = +(netBase * rate / 100).toFixed(2);
      const freightTax = +(freightBase * rate / 100).toFixed(2);
      rows.push({
        jurisdiction: s.jurisdiction,
        taxability: 'TAXABLE',
        taxRate: rate,
        taxableAmountLine: +netBase.toFixed(2),
        taxAmountLine: lineTax,
        taxableAmountFreight: +freightBase.toFixed(2),
        taxAmountFreight: freightTax,
        totalTaxAmount: +(lineTax + freightTax).toFixed(2)
      });
    });
    const totals = rows.reduce(function (a, r) {
      a.rate += r.taxRate; a.line += r.taxAmountLine; a.freight += r.taxAmountFreight; a.total += r.totalTaxAmount; return a;
    }, { rate: 0, line: 0, freight: 0, total: 0 });
    return {
      rows: rows,
      totalRate: +totals.rate.toFixed(3),
      totalLineTax: +totals.line.toFixed(2),
      totalFreightTax: +totals.freight.toFixed(2),
      totalTax: +totals.total.toFixed(2)
    };
  }

  _enrichTaxAndFreight(intelligence) {
    const items = intelligence.lineItems || [];
    const invoiceRate = parseFloat(intelligence.invoiceTaxRate) || 0;
    const vendorTaxAmount = (intelligence.vendorTaxAmount != null && intelligence.vendorTaxAmount !== '')
      ? parseFloat(intelligence.vendorTaxAmount)
      : null;

    const freightLines    = items.filter(li => li.isFreight);
    const suppressedLines = items.filter(li => !li.isFreight && li.lineVerdict === 'SUPPRESSED');
    const realLines       = items.filter(li => !li.isFreight && li.lineVerdict !== 'SUPPRESSED');

    const freightTotal = freightLines.reduce((s, li) => s + (parseFloat(li.amount) || 0), 0);
    const sumRealNet   = realLines.reduce((s, li) => s + (parseFloat(li.amount) || 0), 0);

    // Distribute freight proportionally across real lines; rounding guard on largest line.
    let freightAllocated = 0;
    let largestIdx = 0, largestAmt = -Infinity;
    const enrichedItems = realLines.map(function (li, idx) {
      const net = parseFloat(li.netAmount != null ? li.netAmount : li.amount) || 0;
      const rawFreight = sumRealNet > 0 ? freightTotal * (net / sumRealNet) : 0;
      const freight = +rawFreight.toFixed(2);
      freightAllocated += freight;
      if (net > largestAmt) { largestAmt = net; largestIdx = idx; }
      return Object.assign({}, li, {
        netAmount: +net.toFixed(2),
        freightAmount: freight,
        itemAmount: +(net + freight).toFixed(2),
        vertexTaxAmount: null,
        freightTaxAmount: null,
        jurisdictions: null,
        jurisdictionTotals: null
      });
    });

    // Assign rounding remainder to the largest line.
    const remainder = +(freightTotal - freightAllocated).toFixed(2);
    if (remainder !== 0 && enrichedItems.length > 0) {
      const lg = enrichedItems[largestIdx];
      lg.freightAmount = +(lg.freightAmount + remainder).toFixed(2);
      lg.itemAmount    = +(lg.netAmount + lg.freightAmount).toFixed(2);
    }

    const invoiceNetTotal = +(sumRealNet + freightTotal).toFixed(2);
    const invoiceTotalAmount = vendorTaxAmount != null
      ? +(invoiceNetTotal + vendorTaxAmount).toFixed(2)
      : invoiceNetTotal;

    intelligence.lineItems = enrichedItems;
    intelligence.suppressedLines = [...freightLines, ...suppressedLines];
    intelligence.reconciliation = {
      invoiceTaxRate: invoiceRate || null,
      vendorTaxAmount: vendorTaxAmount,
      vertexTaxRate: null,
      vertexTaxAmount: null,
      taxRateDifference: null,
      taxAmountDifference: null,
      taxabilityStatus: 'Pending Vertex',
      chargeabilityStatus: 'Pending Vertex',
      acceptanceStatus: ''
    };
    intelligence.invoiceNetTotal     = invoiceNetTotal;
    intelligence.invoiceFreightTotal = +freightTotal.toFixed(2);
    intelligence.vendorTaxAmount     = vendorTaxAmount;
    intelligence.invoiceTotalAmount  = invoiceTotalAmount;
    intelligence.vertexTaxTotal      = null;
    return intelligence;
  }

  _buildFieldComparison({ invoiceMode, fields, visionFields, docaiLines, claudeLines, visionLines, claudeRan = false, visionRan = false }) {
    const mode = String(invoiceMode || 'non_construction');
    const hFields = schemaHeaderFields(mode);
    const liFields = SCHEMA_FIELDS.lineItem[mode] || SCHEMA_FIELDS.lineItem.non_construction;

    const fMap = new Map((fields       || []).map(f => [f.fieldName, f]));
    const vMap = new Map((visionFields || []).map(f => [f.fieldName, f]));
    const norm = s => s != null ? String(s).toLowerCase().replace(/[\s,.$]/g, '') : '';

    // Header comparison — one row per schema field
    const header = hFields.map(name => {
      const f  = fMap.get(name);
      const vf = vMap.get(name);
      const dv = f  ? (f.docAIValue  || null) : null;
      const cv = claudeRan ? (f  ? (f.correctValue || f.docAIValue || null) : null) : undefined;
      const vv = visionRan ? (vf ? (vf.correctValue || vf.docAIValue || null) : null) : undefined;

      let bestValue = dv, bestLayer = dv != null ? 'docai' : null;
      if (claudeRan && cv != null && norm(cv) !== norm(dv)) { bestValue = cv; bestLayer = 'claude'; }
      if (visionRan && vv != null && norm(vv) !== norm(cv != null ? cv : dv)) { bestValue = vv; bestLayer = 'vision'; }

      return {
        fieldName:   name,
        taxCritical: TAX_CRITICAL_FIELDS.has(name),
        docAI:  f  ? { value: dv, confidence: f.confidence || 0 } : null,
        claude: claudeRan ? (f  ? { value: cv, verdict: f.verdict  || null, reason: f.reason  || null } : null) : undefined,
        vision: visionRan ? (vf ? { value: vv, verdict: vf.verdict || null, reason: vf.reason || null } : null) : undefined,
        bestValue,
        bestLayer
      };
    });

    // Line-item comparison — one entry per docAI line, fields matched across layers
    const getAmt    = li => parseFloat(li.itemAmount != null ? li.itemAmount : (li.amount || li.netPrice || 0)) || 0;
    const AMT_TOL   = 0.01;
    const matchLine = (pool, ref) => pool && pool.length
      ? pool.find(l => Math.abs(getAmt(l) - getAmt(ref)) <= AMT_TOL) || null : null;
    const liVal = (line, fn) => {
      if (!line) return null;
      const map = { materialDescription: 'description', netPrice: 'itemAmount', Amount: 'itemAmount',
                    taxAmount: 'taxAmount', taxability: 'taxability',
                    lineType: 'lineType', lineAction: 'lineAction', pageType: 'pageType' };
      const v = line[map[fn] || fn];
      return v != null ? v : null;
    };

    const lineItems = (docaiLines || []).map((dl, idx) => {
      const cl = claudeRan ? matchLine(claudeLines, dl) : undefined;
      const vl = visionRan ? matchLine(visionLines, dl) : undefined;
      const fieldMap = {};
      liFields.forEach(fn => {
        const dv = liVal(dl, fn);
        const cv = claudeRan ? liVal(cl, fn) : undefined;
        const vv = visionRan ? liVal(vl, fn) : undefined;
        const disagrees =
          (cv !== undefined && cv !== null && norm(String(cv)) !== norm(String(dv ?? ''))) ||
          (vv !== undefined && vv !== null && norm(String(vv)) !== norm(String(dv ?? '')));
        fieldMap[fn] = { docAI: dv, claude: cv, vision: vv, disagrees };
      });
      return { lineIndex: idx, docAI: { desc: dl.description, amount: getAmt(dl) }, fields: fieldMap };
    });

    return { invoiceMode: mode, header, lineItems };
  }

  _tallyLineItemsDocAIvsVision(docaiLines, visionLines) {
    const safeLines = arr => Array.isArray(arr) ? arr : [];
    const dLines = safeLines(docaiLines);
    const vLines = safeLines(visionLines);
    if (!dLines.length && !vLines.length) return { agreeCount: 0, totalLines: 0, discrepancies: [] };

    const normDesc = s => (s || '').toLowerCase().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();
    const AMT_TOL = 0.01;
    const DESC_THRESH = 0.5;

    const jaccard = (a, b) => {
      const wa = new Set(normDesc(a).split(' ').filter(Boolean));
      const wb = new Set(normDesc(b).split(' ').filter(Boolean));
      if (!wa.size && !wb.size) return 1;
      if (!wa.size || !wb.size) return 0;
      let inter = 0; wa.forEach(w => { if (wb.has(w)) inter++; });
      return inter / (wa.size + wb.size - inter);
    };

    const getAmt = li => parseFloat(li.netAmount != null ? li.netAmount : (li.amount != null ? li.amount : (li.itemAmount || 0))) || 0;
    const amtClose = (a, b) => Math.abs(a - b) <= AMT_TOL;

    const unused = new Set(vLines.map((_, i) => i));
    const discrepancies = [];
    let agreeCount = 0;

    dLines.forEach(dl => {
      const da = getAmt(dl);
      const dd = dl.description || '';

      // Amount is the strong key — find any unused Vision line within ±0.01
      let amtIdx = -1;
      for (const i of unused) {
        if (amtClose(da, getAmt(vLines[i]))) { amtIdx = i; break; }
      }

      if (amtIdx >= 0) {
        const vl = vLines[amtIdx];
        unused.delete(amtIdx);
        const descSim = jaccard(dd, vl.description || '');
        if (descSim >= DESC_THRESH) {
          agreeCount++;
        } else {
          discrepancies.push({
            type: 'DESC_MISMATCH',
            docAI: { desc: dd, amount: da },
            vision: { desc: vl.description || '', amount: getAmt(vl) },
            note: 'Amounts agree but descriptions differ meaningfully'
          });
        }
        return;
      }

      // No amount match — try description match
      let bestIdx = -1, bestSim = 0;
      for (const i of unused) {
        const sim = jaccard(dd, vLines[i].description || '');
        if (sim > bestSim) { bestSim = sim; bestIdx = i; }
      }

      if (bestIdx >= 0 && bestSim >= DESC_THRESH) {
        const vl = vLines[bestIdx];
        const va = getAmt(vl);
        unused.delete(bestIdx);
        const diff = da - va;
        const absDiff = Math.abs(diff);
        const nearMiss = absDiff > AMT_TOL && absDiff <= 1.00;
        discrepancies.push({
          type: nearMiss ? 'NEAR_MISS_OCR' : 'AMOUNT_MISMATCH',
          docAI: { desc: dd, amount: da },
          vision: { desc: vl.description || '', amount: va },
          note: nearMiss
            ? `Likely OCR single-digit misread: Doc AI ${da.toFixed(2)} vs Vision ${va.toFixed(2)} — diff ${diff >= 0 ? '+' : ''}${diff.toFixed(2)}. Verify by reading the invoice image.`
            : `Doc AI: ${da.toFixed(2)}, Vision: ${va.toFixed(2)}, diff: ${(da - va).toFixed(2)}`
        });
        return;
      }

      discrepancies.push({
        type: 'MISSING_IN_VISION',
        docAI: { desc: dd, amount: da },
        vision: null,
        note: 'Doc AI found this line; Vision did not.'
      });
    });

    for (const i of unused) {
      const vl = vLines[i];
      discrepancies.push({
        type: 'MISSING_IN_DOCAI',
        docAI: null,
        vision: { desc: vl.description || '', amount: getAmt(vl) },
        note: 'Vision found this line; Doc AI did not.'
      });
    }

    return { agreeCount, totalLines: Math.max(dLines.length, vLines.length), discrepancies };
  }

  _runConsistencyChecks(result) {
    const checks = [];
    const fmt = n => n != null ? (+n).toFixed(2) : '—';

    // 1. lineItemsSumToNet
    const lineItems = result.lineItems || [];
    const netTotal = result.invoiceNetTotal;
    if (lineItems.length > 0 && netTotal != null) {
      const lineSum = +(lineItems.reduce((s, li) => s + (li.itemAmount || 0), 0)).toFixed(2);
      const diff = +(lineSum - netTotal).toFixed(2);
      const passed = Math.abs(diff) <= 1.0;
      checks.push({
        name: 'lineItemsSumToNet', passed, severity: 'error',
        message: passed
          ? `Line items sum to ${fmt(lineSum)} ≈ invoice net ${fmt(netTotal)}.`
          : `Line items sum to ${fmt(lineSum)} but invoice net is ${fmt(netTotal)} (diff ${diff >= 0 ? '+' : ''}${fmt(diff)}).`,
        values: { lineSum, netTotal, diff }, provenance: 'inferred'
      });
    }

    // 2. grossEqualsNetPlusTax
    const vendorTax = result.vendorTaxAmount;
    const gross = result.invoiceGrossTotal;
    if (vendorTax != null && gross != null && netTotal != null) {
      const expected = +(netTotal + vendorTax).toFixed(2);
      const diff2 = +(gross - expected).toFixed(2);
      const passed = Math.abs(diff2) <= 1.0;
      checks.push({
        name: 'grossEqualsNetPlusTax', passed, severity: 'error',
        message: passed
          ? `Gross ${fmt(gross)} = net ${fmt(netTotal)} + tax ${fmt(vendorTax)}.`
          : `Gross ${fmt(gross)} ≠ net ${fmt(netTotal)} + tax ${fmt(vendorTax)} = ${fmt(expected)} (diff ${diff2 >= 0 ? '+' : ''}${fmt(diff2)}).`,
        values: { gross, netTotal, vendorTax, expected, diff: diff2 }, provenance: 'inferred'
      });
    }

    // 3. freightReconciles
    const freightTotal = result.invoiceFreightTotal;
    if (freightTotal != null && freightTotal > 0 && lineItems.length > 0) {
      const freightSum = +(lineItems.reduce((s, li) => s + (li.freightAmount || 0), 0)).toFixed(2);
      const diff3 = +(freightSum - freightTotal).toFixed(2);
      const passed = Math.abs(diff3) <= 1.0;
      checks.push({
        name: 'freightReconciles', passed, severity: 'error',
        message: passed
          ? `Distributed freight ${fmt(freightSum)} ≈ freight source ${fmt(freightTotal)}.`
          : `Distributed freight ${fmt(freightSum)} != freight source ${fmt(freightTotal)}.`,
        values: { freightSum, freightTotal, diff: diff3 }, provenance: 'inferred'
      });
    }

    // 4. poFormat
    const po = (result.purchaseOrderNumber || '').trim();
    if (po) {
      const passed = /^6001\d{6}$/.test(po);
      checks.push({
        name: 'poFormat', passed, severity: 'warning',
        message: passed
          ? `PO ${po} matches expected format.`
          : `PO ${po} doesn't match expected format (10-digit starting 6001).`,
        values: { purchaseOrderNumber: po }, provenance: 'inferred'
      });
    }

    // 5. shipToCompleteForVertex
    const shipToCity = result.shipToCity || null;
    const shipToPostalCode = result.shipToPostalCode || null;
    const shipOk = !!(shipToCity && shipToPostalCode);
    checks.push({
      name: 'shipToCompleteForVertex', passed: shipOk, severity: 'error',
      message: shipOk
        ? `Ship-to complete: ${shipToCity} ${shipToPostalCode}.`
        : 'Ship-to incomplete for Vertex (city or postal missing).',
      values: { shipToCity, shipToPostalCode }, provenance: 'inferred'
    });

    // 6. retainageSelfConsistency — catch within-invoice OCR near-misses on retainage rows
    // Uses rawLineItems (pre-consolidation) when available so construction schedules of values are checked
    const getLineAmt = li => parseFloat(li.netAmount != null ? li.netAmount : (li.amount != null ? li.amount : 0)) || 0;
    const checkLines = result.rawLineItems || result.lineItems || [];
    const retainageLines = checkLines.filter(li => /retainage|retention/i.test(li.description || ''));
    if (retainageLines.length >= 2) {
      const amounts = retainageLines.map(getLineAmt);
      const maxAmt = Math.max(...amounts), minAmt = Math.min(...amounts);
      const maxDiff = +(maxAmt - minAmt).toFixed(2);
      if (maxDiff >= 0.02) {
        checks.push({
          name: 'retainageSelfConsistency', passed: false, severity: 'warning',
          message: `Retainage values on ${retainageLines.length} rows disagree: [${amounts.map(fmt).join(', ')}] — max diff ${fmt(maxDiff)}. Possible single-digit OCR misread; verify against invoice image.`,
          values: { amounts, maxDiff, descriptions: retainageLines.map(li => li.description) },
          provenance: 'inferred'
        });
      }
    }

    return checks;
  }

  _determineManualAction(result, checks, fields) {
    const reasons = [];

    // Low-confidence fields
    (fields || []).forEach(f => {
      if (f.confidence != null && +f.confidence < 75) {
        reasons.push(`Low confidence on "${f.fieldName}": ${f.confidence}%`);
      }
    });

    // Failed error-severity consistency checks
    (checks || []).forEach(c => {
      if (!c.passed && c.severity === 'error') {
        reasons.push(`Consistency check failed [${c.name}]: ${c.message}`);
      }
    });

    // Empty/missing SCNID
    const scnid = (result.documentId || '').trim();
    if (!scnid || scnid.toUpperCase() === 'UNKNOWN') {
      reasons.push('SCNID is empty or missing.');
    }

    // Missing ship-to city or postal (only if not already captured by shipToCompleteForVertex check)
    if (!result.shipToCity || !result.shipToPostalCode) {
      const alreadyListed = (checks || []).some(c => c.name === 'shipToCompleteForVertex' && !c.passed);
      if (!alreadyListed) {
        reasons.push('Ship-to city or postal code missing — cannot determine jurisdiction.');
      }
    }

    // Missing UNSPSC on KEEP lines
    (result.lineItems || []).forEach((li, idx) => {
      if (!li.isFreight && (!li.unspsc || li.unspsc.trim() === '')) {
        reasons.push(`Line ${idx + 1} ("${li.description || 'unknown'}"): missing UNSPSC code.`);
      }
    });

    // Vertex fail — uncomment when Vertex is wired:
    // if (result.vertexFailed) reasons.push('Vertex tax lookup failed.');

    return { required: reasons.length > 0, reasons };
  }

  _resolveShipTo(getVal, invoiceMode) {
    const g = k => { const v = getVal(k); return (v == null || v === '') ? null : v; };
    const blocks = {
      project:   { city: g('projectAddressCity'),   postal: g('projectAddressPostalCode'),  state: g('projectAddressState'),   addr: g('projectAddress') },
      contract:  { city: g('contractDetailsCity'),  postal: g('contractDetailsPostalcode'), state: null,                       addr: g('contractDetails') },
      shipto:    { city: g('shipToCity'),            postal: g('shipToPostalCode'),          state: g('shipToState'),           addr: g('shipToAddress') },
      accenture: { city: g('accentureAddressCity'), postal: g('accentureAddressPostalCode'), state: g('accentureAddressState'), addr: g('accentureAddress') }
    };

    // Parse city/state/postal from a US address string when sub-fields are not separately extracted
    const parseAddrParts = addr => {
      if (!addr) return {};
      const m = addr.match(/\b([A-Z]{2})\s+(\d{5}(?:-\d{4})?)\b/);
      if (!m) return {};
      const state = m[1], postal = m[2];
      const before = addr.slice(0, m.index).replace(/,\s*$/, '').trim();
      const words = before.split(/[\s,]+/).filter(Boolean);
      const cityWords = [];
      for (let i = words.length - 1; i >= 0 && cityWords.length < 3; i--) {
        if (/^\d/.test(words[i])) break;
        cityWords.unshift(words[i]);
      }
      return { city: cityWords.join(' ') || null, state, postal };
    };

    const isConstruction = invoiceMode === 'construction';
    const order = isConstruction
      ? ['project', 'contract', 'shipto', 'accenture']
      : ['shipto', 'project', 'contract', 'accenture'];
    const LABELS = { shipto: 'ShipTo Address', project: 'Project Address', contract: 'Contract Details', accenture: 'Accenture Address' };
    const priorityStr = isConstruction ? 'Project > Contract > ShipTo > Accenture' : 'ShipTo > Project > Contract > Accenture';
    const modeLabel = isConstruction ? 'construction' : 'non-construction';

    for (const name of order) {
      const b = blocks[name];

      // Fill in city/state/postal from addr string when sub-fields are null
      let city = b.city, state = b.state, postal = b.postal;
      if ((!city || !postal) && b.addr) {
        const parsed = parseAddrParts(b.addr);
        city   = city   || parsed.city   || null;
        state  = state  || parsed.state  || null;
        postal = postal || parsed.postal || null;
      }

      if (!city && !postal) {
        console.log('_resolveShipTo: SKIP %s — no city/postal (addr: "%s")', name, (b.addr || '').substring(0, 60));
        continue;
      }

      const priorityNum = order.indexOf(name) + 1;
      const caption = `Resolved from: ${LABELS[name]} (priority ${priorityNum} for ${modeLabel}: ${priorityStr})`;
      const note = name === 'accenture'
        ? 'Accenture billing address used — no higher-priority address available on the invoice; this is an approximation, not the delivery location.'
        : null;
      const isExplicit = name === 'shipto';
      console.log('_resolveShipTo: winner=%s city=%s state=%s postal=%s explicit=%s', name, city, state, postal, isExplicit);
      return {
        shipToAddress: b.addr, shipToCity: city, shipToState: state, shipToPostalCode: postal,
        resolvedFrom: name, resolvedFromCaption: caption, resolvedFromNote: note,
        provenance: isExplicit ? 'extracted' : 'inferred',
        provenanceDetail: isExplicit ? 'explicit Ship-To address block on invoice' : caption
      };
    }

    console.log('_resolveShipTo: no block won — returning nulls');
    return {
      shipToAddress: null, shipToCity: null, shipToState: null, shipToPostalCode: null,
      resolvedFrom: 'none', resolvedFromCaption: null, resolvedFromNote: null,
      provenance: 'inferred', provenanceDetail: 'no address block resolved — all priority blocks empty'
    };
  }

  _consolidateConstruction(lineItems, freightTotal, headerFields) {
    const hasSworn = lineItems.some(li => (li.pageType || 'cont') === 'sworn');
    const activeType = hasSworn ? 'sworn' : 'cont';
    const eligible = lineItems.filter(li =>
      (li.pageType || 'cont') === activeType && li.lineAction === 'KEEP'
    );
    const sumNetPrice = +eligible.reduce(function(s, li){ return s + (li.amount || 0); }, 0).toFixed(2);
    const ft = +(freightTotal || 0).toFixed(2);
    const rawGross = ((headerFields.workCompletedThisPeriodTotal || {}).value || '').trim();
    const grossAmount = rawGross ? (parseFloat(rawGross.replace(/[^0-9.\-]/g,'')) || null) : null;
    console.log('CONSTRUCTION consolidate: activeType=%s eligible=%d sumNet=%d freight=%d', activeType, eligible.length, sumNetPrice, ft);
    return {
      description: 'Non-Residential building construction services',
      amount: sumNetPrice,
      netAmount: sumNetPrice,
      netPrice: sumNetPrice,
      freightAmount: ft,
      itemAmount: +(sumNetPrice + ft).toFixed(2),
      lineAction: 'KEEP',
      lineType: null,
      pageTypeUsed: activeType,
      consolidatedFrom: eligible.length,
      grossAmount
    };
  }

  _lookupAssetReport(documentId) {
    if (!documentId) return null;
    const base = String(documentId).split(/[\\/]/).pop().replace(/\.[^.]+$/, '');
    const m = base.match(/\d{6,}/);
    const scnid = m ? m[0] : null;
    if (!scnid) { console.log('Asset lookup: no scnid in', documentId); return null; }
    const bySCN = (assetData && assetData.bySCN) || {};
    if (bySCN[scnid]) {
      console.log('Asset lookup:', scnid, '-> direct');
      return { scnid, record: bySCN[scnid][0], matchPath: 'direct' };
    }
    try {
      if (scnMapping && scnMapping.s4ToDfm && scnMapping.s4ToDfm[scnid] && bySCN[scnMapping.s4ToDfm[scnid]]) {
        const dfm = scnMapping.s4ToDfm[scnid];
        console.log('Asset lookup:', scnid, '-> via s4ToDfm', dfm);
        return { scnid, record: bySCN[dfm][0], matchPath: 's4-to-dfm' };
      }
      if (scnMapping && scnMapping.dfmToS4 && scnMapping.dfmToS4[scnid] && bySCN[scnMapping.dfmToS4[scnid]]) {
        const s4 = scnMapping.dfmToS4[scnid];
        console.log('Asset lookup:', scnid, '-> via dfmToS4', s4);
        return { scnid, record: bySCN[s4][0], matchPath: 'dfm-to-s4' };
      }
    } catch (e) { console.log('Asset mapping fallback skipped:', e.message); }
    console.log('Asset lookup:', scnid, '-> no match');
    return { scnid, record: null, matchPath: 'none' };
  }

  _buildGeneralInfo(inv, asset) {
    const A = asset && asset.record ? asset.record : {};
    const norm = s => (s==null?'':String(s)).toLowerCase().replace(/[\s,.\-]/g,'');

    const STATE_MAP = {
      ALABAMA:'AL',ALASKA:'AK',ARIZONA:'AZ',ARKANSAS:'AR',CALIFORNIA:'CA',
      COLORADO:'CO',CONNECTICUT:'CT',DELAWARE:'DE',FLORIDA:'FL',GEORGIA:'GA',
      HAWAII:'HI',IDAHO:'ID',ILLINOIS:'IL',INDIANA:'IN',IOWA:'IA',
      KANSAS:'KS',KENTUCKY:'KY',LOUISIANA:'LA',MAINE:'ME',MARYLAND:'MD',
      MASSACHUSETTS:'MA',MICHIGAN:'MI',MINNESOTA:'MN',MISSISSIPPI:'MS',MISSOURI:'MO',
      MONTANA:'MT',NEBRASKA:'NE',NEVADA:'NV',NEWHAMPSHIRE:'NH',NEWJERSEY:'NJ',
      NEWMEXICO:'NM',NEWYORK:'NY',NORTHCAROLINA:'NC',NORTHDAKOTA:'ND',OHIO:'OH',
      OKLAHOMA:'OK',OREGON:'OR',PENNSYLVANIA:'PA',RHODEISLAND:'RI',SOUTHCAROLINA:'SC',
      SOUTHDAKOTA:'SD',TENNESSEE:'TN',TEXAS:'TX',UTAH:'UT',VERMONT:'VT',
      VIRGINIA:'VA',WASHINGTON:'WA',WESTVIRGINIA:'WV',WISCONSIN:'WI',WYOMING:'WY',
      DISTRICTOFCOLUMBIA:'DC'
    };
    const normState = s => {
      if (s==null||s==='') return '';
      const stripped = String(s).toUpperCase().replace(/[\s,.\-]/g,'');
      return STATE_MAP[stripped] || stripped;
    };

    // Fuzzy row: equality + substring includes (good for addresses)
    const row = (field, assetVal, invVal) => {
      const a = assetVal==null||assetVal===''?null:String(assetVal);
      const i = invVal==null||invVal===''?null:String(invVal);
      let match = null;
      if (a!=null && i!=null) match = norm(a)===norm(i) || norm(i).includes(norm(a)) || norm(a).includes(norm(i));
      return { field, assetReportValue: a, invoiceValue: i, match };
    };
    // Exact row: normalise then compare with equality only (city, state)
    const exactRow = (field, assetVal, invVal, normFn) => {
      const fn = normFn || norm;
      const a = assetVal==null||assetVal===''?null:String(assetVal);
      const i = invVal==null||invVal===''?null:String(invVal);
      let match = null;
      if (a!=null && i!=null) match = fn(a) === fn(i);
      return { field, assetReportValue: a, invoiceValue: i, match };
    };

    const assetCity = A.cityName || A.supplierCity || null;
    const assetState = A.stateName || A.supplierState || null;
    const assetPostal = A.supplierPostalCode || A.postalCodeShipTo || null;
    let shipMatch = null;
    if ((assetCity || assetPostal) && (inv.shipToCity || inv.shipToPostalCode)) {
      const cityOk = !assetCity || !inv.shipToCity || norm(assetCity) === norm(inv.shipToCity);
      const postalOk = !assetPostal || !inv.shipToPostalCode || norm(assetPostal) === norm(inv.shipToPostalCode);
      const stateOk = !assetState || !inv.shipToState || normState(assetState) === normState(inv.shipToState);
      shipMatch = cityOk && postalOk && stateOk;
    }
    return [
      row('Vendor Name',  A.supplierName,  inv.vendorName),
      row('SCNID',        A.scnId,         asset ? asset.scnid : null),
      { field: 'Ship-to Location', type: 'shipTo',
        invoiceAddress: inv.shipToAddress || null, invoiceCity: inv.shipToCity || null,
        invoiceState: inv.shipToState || null, invoicePostalCode: inv.shipToPostalCode || null,
        assetAddress: A.shipToAddressSAP || null, assetCity, assetState, assetPostal,
        caption: inv.resolvedFromCaption || null, note: inv.resolvedFromNote || null,
        match: shipMatch },
      row('Invoice Date', null,            inv.documentDate),
      row('PO Number',    A.poNumber,      inv.purchaseOrderNumber),
      row('Total Amount', null,            inv.invoiceNetTotal != null ? String(inv.invoiceNetTotal) : null),
      row('APC End',      A.apcEndValue,   null),
      row('Country',      A.supplierCountry, inv.country)
    ];
  }
};
