require('dotenv').config();
const path = require('path');
const { BigQuery } = require('@google-cloud/bigquery');

const client = new BigQuery({
  projectId: process.env.GOOGLE_CLOUD_PROJECT,
  keyFilename: process.env.GOOGLE_APPLICATION_CREDENTIALS
    ? path.resolve(process.cwd(), process.env.GOOGLE_APPLICATION_CREDENTIALS)
    : undefined,
});

const pool = 'CCCCIQSDILITHMM7PBSLVDT5MISSY7R26MNZXCX4H7J5JQ5FPIYOGYFS';

const query = `
SELECT
  ledger_sequence,
  closed_at,
  CAST(JSON_EXTRACT_SCALAR(val_decoded, '$.map[1].val.i128') AS NUMERIC) AS shares,
  CAST(JSON_EXTRACT_SCALAR(val_decoded, '$.map[2].val.i128') AS NUMERIC) AS tokens,
  CAST(JSON_EXTRACT_SCALAR(val_decoded, '$.map[0].val.i128') AS NUMERIC) AS q4w
FROM \`crypto-stellar.crypto_stellar.contract_data\`
WHERE contract_id = 'CAQQR5SWBXKIGZKPBZDH3KM5GQ5GUTPKB7JAFCINLZBC5WXPJKRG3IM7'
  AND JSON_EXTRACT_SCALAR(key_decoded, '$.vec[0].symbol') = 'PoolBalance'
  AND JSON_EXTRACT_SCALAR(key_decoded, '$.vec[1].address') = '${pool}'
  AND ledger_sequence BETWEEN 61330000 AND 61336050
ORDER BY ledger_sequence
`;

client
  .query({ query, location: 'US' })
  .then(([rows]) => {
    console.log(JSON.stringify(rows, null, 2));
  })
  .catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  });
