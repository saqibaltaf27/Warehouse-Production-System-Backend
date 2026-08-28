require('dotenv').config({ path: '../.env' });
const { sql, poolPromise } = require('./database/connection');

async function getColumns() {
    try {
        const pool = await poolPromise;
        const result = await pool.request().query(`
            SELECT COLUMN_NAME, DATA_TYPE
            FROM DOME.INFORMATION_SCHEMA.COLUMNS
            WHERE TABLE_NAME = 'UserPermission'
        `);
        console.log(JSON.stringify(result.recordset, null, 2));
        process.exit(0);
    } catch (err) {
        console.error(err);
        process.exit(1);
    }
}
getColumns();
