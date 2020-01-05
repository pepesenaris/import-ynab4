#!/usr/bin/env node
const { findBudgets, importCsvFilesFromRBC } = require("./importer");

async function run() {
  let filepath = process.argv[2];
  let budgetName = process.argv[3];
  await importCsvFilesFromRBC(filepath, budgetName);
}

run();
