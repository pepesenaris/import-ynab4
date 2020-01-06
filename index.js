#!/usr/bin/env node
const { createBudgetFromCsvFiles } = require("./importer");

async function run() {
  /**
   * filepath:
   * Should be a path to a directory containing csv files exported from RBC.
   * Each csv file name will be used as the account name created to hold the transactions
   * described in the file
   * budgetName:
   * Name that will be given the new budget
   */
  let filepath = process.argv[2];
  let budgetName = process.argv[3];
  await createBudgetFromCsvFiles(filepath, budgetName);
}

run();
