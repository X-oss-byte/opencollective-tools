require('../env');

const fs = require('fs');
const axios = require('axios').default;

const { Command } = require('commander');
const csvParseSync = require('csv-parse/sync'); // eslint-disable-line node/no-missing-require

const { request, gql } = require('graphql-request');

const endpoint = `${process.env.API_URL}/graphql/v2/${process.env.API_KEY}`;
const WISE_API_URL = process.env.TRANSFERWISE_API_URL || 'https://api.transferwise.com';

const expensesQuery = gql`
  query {
    expenses(account: { slug: "1kproject" }, limit: 100) {
      totalCount
      nodes {
        id
        createdAt
        status
        amount
        payee {
          id
          slug
        }
        payoutMethod {
          id
          type
          name
          data
        }
      }
    }
  }
`;

const createExpenseMutation = gql`
  mutation CreateExpense($expense: ExpenseCreateInput!, $account: AccountReferenceInput!) {
    createExpense(expense: $expense, account: $account) {
      id
    }
  }
`;

const tokenizeCard = (cardNumber) =>
  axios
    .post(`${WISE_API_URL}/v3/card`, { cardNumber })
    .then((response) => response?.data?.cardToken)
    .catch(catchException);

const sleep = (ms) => {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
};

const catchException = (e) => {
  console.log(e);
  return null;
};

async function main(argv = process.argv) {
  const program = getProgram(argv);
  const options = program.opts();
  const [inputFilename] = program.args;

  if (!options.run) {
    console.log(`This is a dry run, run the script with --run to trigger it for real.`);
  }

  const input = fs.readFileSync(inputFilename, 'utf8');

  const records = csvParseSync.parse(input, { columns: true });

  const allExpenses = await request(endpoint, expensesQuery)
    .catch(catchException)
    .then((result) => result.expenses.nodes);

  for (const record of records) {
    const email = record['EMAIL'];
    const postCode = record['POST CODE'];
    const address = record['ADDRESS'];
    const city = record['CITY'];
    const phone = record['PHONE'];
    const bankCard = record['BANK CARD'];
    const name = record['NAME'];

    const match = allExpenses.map((expense) => JSON.stringify(expense)).some((string) => string.includes(email));

    if (match) {
      console.log(`Skipping for ${email} ${!options.run ? '(dry run)' : ''}`);
      continue;
    }

    const cardToken = await tokenizeCard(bankCard);
    if (!cardToken) {
      console.warn(`Could not tokenize card for ${email} ${name}, skipping...`);
      continue;
    }

    const variables = {
      account: { slug: '1kproject' },
      expense: {
        type: 'INVOICE',
        payee: { slug: 'ukrainian-families-1k' },
        currency: 'USD',
        items: [
          {
            description: `${name} Family`,
            amount: 100000,
          },
        ],
        description: `${name} Family`,
        payoutMethod: {
          type: 'BANK_ACCOUNT',
          data: {
            type: 'CARD',
            details: {
              email: email,
              address: {
                city: city,
                country: 'UA',
                postCode: postCode,
                firstLine: address,
              },
              cardToken,
              legalType: 'PRIVATE',
            },
            currency: 'UAH',
            // country: 'UA',
            accountHolderName: name,
          },
        },
      },
    };

    console.log(`Creating Expense ${variables.expense.description} ${!options.run ? '(dry run)' : ''}`);
    // Increased Sleep time due to Tokenize Card API rate limit
    await sleep(1000);

    if (options.run) {
      const result = await request(endpoint, createExpenseMutation, variables);
      console.log(result);
      await sleep(600);
    }
  }
}

const getProgram = (argv) => {
  const program = new Command();
  program.exitOverride();
  program.showSuggestionAfterError();

  program.argument('<string>', 'Path to the CSV file to parse.');

  program.option('--run', 'Trigger import.');

  program.parse(argv);

  return program;
};

if (!module.parent) {
  main()
    .then(() => process.exit())
    .catch((e) => {
      if (e.name !== 'CommanderError') {
        console.error(e);
      }

      process.exit(1);
    });
}