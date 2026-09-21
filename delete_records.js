require('dotenv').config();
const { sql, poolPromise } = require('./src/database/connection');

async function run() {
    try {
        const pool = await poolPromise;
        const transaction = new sql.Transaction(pool);
        await transaction.begin();

        try {
            // Delete lines first
            let resLines = await transaction.request().query(`
                DELETE FROM DOME.dbo.[@XD_SMP1] 
                WHERE DocEntry IN (SELECT DocEntry FROM DOME.dbo.[@XD_OSMP] WHERE DocNum BETWEEN 129 AND 131)
            `);
            console.log("Lines deleted:", resLines.rowsAffected);

            // Delete headers
            let resHeaders = await transaction.request().query(`
                DELETE FROM DOME.dbo.[@XD_OSMP] 
                WHERE DocNum BETWEEN 129 AND 131
            `);
            console.log("Headers deleted:", resHeaders.rowsAffected);

            await transaction.commit();
            console.log("Successfully deleted sampling records 129, 130, and 131.");
        } catch (err) {
            console.error("Error during deletion:", err);
            await transaction.rollback();
        }
    } catch (e) {
        console.error("Connection error:", e);
    } finally {
        process.exit(0);
    }
}
run();
