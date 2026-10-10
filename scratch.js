require('dotenv').config();
const { sql, poolPromise } = require('./src/database/connection');

async function run() {
  try {
    const pool = await poolPromise;
    const res = await pool.request().query(`
      SELECT TOP 10 
        ItemCode, 
        ItemName, 
        SalPackUn, 
        SalPackQty, 
        NumInSale, 
        NumInBuy 
      FROM LDS_LIVE.dbo.OITM 
      WHERE ItemName LIKE '%50%' OR ItemName LIKE '%96%'
    `);
    console.log(res.recordset);
    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

run();
