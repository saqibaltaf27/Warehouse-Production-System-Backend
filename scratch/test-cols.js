require('dotenv').config();
const { sql, poolPromise } = require('../src/database/connection');

async function test() {
  try {
    const pool = await poolPromise;
    const req = pool.request();
    const res = await req.query("SELECT DistNumber, MnfDate, InDate FROM LDS_LIVE.dbo.OBTN WHERE ItemCode='PK000334'");
    console.log("OBTN data:", res.recordset);
    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}
test();
