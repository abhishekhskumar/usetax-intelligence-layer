namespace usetax.intelligence;

service DocumentIntelligenceService @(path: '/api/intelligence') {

  action processInvoice(
    documentId : String,
    schemaType : String enum { construction; non_construction; indexing },
    invoiceBase64 : LargeString,
    mediaType : String
  ) returns String;
}
