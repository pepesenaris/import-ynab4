#!/usr/bin/env node
const { importTransactionsFromCSV } = require("./importer");

async function run() {
  /**
   * filepath:
   * Should be a path to a CSV file exported from RBC.
   * The CSV file name will be used as the account name where the transactions will be added
   * budgetId:
   * ID of the budget used to add new transactions
   */

  let filepath = process.argv[2];
  let budgetId = process.argv[3];
  await importTransactionsFromCSV(filepath, budgetId);
}

run();
