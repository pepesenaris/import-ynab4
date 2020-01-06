#!/usr/bin/env node
const { findBudgets, createBudgetFromCsvFiles } = require("./importer");

async function run() {
  let filepath = process.argv[2];
  let budgetName = process.argv[3];
  await createBudgetFromCsvFiles(filepath, budgetName);
}

run();
