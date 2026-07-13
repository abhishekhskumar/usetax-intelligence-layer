namespace usetax.intelligence;

service DocumentIntelligenceService @(path: '/api/intelligence') {

  action extractDocAI(
    documentId : String,
    schemaType : String enum { construction; non_construction; indexing; auto },
    invoiceBase64 : LargeString,
    mediaType : String
  ) returns String;

  action processInvoice(
    documentId : String,
    docAIResult : LargeString
  ) returns String;

  action auditWithVision(
    documentId  : String,
    imageBase64 : LargeString,
    imagePages  : many LargeString,
    docAIResult : LargeString
  ) returns String;

  action listInvoices() returns String;

  action getInvoiceFile(
    fileName : String
  ) returns String;
}
