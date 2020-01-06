const fs = require("fs");
const os = require("os");
const { join } = require("path");
const d = require("date-fns");
const normalizePathSep = require("slash");
const uuid = require("uuid");
const actual = require("@actual-app/api");
const Papa = require("papaparse");
const { amountToInteger } = actual.utils;

const accountExtraFields = require("./accounts.json");

// Utils

function mapAccountType(type) {
  switch (type) {
    case "Cash":
    case "Checking":
      return "checking";
    case "CreditCard":
      return "credit";
    case "Savings":
      return "savings";
    case "InvestmentAccount":
      return "investment";
    case "Mortgage":
      return "mortgage";
    default:
      return "other";
  }
}

function sortByKey(arr, key) {
  return [...arr].sort((item1, item2) => {
    if (item1[key] < item2[key]) {
      return -1;
    } else if (item1[key] > item2[key]) {
      return 1;
    }
    return 0;
  });
}

function groupBy(arr, keyName) {
  return arr.reduce(function(obj, item) {
    var key = item[keyName];
    if (!obj.hasOwnProperty(key)) {
      obj[key] = [];
    }
    obj[key].push(item);
    return obj;
  }, {});
}

function _parse(value) {
  // Assumes the date comes in the format DD/MM/YYYY
  if (typeof value === "string") {
    // We don't want parsing to take local timezone into account,
    // which parsing a string does. Pass the integers manually to
    // bypass it.

    let [day, month, year] = value.split("/");
    if (day != null) {
      return new Date(parseInt(year), parseInt(month) - 1, parseInt(day));
    } else if (month != null) {
      return new Date(parseInt(year), parseInt(month) - 1, 1);
    } else {
      return new Date(parseInt(year), 0, 1);
    }
  }
  return value;
}

function monthFromDate(date) {
  return d.format(_parse(date), "yyyy-MM");
}

function getCurrentMonth() {
  return d.format(new Date(), "yyyy-MM");
}

// Importer

async function importAccounts(data, entityIdMap) {
  return Promise.all(
    data.accounts.map(async account => {
      if (!account.isTombstone) {
        const id = await actual.createAccount({
          type: mapAccountType(account.accountType),
          name: account.accountName,
          offbudget: account.onBudget ? false : true,
          closed: account.hidden ? true : false
        });
        entityIdMap.set(account.entityId, id);
      }
    })
  );
}

async function importCategories(data, entityIdMap) {
  const masterCategories = sortByKey(data.masterCategories, "sortableIndex");

  await Promise.all(
    masterCategories.map(async masterCategory => {
      if (
        masterCategory.type === "OUTFLOW" &&
        !masterCategory.isTombstone &&
        masterCategory.subCategories &&
        masterCategory.subCategories.some(cat => !cat.isTombstone) > 0
      ) {
        const id = await actual.createCategoryGroup({
          name: masterCategory.name,
          is_income: false
        });
        entityIdMap.set(masterCategory.entityId, id);

        if (masterCategory.subCategories) {
          const subCategories = sortByKey(masterCategory.subCategories, "sortableIndex");
          subCategories.reverse();

          // This can't be done in parallel because sort order depends
          // on insertion order
          for (let category of subCategories) {
            if (!category.isTombstone) {
              const id = await actual.createCategory({
                name: category.name,
                group_id: entityIdMap.get(category.masterCategoryId)
              });
              entityIdMap.set(category.entityId, id);
            }
          }
        }
      }
    })
  );
}

async function importPayees(data, entityIdMap) {
  for (let payee of data.payees) {
    if (!payee.isTombstone) {
      let id = await actual.createPayee({
        name: payee.name,
        category: entityIdMap.get(payee.autoFillCategoryId) || null,
        transfer_acct: entityIdMap.get(payee.targetAccountId) || null
      });

      // TODO: import payee rules

      entityIdMap.set(payee.entityId, id);
    }
  }
}

async function importTransactions(data, entityIdMap) {
  const categories = await actual.getCategories();
  const incomeCategoryId = categories.find(cat => cat.name === "Income").id;
  const accounts = await actual.getAccounts();
  const payees = await actual.getPayees();

  function getCategory(id) {
    if (id == null || id === "Category/__Split__") {
      return null;
    } else if (id === "Category/__ImmediateIncome__" || id === "Category/__DeferredIncome__") {
      return incomeCategoryId;
    }
    return entityIdMap.get(id);
  }

  function isOffBudget(acctId) {
    let acct = accounts.find(acct => acct.id === acctId);
    if (!acct) {
      throw new Error("Could not find account for transaction when importing");
    }
    return acct.offbudget;
  }

  // Go ahead and generate ids for all of the transactions so we can
  // reliably resolve transfers
  for (let transaction of data.transactions) {
    entityIdMap.set(transaction.entityId, uuid.v4());
  }

  let sortOrder = 1;
  let transactionsGrouped = groupBy(data.transactions, "accountId");

  await Promise.all(
    Object.keys(transactionsGrouped).map(async accountId => {
      let transactions = transactionsGrouped[accountId];

      let toImport = transactions
        .map(transaction => {
          if (transaction.isTombstone) {
            return;
          }

          let id = entityIdMap.get(transaction.entityId);
          let transferId = entityIdMap.get(transaction.transferTransactionId) || null;

          let payee_id = null;
          let payee = null;
          if (transferId) {
            payee_id = payees.find(
              p => p.transfer_acct === entityIdMap.get(transaction.targetAccountId)
            ).id;
          } else {
            payee_id = entityIdMap.get(transaction.payeeId);
          }

          let newTransaction = {
            id,
            amount: amountToInteger(transaction.amount),
            category_id: isOffBudget(entityIdMap.get(accountId))
              ? null
              : getCategory(transaction.categoryId),
            date: transaction.date,
            notes: transaction.memo || null,
            payee,
            payee_id,
            transfer_id: transferId
          };

          newTransaction.subtransactions =
            transaction.subTransactions &&
            transaction.subTransactions.map((t, i) => {
              return {
                amount: amountToInteger(t.amount),
                category_id: getCategory(t.categoryId)
              };
            });

          return newTransaction;
        })
        .filter(x => x);

      await actual.addTransactions(entityIdMap.get(accountId), toImport);
    })
  );
}

function fillInBudgets(data, categoryBudgets) {
  // YNAB only contains entries for categories that have been actually
  // budgeted. That would be fine except that we need to set the
  // "carryover" flag on each month when carrying debt across months.
  // To make sure our system has a chance to set this flag on each
  // category, make sure a budget exists for every category of every
  // month.
  const budgets = [...categoryBudgets];
  data.masterCategories.forEach(masterCategory => {
    if (masterCategory.subCategories) {
      masterCategory.subCategories.forEach(category => {
        if (!budgets.find(b => b.categoryId === category.entityId)) {
          budgets.push({
            budgeted: 0,
            categoryId: category.entityId
          });
        }
      });
    }
  });
  return budgets;
}

async function importBudgets(data, entityIdMap) {
  let budgets = sortByKey(data.monthlyBudgets, "month");
  let earliestMonth = monthFromDate(budgets[0].month);
  let currentMonth = getCurrentMonth();

  await actual.batchBudgetUpdates(async () => {
    const carryoverFlags = {};

    for (let budget of budgets) {
      await Promise.all(
        fillInBudgets(data, budget.monthlySubCategoryBudgets).map(async catBudget => {
          if (!catBudget.isTombstone) {
            let amount = amountToInteger(catBudget.budgeted);
            let catId = entityIdMap.get(catBudget.categoryId);
            let month = monthFromDate(budget.month);
            if (!catId) {
              return;
            }

            await actual.setBudgetAmount(month, catId, amount);

            if (catBudget.overspendingHandling === "AffectsBuffer") {
              // Turn off the carryover flag so it doesn't propagate
              // to future months
              carryoverFlags[catId] = false;
            } else if (catBudget.overspendingHandling === "Confined" || carryoverFlags[catId]) {
              // Overspending has switched to carryover, set the
              // flag so it propagates to future months
              carryoverFlags[catId] = true;

              await actual.setBudgetCarryover(month, catId, true);
            }
          }
        })
      );
    }
  });
}

function estimateRecentness(str) {
  // The "recentness" is the total amount of changes that this device
  // is aware of, which is estimated by summing up all of the version
  // numbers that its aware of. This works because version numbers are
  // increasing integers.
  return str.split(",").reduce((total, version) => {
    const [_, number] = version.split("-");
    return total + parseInt(number);
  }, 0);
}

function findLatestDevice(files) {
  let devices = files
    .map(deviceFile => {
      const contents = fs.readFileSync(deviceFile, "utf8");

      let data;
      try {
        data = JSON.parse(contents);
      } catch (e) {
        return null;
      }

      if (data.hasFullKnowledge) {
        return {
          deviceGUID: data.deviceGUID,
          shortName: data.shortDeviceId,
          recentness: estimateRecentness(data.knowledge)
        };
      }

      return null;
    })
    .filter(x => x);

  devices = sortByKey(devices, "recentness");
  return devices[devices.length - 1].deviceGUID;
}

async function doImport(data) {
  for (const rawAccount of data) {
    const account = toAccount(rawAccount);
    console.log(data, rawAccount, account);
    return;
    console.log(`Creating account: ${account.name}`);
    const accId = await actual.createAccount(account);
    const accTransactions = rawAccount.transactions.map(toTransaction);
    await actual.addTransactions(accId, accTransactions);
  }
}

function getBudgetName(filepath) {
  let unixFilepath = normalizePathSep(filepath);

  // Most budgets are named like "Budget~51938D82.ynab4" but sometimes
  // they are only "Budget.ynab4". We only want to grab the name
  // before the ~ if it exists.
  let m = unixFilepath.match(/([^\/\~]*)\~.*\.ynab4$/);
  if (!m) {
    m = unixFilepath.match(/([^\/]*)\.ynab4$/);
  }
  if (!m) {
    return null;
  }
  return m[1];
}

function parseRawDataFromCsv(csvFileName, dataDirPath) {
  const filePath = join(dataDirPath, csvFileName);
  const content = fs.readFileSync(filePath, "utf8");
  const [meta, empty, ...csvLines] = content.split("\n");

  const [rawName, ...rest] = meta.split(",");
  const csvContent = csvLines.join("\n");

  const { data } = Papa.parse(csvContent, { header: true });

  return { name: csvFileName.replace(/\.csv$/, ""), rawName, transactions: data };
}

function toAccount(rawAccount) {
  const { name } = rawAccount;
  const extraFields = accountExtraFields[name];
  return {
    name,
    type: "other",
    offbudget: false,
    ...extraFields
  };
}

function toTransaction(rawTransaction) {
  const date = _parse(rawTransaction.Date);
  const amount = amountToInteger(rawTransaction.Amount);
  const payee = rawTransaction["Original Description"];

  // Use general description as notes?

  return { date, amount, payee, imported_payee: payee };
}

async function createBudgetFromCsvFiles(dataDirPath, budgetName = "MyBudget") {
  const csvPaths = fs.readdirSync(dataDirPath).filter(name => name.endsWith(".csv"));

  const data = csvPaths.map(csvFileName => parseRawDataFromCsv(csvFileName, dataDirPath));

  return actual.runImport(budgetName, () => doImport(data));
}

function findBudgetsInDir(dir) {
  if (fs.existsSync(dir)) {
    return fs
      .readdirSync(dir)
      .map(file => {
        const name = getBudgetName(file);
        if (name) {
          return {
            name,
            filepath: join(dir, file)
          };
        }
      })
      .filter(x => x);
  }
  return [];
}

function findBudgets() {
  return findBudgetsInDir(join(os.homedir(), "Documents", "YNAB")).concat(
    findBudgetsInDir(join(os.homedir(), "Dropbox", "YNAB"))
  );
}

module.exports = { findBudgetsInDir, findBudgets, createBudgetFromCsvFiles };
