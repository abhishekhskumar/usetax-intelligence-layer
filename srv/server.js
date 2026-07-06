const cds = require('@sap/cds');

cds.on('bootstrap', (app) => {
  const express = require('express');
  app.use(express.json({ limit: '50mb' }));
  app.use(express.text({ limit: '50mb', type: ['text/*', 'application/json'] }));
  app.use(express.urlencoded({ limit: '50mb', extended: true }));
});

module.exports = cds.server;
