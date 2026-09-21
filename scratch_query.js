require('dotenv').config();
const { sql, poolPromise } = require('./src/database/connection');

async function run() {
    try {
        const pool = await poolPromise;
        const result = await pool.request().query(`
            SELECT DISTINCT U_QCDecision
            FROM DOME.dbo.[@XD_OQUL]
            WHERE U_QCDecision IS NOT NULL
        `);
        console.table(result.recordset);
    } catch (e) {
        console.error(e);
    } finally {
        process.exit(0);
    }
}
run();
