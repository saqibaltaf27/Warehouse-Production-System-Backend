require('dotenv').config();
const { sql, poolPromise } = require('./src/database/connection');
async function run() {
  try {
    const pool = await poolPromise;
    const r = await pool.request().query('SELECT TOP 1 * FROM DOME.dbo.[@XD_OQCP]');
    console.log(r.recordset);
    process.exit(0);
  } catch(e) {
    console.error(e);
    process.exit(1);
  }
}
run();
